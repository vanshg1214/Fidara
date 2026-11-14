// Fidara app server.
// 1. Serves the customer app (../public): this is the address the QR code points to.
// 2. Registration: saves the sign-up, emails the customer a personal "way back in" link,
//    keeps their progress so any phone can pick up where they left off.
// 3. Receives review videos (up to 5 minutes) at POST /api/review, stores them,
//    emails the review team a private link, and emails the customer a receipt.
// 4. Password-protected CSV exports for the team at /admin/*.csv.
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
try { require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }); } catch (e) {}

let {
  SITE_ORIGIN = '', PUBLIC_URL = 'http://localhost:3000', PORT = 3000,
  REVIEW_TO = '', LINK_SECRET = '', UPLOAD_DIR = './uploads', RETENTION_DAYS = '90', TRUST_PROXY = '1',
  SMTP_HOST = '', SMTP_PORT = 587, SMTP_USER = '', SMTP_PASS = '', MAIL_FROM = 'Fidara <no-reply@localhost>',
  REVIEWS_PER_BOX = '1', DATA_DIR = './data', SHEETS_WEBHOOK_URL = '', SHEETS_SECRET = '',
  ESTOY_AQUI_TO = '', SIGNUP_NOTIFY_TO = '', ADMIN_KEY = '', NODE_ENV = ''
} = process.env;
const MAX_REVIEWS = Math.max(1, parseInt(REVIEWS_PER_BOX, 10) || 1);
const BASE_URL = PUBLIC_URL.replace(/\/$/, '');
// Same person = same email, ignoring capitals, spaces and a +tag (maria+2@x.com counts as maria@x.com).
const emailKey = (s) => String(s || '').trim().toLowerCase().replace(/\+[^@]*@/, '@');

const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

if (isServerless) {
  const os = require('os');
  UPLOAD_DIR = path.join(os.tmpdir(), 'fidara-uploads');
  DATA_DIR = path.join(os.tmpdir(), 'fidara-data');
}

if (!LINK_SECRET || /^change-me/.test(LINK_SECRET)) {
  console.warn('[warn] Set LINK_SECRET in environment variables to a long random string. Using fallback.');
  LINK_SECRET = 'b791ffaeedb4ec4396fa9a13f689e71814648c6493d258e89dc65a9dfd340556';
}
if (!REVIEW_TO) {
  console.warn('[warn] REVIEW_TO is not set. Using fallback.');
  REVIEW_TO = 'review@verdecasabrands.example';
}
if (NODE_ENV === 'production' && /localhost|example/.test(PUBLIC_URL)) console.warn('[warn] PUBLIC_URL is still a placeholder. Customer emails will link to the wrong address.');
if (NODE_ENV === 'production' && !SMTP_HOST) console.warn('[warn] SMTP_HOST is empty. No email is being sent.');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const LESSONS = ['Name recognition', 'Sit', 'Down', 'Come', 'Stay', 'Leave it', 'Loose leash', 'Crate & settle', 'Gentle handling', 'First trick: Spin'];
const AGES = ['Under 3 months', '3 to 6 months', '6 to 12 months', 'Over 12 months'];
const MAX_BYTES = 300 * 1024 * 1024; // 5 min from the app is ~45 MB; phone-camera files can be much larger
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const mailer = SMTP_HOST
  ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, secure: +SMTP_PORT === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined })
  : nodemailer.createTransport({ jsonTransport: true }); // testing: prints instead of sending
async function mail(opts) {
  const info = await mailer.sendMail(Object.assign({ from: MAIL_FROM }, opts));
  if (!SMTP_HOST) console.log('[mail not sent, SMTP_HOST empty]', info.message);
}
const mailSafe = (opts) => mail(opts).catch((e) => console.error('[mail] failed:', e.message));

const sign = (id) => crypto.createHmac('sha256', LINK_SECRET).update(id).digest('hex').slice(0, 32);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const isVideo = (f) => /^video\//.test(f.mimetype) || /\.(mp4|mov|m4v|webm)$/i.test(f.originalname || '');
const extFor = (f) => (/webm/.test(f.mimetype) || /\.webm$/i.test(f.originalname || '') ? '.webm' : /quicktime|\.mov$/i.test(f.mimetype + (f.originalname || '')) ? '.mov' : '.mp4');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---------- customers: sign-up, progress and review count, keyed by emailKey ----------
   One small JSON file (written atomically). Fine for a product box; move to a database if volume grows. */
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
let customers = {};
try { customers = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')); } catch (e) {}
function saveCustomers() {
  try {
    const tmp = CUSTOMERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(customers)); fs.renameSync(tmp, CUSTOMERS_FILE);
  } catch (e) {
    console.error('Failed to save customers:', e.message);
  }
}
// The personal link: the emailKey plus a signature. Opening it proves who you are, so keep it private.
const makeToken = (key) => Buffer.from(key).toString('base64url') + '.' + sign('u:' + key);
function readToken(t) {
  const m = String(t || '').match(/^([A-Za-z0-9_-]{1,300})\.([a-f0-9]{32})$/); if (!m) return null;
  const key = Buffer.from(m[1], 'base64url').toString();
  return safeEq(m[2], sign('u:' + key)) ? key : null;
}
const publicReg = (r) => ({ name: r.name, email: r.email, dog: r.dog, age: r.age, receipt: r.receipt, zip: r.zip, estoyAqui: r.estoyAqui, at: r.at, consentAt: r.consentAt, termsVersion: r.termsVersion, marketingOptIn: !!r.marketingOptIn });
// Reviews already sent by this email. Takes the larger of the saved records and a permanent counter,
// so the "one review per box" rule still holds after the videos are deleted by the retention sweep.
function reviewsUsed(key) {
  if (!key) return 0;
  let n = 0;
  try { fs.readdirSync(UPLOAD_DIR).forEach((f) => { if (!/\.json$/.test(f)) return; try { if (emailKey(JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8')).email) === key) n++; } catch (e) {} }); } catch (e) {}
  return Math.max(n, (customers[key] && customers[key].reviews) || 0);
}

const app = express();
if (TRUST_PROXY !== '0') app.set('trust proxy', +TRUST_PROXY || TRUST_PROXY); // real visitor IP behind Render/Railway/Fly
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()' });
  next();
});

// CORS only matters if the app is hosted on a DIFFERENT site than this server.
app.use('/api', (req, res, next) => {
  if (SITE_ORIGIN) { res.set('Access-Control-Allow-Origin', SITE_ORIGIN); res.set('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type, X-Fidara-Token'); }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory rate limit per IP per hour. check() blocks when full; hit() records one use.
// Callers hit() only on success (or on a failed token), so a typo never uses up someone's quota.
const makeLimit = (max, msg) => {
  const hits = new Map();
  const recent = (ip) => { const arr = (hits.get(ip) || []).filter((t) => Date.now() - t < 3600e3); if (arr.length) hits.set(ip, arr); else hits.delete(ip); return arr; };
  return {
    check: (req, res, next) => (recent(req.ip).length >= max ? res.status(429).json({ error: msg }) : next()),
    hit: (req) => { const a = recent(req.ip); a.push(Date.now()); hits.set(req.ip, a); }
  };
};
const reviewLimit = makeLimit(5, 'Too many videos. Try again later.');
const regLimit = makeLimit(20, 'Too many sign-ups. Try again later.');
const badToken = makeLimit(30, 'Too many attempts. Try again later.');

// Mirror a row to the Google Sheet (see google-sheet.gs). Fire and forget: the local files stay the source of truth.
function toSheet(kind, row) {
  if (!SHEETS_WEBHOOK_URL) return;
  fetch(SHEETS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: SHEETS_SECRET, kind, row }), signal: AbortSignal.timeout(15000) })
    .then((r) => { if (!r.ok) console.error('[sheet] HTTP', r.status); })
    .catch((e) => console.error('[sheet] failed:', e.message));
}

app.get('/health', (req, res) => res.json({ ok: true }));

const emailShell = (body) => '<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12261D;line-height:1.5">' + body +
  '<p style="color:#55705F;font-size:13px;margin-top:28px">Fidara, a Verde Casa Brands company</p></div>';

// Registration form. New email: saved, mirrored, personal link emailed. Known email: nothing is repeated.
app.post('/api/register', regLimit.check, express.json({ limit: '8kb' }), (req, res) => {
  const b = req.body || {};
  const r = { name: clean(b.name, 100), email: clean(b.email, 200), dog: clean(b.dog, 100), age: clean(b.age, 40), receipt: clean(b.receipt, 60), zip: clean(b.zip, 5) };
  if (!r.name || !EMAIL_RE.test(r.email) || !r.dog || !AGES.includes(r.age) || r.receipt.length < 3 || !/^\d{5}$/.test(r.zip) || b.consent !== true) return res.status(400).json({ error: 'Please check the form.' });
  const key = emailKey(r.email), prev = customers[key];
  // Already registered: no second row, no second email, and no token (it would hand the account to anyone who knows the email).
  if (prev && prev.reg) return res.json({ ok: true, existing: true });
  const rec = Object.assign({ at: new Date().toISOString() }, r, { estoyAqui: b.estoyAqui !== false, consentAt: new Date().toISOString(), termsVersion: clean(b.termsVersion, 40), marketingOptIn: b.marketing === true });
  customers[key] = Object.assign(prev || {}, { reg: rec, done: [], reviews: (prev && prev.reviews) || 0, reviewUsed: (prev && prev.reviewUsed) || 0 });
  saveCustomers(); regLimit.hit(req);
  fs.appendFile(path.join(DATA_DIR, 'registrations.jsonl'), JSON.stringify(rec) + '\n', (e) => { if (e) console.error(e); });
  toSheet('registration', [rec.at, rec.name, rec.email, rec.dog, rec.age, rec.receipt, rec.zip, rec.estoyAqui ? 'yes' : 'no', rec.consentAt, rec.termsVersion, rec.marketingOptIn ? 'yes' : 'no']);
  const token = makeToken(key), link = BASE_URL + '/#/back/' + token;
  mailSafe({
    to: rec.email, subject: 'Your Fidara courses: keep this link',
    html: emailShell('<h2 style="margin:0 0 8px">Welcome, ' + esc(rec.name) + '!</h2><p>' + esc(rec.dog) + '’s 10 courses are open. Use this personal link to come back any time, on any phone:</p>' +
      '<p style="margin:22px 0"><a href="' + link + '" style="background:#FFC93C;color:#0F3325;padding:14px 26px;border-radius:999px;font-weight:700;text-decoration:none;display:inline-block">Open my Fidara courses</a></p>' +
      '<p style="color:#55705F;font-size:14px">It restores your details and progress. Keep it private: anyone with this link can open your courses.</p>')
  });
  if (ESTOY_AQUI_TO && rec.estoyAqui) mailSafe({
    to: ESTOY_AQUI_TO, subject: 'New Fidara registration for Estoy Aquí',
    html: '<p>New Estoy Aquí membership sign-up from a Fidara box:</p><p>' + esc(rec.name) + ' &lt;' + esc(rec.email) + '&gt;<br>ZIP ' + esc(rec.zip) + '<br>Puppy: ' + esc(rec.dog) + ' (' + esc(rec.age) + ')<br>Registered ' + esc(rec.at) + '</p>'
  });
  if (SIGNUP_NOTIFY_TO) mailSafe({
    to: SIGNUP_NOTIFY_TO, subject: 'New Fidara sign-up: ' + rec.name + ' (' + rec.dog + ')',
    html: '<p><b>' + esc(rec.name) + '</b> &lt;' + esc(rec.email) + '&gt; just registered.</p><p>Puppy: ' + esc(rec.dog) + ' (' + esc(rec.age) + ')<br>ZIP: ' + esc(rec.zip) + '<br>Receipt: ' + esc(rec.receipt) + '<br>Estoy Aquí: ' + (rec.estoyAqui ? 'yes' : 'no') + '<br>Agreed to terms: ' + esc(rec.consentAt) + ' (version ' + esc(rec.termsVersion || '-') + ')<br>Offers and news by email: ' + (rec.marketingOptIn ? 'yes' : 'no') + '</p>'
  });
  res.json({ ok: true, token });
});

// QR landing form (/join): a lead with contact permission. Saved to leads.jsonl and the "Leads" tab of the sheet.
// Separate from the course registration above, which still asks for the receipt, ZIP and puppy age.
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');
const CHANNELS = ['email', 'whatsapp', 'social'];
const leadKeys = new Set();
try { fs.readFileSync(LEADS_FILE, 'utf8').split('\n').forEach((l) => { try { leadKeys.add(emailKey(JSON.parse(l).email)); } catch (e) {} }); } catch (e) {}
const readLeads = () => { try { return fs.readFileSync(LEADS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const leadRow = (r) => [r.at, r.name, r.email, r.phone, r.dog, r.channels.join(', '), r.consentAt, r.termsVersion];
const LEAD_HEAD = ['Signed up at', 'Name', 'Email', 'WhatsApp / phone', 'Puppy', 'OK to contact by', 'Agreed to terms at', 'Terms version'];
app.post('/api/join', regLimit.check, express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const channels = CHANNELS.filter((c) => Array.isArray(b.channels) && b.channels.includes(c));
  const r = { name: clean(b.name, 100), email: clean(b.email, 200), phone: clean(b.phone, 25), dog: clean(b.dog, 100), channels };
  if (!r.name || !EMAIL_RE.test(r.email) || b.consent !== true || (r.phone && !/^\+?[\d\s().-]{7,25}$/.test(r.phone)) || (channels.includes('whatsapp') && !r.phone))
    return res.status(400).json({ error: 'Please check the form.' });
  regLimit.hit(req);
  const key = emailKey(r.email);
  if (leadKeys.has(key)) return res.json({ ok: true, existing: true });
  leadKeys.add(key);
  const rec = Object.assign({ at: new Date().toISOString() }, r, { consentAt: new Date().toISOString(), termsVersion: clean(b.termsVersion, 40) });
  fs.appendFile(LEADS_FILE, JSON.stringify(rec) + '\n', (e) => { if (e) console.error(e); });
  toSheet('lead', leadRow(rec));
  if (SIGNUP_NOTIFY_TO) mailSafe({
    to: SIGNUP_NOTIFY_TO, subject: 'New Fidara QR sign-up: ' + rec.name,
    html: '<p><b>' + esc(rec.name) + '</b> &lt;' + esc(rec.email) + '&gt; scanned the QR code.</p><p>WhatsApp / phone: ' + esc(rec.phone || '-') + '<br>Puppy: ' + esc(rec.dog || '-') + '<br>OK to contact by: ' + esc(rec.channels.join(', ') || 'nothing ticked') + '<br>Agreed to terms: ' + esc(rec.consentAt) + ' (version ' + esc(rec.termsVersion || '-') + ')</p>'
  });
  res.json({ ok: true });
});
app.get('/join', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const candidateJoinFiles = [
    path.join(__dirname, '..', 'public', 'join.html'),
    path.join(__dirname, 'public', 'join.html'),
    path.join(process.cwd(), 'public', 'join.html')
  ];
  const joinFile = candidateJoinFiles.find((f) => fs.existsSync(f));
  if (joinFile) return res.sendFile(joinFile);
  res.status(404).send('Join page not found');
});

// Opening the personal link: hand back the customer's details and progress.
app.post('/api/restore', badToken.check, express.json({ limit: '4kb' }), (req, res) => {
  const key = readToken(req.body && req.body.token), c = key && customers[key];
  if (!c || !c.reg) { badToken.hit(req); return res.status(404).json({ error: 'Link not recognised.' }); }
  res.json({ ok: true, reg: publicReg(c.reg), done: c.done || [], reviewUsed: c.reviewUsed || 0 });
});

// Progress (which courses are ticked) so another phone can pick it up.
app.post('/api/progress', badToken.check, express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {}, key = readToken(b.token), c = key && customers[key];
  if (!c || !c.reg) { badToken.hit(req); return res.status(404).json({ error: 'Link not recognised.' }); }
  c.done = [...new Set((Array.isArray(b.done) ? b.done : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10))].sort((x, y) => x - y);
  saveCustomers(); res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + extFor(file)) }),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => (isVideo(file) ? cb(null, true) : cb(new Error('not a video')))
});

app.post('/api/review', reviewLimit.check, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video received.' });
    const b = req.body || {};
    const email = clean(b.email, 200);
    if (!EMAIL_RE.test(email)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Invalid email.' }); }
    // One video review per customer. Counted by the email typed AND by the account (personal link), so a second email does not help.
    const rkey = emailKey(email), akey = readToken(req.headers['x-fidara-token']);
    const keys = [...new Set([rkey, akey && customers[akey] ? akey : null].filter(Boolean))];
    if (keys.some((k) => reviewsUsed(k) >= MAX_REVIEWS)) { fs.unlink(req.file.path, () => {}); return res.status(409).json({ error: 'Review already used for this email.' }); }
    const n = Math.min(10, Math.max(1, parseInt(b.lesson, 10) || 1));
    const rec = { id: path.basename(req.file.filename, path.extname(req.file.filename)), file: req.file.filename, lesson: n, lessonName: LESSONS[n - 1],
      name: clean(b.name, 100), email, dog: clean(b.dog, 100), note: clean(b.note, 1000), receipt: clean(b.receipt, 60),
      seconds: parseInt(b.duration, 10) || null, bytes: req.file.size, at: new Date().toISOString(), status: 'new' };
    // Everything from the check above to here is synchronous, so two uploads cannot both slip through.
    fs.writeFileSync(path.join(UPLOAD_DIR, rec.id + '.json'), JSON.stringify(rec, null, 2));
    keys.forEach((k) => { const c = customers[k] || (customers[k] = {}); c.reviews = (c.reviews || 0) + 1; c.reviewUsed = n; });
    saveCustomers(); reviewLimit.hit(req);

    const link = BASE_URL + '/v/' + rec.id + '/' + sign(rec.id);
    toSheet('review', [rec.at, rec.lesson + '. ' + rec.lessonName, rec.name, rec.email, rec.dog, rec.receipt, rec.note, rec.seconds || '', (rec.bytes / 1048576).toFixed(1), link]);
    const len = rec.seconds ? Math.floor(rec.seconds / 60) + ':' + String(rec.seconds % 60).padStart(2, '0') + ', ' : '';
    // The video is safely stored by now, so a mail problem must not tell the customer the upload failed.
    await mailSafe({
      to: REVIEW_TO, replyTo: email,
      subject: 'Review request: course ' + rec.lesson + '. ' + rec.lessonName + ' (' + (rec.dog || 'dog') + ')',
      html: '<p><b>Course ' + rec.lesson + ': ' + esc(rec.lessonName) + '</b></p>' +
        '<p>Customer: ' + esc(rec.name) + ' &lt;' + esc(rec.email) + '&gt;<br>Dog: ' + esc(rec.dog) + '<br>Receipt: ' + esc(rec.receipt || '-') +
        '<br>What is hard: ' + esc(rec.note || '(not said)') + '</p>' +
        '<p><a href="' + link + '">Watch the video</a> (' + len + (rec.bytes / 1048576).toFixed(1) + ' MB)</p>' +
        '<p>Reply to this email to send the review. It goes straight to the customer.</p>'
    });
    await mailSafe({
      to: email,
      subject: 'We got your Fidara training video',
      html: emailShell('<p>Hi ' + esc(rec.name || 'there') + ',</p><p>Thanks for sending your video for course ' + rec.lesson + ' (' + esc(rec.lessonName) + '). Charlotte will review it and email you what to adjust.</p>')
    });
    res.json({ ok: true, id: rec.id });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Could not save the video.' });
  }
});

// Private link for the review team. The signature makes the address impossible to guess.
app.get('/v/:id/:sig', (req, res) => {
  const { id, sig } = req.params;
  if (!/^[a-f0-9]{24}$/.test(id) || !/^[a-f0-9]{32}$/.test(sig) || !safeEq(sig, sign(id))) return res.sendStatus(404);
  let rec; try { rec = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, id + '.json'), 'utf8')); } catch (e) { return res.sendStatus(404); }
  res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex');
  if (req.query.raw) return res.sendFile(path.resolve(UPLOAD_DIR, rec.file));
  res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Review</title>' +
    '<body style="font-family:system-ui;max-width:760px;margin:20px auto;padding:0 16px"><h2>Course ' + rec.lesson + ': ' + esc(rec.lessonName) + '</h2>' +
    '<p>' + esc(rec.name) + ' (' + esc(rec.email) + ') with ' + esc(rec.dog) + '<br>' + esc(rec.note) + '</p>' +
    '<video controls playsinline style="width:100%;background:#000" src="?raw=1"></video>' +
    '<p><a href="?raw=1" download>Download video</a></p></body>');
});

/* ---------- team exports: open /admin/registrations.csv, any username, password = ADMIN_KEY ---------- */
// Two ways in: the dashboard's login form (a 12-hour cookie, only sent to /admin) or HTTP Basic auth (for quick CSV downloads).
const adminHash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keyOk = (pass) => crypto.timingSafeEqual(adminHash(pass), adminHash(ADMIN_KEY));
const COOKIE = 'fidara_admin';
const cookieOk = (req) => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)fidara_admin=(\d+)\.([a-f0-9]{32})/); return !!m && +m[1] > Date.now() && safeEq(m[2], sign('admin:' + m[1])); };
const basicOk = (req) => { const m = (req.headers.authorization || '').match(/^Basic (.+)$/i); return !!m && keyOk(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':')); };
function admin(req, res, next) {
  if (!ADMIN_KEY) return res.sendStatus(404);
  if (cookieOk(req) || basicOk(req)) { res.set('Cache-Control', 'no-store'); return next(); }
  res.set('WWW-Authenticate', 'Basic realm="Fidara admin"'); res.sendStatus(401);
}
function adminApi(req, res, next) { // same check, but a plain 401 so the dashboard shows its own login instead of the browser prompt
  if (!ADMIN_KEY) return res.sendStatus(404);
  if (cookieOk(req) || basicOk(req)) { res.set('Cache-Control', 'no-store'); return next(); }
  res.status(401).json({ error: 'Sign in required.' });
}
const adminLimit = makeLimit(10, 'Too many attempts. Try again later.');
const candidateAdminFiles = [
  path.join(__dirname, 'admin.html'),
  path.join(__dirname, 'server', 'admin.html'),
  path.join(process.cwd(), 'server', 'admin.html'),
  path.join(process.cwd(), 'admin.html')
];
const adminFile = candidateAdminFiles.find((f) => fs.existsSync(f)) || path.join(__dirname, 'admin.html');

app.get('/admin', (req, res) => {
  if (!ADMIN_KEY) return res.sendStatus(404);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  res.sendFile(adminFile);
});
app.post('/admin/login', adminLimit.check, express.json({ limit: '1kb' }), (req, res) => {
  if (!ADMIN_KEY) return res.sendStatus(404);
  if (!keyOk((req.body || {}).key || '')) { adminLimit.hit(req); return res.status(401).json({ error: 'Wrong password.' }); }
  const exp = Date.now() + 12 * 3600e3;
  res.set('Set-Cookie', COOKIE + '=' + exp + '.' + sign('admin:' + exp) + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200' + (req.secure ? '; Secure' : ''));
  res.json({ ok: true });
});
app.post('/admin/logout', (req, res) => { res.set('Set-Cookie', COOKIE + '=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0'); res.json({ ok: true }); });

// Everything the dashboard shows, in one call (the data is small: a product box, not a big platform).
function readReviews() {
  const out = [];
  fs.readdirSync(UPLOAD_DIR).forEach((f) => {
    if (!/\.json$/.test(f)) return;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8'));
      out.push({ id: r.id, at: r.at, lesson: r.lesson, lessonName: r.lessonName, name: r.name, email: r.email, key: emailKey(r.email), dog: r.dog, receipt: r.receipt, note: r.note,
        seconds: r.seconds, bytes: r.bytes, status: r.status || 'new', available: fs.existsSync(path.join(UPLOAD_DIR, r.file)), link: BASE_URL + '/v/' + r.id + '/' + sign(r.id) });
    } catch (e) {}
  });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
app.get('/admin/api/data', adminApi, (req, res) => {
  const list = Object.entries(customers).filter(([, c]) => c.reg).map(([key, c]) => Object.assign({ key }, publicReg(c.reg), { done: c.done || [], reviewUsed: c.reviewUsed || 0 }));
  res.json({ now: new Date().toISOString(), customers: list, reviews: readReviews(),
    system: { publicUrl: BASE_URL, email: !!SMTP_HOST, reviewTo: REVIEW_TO, sheet: !!SHEETS_WEBHOOK_URL, estoyAquiEmail: !!ESTOY_AQUI_TO, retentionDays: +RETENTION_DAYS || 90, reviewsPerBox: MAX_REVIEWS } });
});
// Mark a review as answered (or reopen it) so the team can see what is still waiting for Charlotte.
app.post('/admin/api/review-status', adminApi, express.json({ limit: '1kb' }), (req, res) => {
  const { id, status } = req.body || {};
  if (!/^[a-f0-9]{24}$/.test(String(id)) || !['new', 'replied'].includes(status)) return res.status(400).json({ error: 'Bad request.' });
  const p = path.join(UPLOAD_DIR, id + '.json'); let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return res.status(404).json({ error: 'Not found.' }); }
  r.status = status; fs.writeFileSync(p, JSON.stringify(r, null, 2)); res.json({ ok: true });
});
// Quote every cell; a leading = + - @ would be run as a formula by Excel/Sheets, so it gets a quote in front.
const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const toCsv = (head, rows) => '﻿' + [head].concat(rows).map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
function sendCsv(res, name, head, rows) { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"' }); res.send(toCsv(head, rows)); }
app.get('/admin/registrations.csv', admin, (req, res) => {
  const rows = Object.values(customers).filter((c) => c.reg).sort((a, b) => a.reg.at.localeCompare(b.reg.at))
    .map((c) => [c.reg.at, c.reg.name, c.reg.email, c.reg.dog, c.reg.age, c.reg.receipt, c.reg.zip, c.reg.estoyAqui ? 'yes' : 'no', c.reg.consentAt || '', c.reg.termsVersion || '', c.reg.marketingOptIn ? 'yes' : 'no', (c.done || []).length, c.reviewUsed || '']);
  sendCsv(res, 'fidara-registrations.csv', ['Registered at', 'Name', 'Email', 'Puppy', 'Puppy age', 'Receipt number', 'ZIP', 'Estoy Aqui opt-in', 'Agreed to terms at', 'Terms version', 'Offers and news opt-in', 'Courses done', 'Review sent for course'], rows);
});
app.get('/admin/leads.csv', admin, (req, res) => sendCsv(res, 'fidara-leads.csv', LEAD_HEAD, readLeads().map(leadRow)));
app.get('/admin/reviews.csv', admin, (req, res) => {
  const rows = [];
  fs.readdirSync(UPLOAD_DIR).forEach((f) => { if (!/\.json$/.test(f)) return; try { const r = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8')); rows.push(r); } catch (e) {} });
  rows.sort((a, b) => a.at.localeCompare(b.at));
  sendCsv(res, 'fidara-reviews.csv', ['Received at', 'Course', 'Name', 'Email', 'Puppy', 'Receipt number', 'What is hard', 'Seconds', 'MB', 'Private video link'],
    rows.map((r) => [r.at, r.lesson + '. ' + r.lessonName, r.name, r.email, r.dog, r.receipt, r.note, r.seconds || '', (r.bytes / 1048576).toFixed(1), BASE_URL + '/v/' + r.id + '/' + sign(r.id)]));
});

// The customer app (index.html, qr.html, media/). Long cache for media, short for pages.
const candidatePublicDirs = [
  path.join(__dirname, '..', 'public'),
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public')
];
const resolvedPublicDir = candidatePublicDirs.find((d) => fs.existsSync(d));

if (resolvedPublicDir) {
  app.use(express.static(resolvedPublicDir, {
    setHeaders: (res, p) => res.set('Cache-Control', /\/(media|fonts)\//.test(p) ? 'public, max-age=604800' : 'no-cache')
  }));
}

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Video too large.' });
  if (err) return res.status(400).json({ error: String(err.message || err) });
  next();
});

// Retention: delete videos older than RETENTION_DAYS (checked every 6 hours). Only touches UPLOAD_DIR.
function sweep() {
  try {
    const cutoff = Date.now() - (+RETENTION_DAYS || 90) * 864e5;
    fs.readdir(UPLOAD_DIR, (e, files) => { if (e || !files) return; files.forEach((f) => { const p = path.join(UPLOAD_DIR, f); fs.stat(p, (e2, s) => { if (!e2 && s.mtimeMs < cutoff) fs.unlink(p, () => {}); }); }); });
  } catch (e) {}
}
if (!isServerless) {
  sweep(); setInterval(sweep, 6 * 3600e3).unref();
}

module.exports = app;

if (!isServerless && require.main === module) {
  const server = app.listen(PORT, () => console.log('Fidara app on ' + PORT));
  server.requestTimeout = 15 * 60 * 1000; // slow phone uploads of 5-minute videos
}
