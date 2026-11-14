// End-to-end server tests. Run: npm test   (starts its own server on a spare port with temp folders)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 3200 + Math.floor(Math.random() * 500), BASE = 'http://localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fidara-test-'));
let proc, out = '';
const post = (p, body, headers) => fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
const reg = (o) => post('/api/register', Object.assign({ name: 'Maria', email: 'maria@x.com', dog: 'Buddy', age: '3 to 6 months', receipt: 'A123', zip: '01234', consent: true, termsVersion: 't1' }, o));
const review = (o, headers) => { const fd = new FormData(); fd.append('video', new Blob([Buffer.alloc(2000, 1)], { type: 'video/mp4' }), 'v.mp4');
  Object.entries(Object.assign({ lesson: 3, name: 'Maria', email: 'maria@x.com', dog: 'Buddy', note: 'hi' }, o)).forEach(([k, v]) => fd.append(k, v));
  return fetch(BASE + '/api/review', { method: 'POST', body: fd, headers }); };
const auth = (pw) => ({ Authorization: 'Basic ' + Buffer.from('team:' + pw).toString('base64') });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT, LINK_SECRET: 'test-secret-123', REVIEW_TO: 'team@example.com', PUBLIC_URL: BASE, TRUST_PROXY: '0',
    UPLOAD_DIR: path.join(TMP, 'up'), DATA_DIR: path.join(TMP, 'data'), ADMIN_KEY: 'pw123', ESTOY_AQUI_TO: 'ea@example.com', SIGNUP_NOTIFY_TO: 'notify@example.com', SMTP_HOST: '' }) });
  proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) return; } catch (e) {} await wait(100); }
  throw new Error('server did not start:\n' + out);
});
after(() => { proc && proc.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

let token;
test('register: new customer gets a token and a welcome email with the personal link', async () => {
  const r = await reg(), j = await r.json();
  assert.equal(r.status, 200); assert.ok(j.token); token = j.token;
  await wait(200);
  assert.ok(out.includes('/#/back/' + token), 'welcome email contains the personal link');
  assert.ok(out.includes('ea@example.com'), 'Estoy Aqui notification sent'); assert.ok(out.includes('notify@example.com'), 'team sign-up notification sent');
});
test('register: invalid forms are rejected', async () => {
  for (const bad of [{ name: '' }, { email: 'nope' }, { age: 'old' }, { zip: '12' }, { receipt: 'a' }, { dog: '' }, { consent: false }, { consent: 'yes' }, { consent: undefined }]) assert.equal((await reg(bad)).status, 400);
});
test('register: same email again (even +tag, capitals) adds nothing and gives no token', async () => {
  const before = out.length;
  for (const email of ['maria@x.com', 'Maria+2@X.com']) { const j = await (await reg({ email })).json(); assert.equal(j.existing, true); assert.equal(j.token, undefined); }
  await wait(200); assert.ok(!out.slice(before).includes('mail not sent'), 'no second email');
  const lines = fs.readFileSync(path.join(TMP, 'data', 'registrations.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});
test('restore: the personal link brings back details; tampered links are refused', async () => {
  const j = await (await post('/api/restore', { token })).json();
  assert.equal(j.reg.name, 'Maria'); assert.equal(j.reg.zip, '01234'); assert.deepEqual(j.done, []);
  const bad = [token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), 'bWFyaWFAeC5jb20.' + '0'.repeat(32), 'garbage', ''];
  for (const t of bad) assert.equal((await post('/api/restore', { token: t })).status, 404);
});
test('progress: saved on the server and restored on another phone', async () => {
  assert.equal((await post('/api/progress', { token, done: [3, 1, 1, 99, 'x', 2] })).status, 200);
  assert.deepEqual((await (await post('/api/restore', { token })).json()).done, [1, 2, 3]);
  assert.equal((await post('/api/progress', { token: 'bad', done: [1] })).status, 404);
});
test('review: invalid attempts do not use up the hourly quota', async () => {
  for (let i = 0; i < 7; i++) assert.equal((await review({ email: 'bad' })).status, 400);
});
test('review: first works, second (other email, same account) is blocked', async () => {
  const r = await review({}, { 'X-Fidara-Token': token }); assert.equal(r.status, 200);
  assert.equal((await review({ email: 'maria+2@x.com' })).status, 409);
  assert.equal((await review({ email: 'other@x.com' }, { 'X-Fidara-Token': token })).status, 409);
  assert.equal((await (await post('/api/restore', { token })).json()).reviewUsed, 3);
});
test('review: rule still holds after the video files are deleted (retention)', async () => {
  const up = path.join(TMP, 'up'); fs.readdirSync(up).forEach((f) => fs.unlinkSync(path.join(up, f)));
  assert.equal((await review({})).status, 409);
});
test('private video link: works with signature, 404 when tampered', async () => {
  const r2 = await review({ email: 'new@x.com', name: '=cmd()' }); const { id } = await r2.json();
  const sig = out.match(new RegExp('/v/' + id + '/([a-f0-9]{32})'))[1];
  assert.equal((await fetch(BASE + '/v/' + id + '/' + sig)).status, 200);
  assert.equal((await fetch(BASE + '/v/' + id + '/' + '0'.repeat(32))).status, 404);
});
test('admin: needs the password; CSV is safe against formulas', async () => {
  assert.equal((await fetch(BASE + '/admin/registrations.csv')).status, 401);
  assert.equal((await fetch(BASE + '/admin/registrations.csv', { headers: auth('wrong') })).status, 401);
  await reg({ name: '=1+1', email: 'f@x.com', marketing: true });
  const t = await (await fetch(BASE + '/admin/registrations.csv', { headers: auth('pw123') })).text();
  assert.ok(t.includes('"Maria"') && t.includes('"\'=1+1"'), t);
  const rv = await (await fetch(BASE + '/admin/reviews.csv', { headers: auth('pw123') })).text();
  assert.ok(rv.includes('"\'=cmd()"') && rv.includes('/v/'));
});
const join = (o) => post('/api/join', Object.assign({ name: 'Lena', email: 'lena@x.com', phone: '+1 305 555 0123', dog: 'Rex', channels: ['email', 'whatsapp', 'bogus'], consent: true, termsVersion: 't1' }, o));
test('join (QR form): needs consent, saves the lead once, only known channels', async () => {
  assert.equal((await fetch(BASE + '/join')).status, 200);
  for (const bad of [{ consent: false }, { consent: undefined }, { name: '' }, { email: 'x' }, { phone: 'abc' }, { phone: '', channels: ['whatsapp'] }]) assert.equal((await join(bad)).status, 400);
  assert.equal((await join()).status, 200);
  assert.equal((await (await join({ email: 'Lena+2@x.com' })).json()).existing, true);
  await wait(200); assert.ok(out.includes('notify@example.com'));
  const csv = await (await fetch(BASE + '/admin/leads.csv', { headers: auth('pw123') })).text();
  assert.ok(csv.includes('"lena@x.com"') && csv.includes('"email, whatsapp"') && !csv.includes('bogus'), csv);
  assert.equal(csv.split('lena@x.com').length, 2, 'one row only');
  assert.equal((await fetch(BASE + '/admin/leads.csv')).status, 401);
});
test('static: app, manifest, service worker and headers', async () => {
  for (const p of ['/', '/lessons.js', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/qr.html', '/studio.html']) assert.equal((await fetch(BASE + p)).status, 200, p);
  const h = (await fetch(BASE + '/')).headers; assert.equal(h.get('x-content-type-options'), 'nosniff');
  const man = await (await fetch(BASE + '/manifest.webmanifest')).json(); assert.equal(man.display, 'standalone'); assert.ok(man.icons.length >= 3);
});
test('admin dashboard: login cookie, data API, replied toggle, logout', async () => {
  const page = await fetch(BASE + '/admin'); assert.equal(page.status, 200); assert.ok((await page.text()).includes('Fidara admin'));
  const no = await fetch(BASE + '/admin/api/data'); assert.equal(no.status, 401); assert.equal(no.headers.get('www-authenticate'), null, 'no browser popup for the dashboard');
  assert.equal((await post('/admin/login', { key: 'nope' })).status, 401);
  const ok = await post('/admin/login', { key: 'pw123' }); assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie'); assert.ok(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\/admin/.test(sc));
  const H = { Cookie: sc.split(';')[0] };
  const d = await (await fetch(BASE + '/admin/api/data', { headers: H })).json();
  assert.ok(d.customers.length >= 1 && d.reviews.length >= 1); assert.ok(d.reviews[0].link.includes('/v/')); assert.equal(d.system.reviewTo, 'team@example.com');
  assert.equal(d.customers.find((c) => c.email === 'maria@x.com').done.length, 3);
  assert.equal(d.customers.find((c) => c.email === 'maria@x.com').marketingOptIn, false, 'marketing box unticked = no');
  assert.equal(d.customers.find((c) => c.email === 'f@x.com').marketingOptIn, true, 'marketing box ticked = yes');
  assert.ok(d.customers.every((c) => c.consentAt && c.termsVersion), 'every sign-up has its consent recorded');
  const id = d.reviews[0].id;
  assert.equal((await post('/admin/api/review-status', { id, status: 'replied' }, H)).status, 200);
  assert.equal((await post('/admin/api/review-status', { id, status: 'bogus' }, H)).status, 400);
  assert.equal((await post('/admin/api/review-status', { id: '0'.repeat(24), status: 'new' }, H)).status, 404);
  assert.equal((await post('/admin/api/review-status', { id, status: 'new' })).status, 401, 'needs sign-in');
  assert.equal((await (await fetch(BASE + '/admin/api/data', { headers: H })).json()).reviews.find((r) => r.id === id).status, 'replied');
  assert.equal((await fetch(BASE + '/admin/registrations.csv', { headers: H })).status, 200, 'CSV works with the login cookie');
  assert.equal((await fetch(BASE + '/admin/api/data', { headers: { Cookie: H.Cookie.slice(0, -1) + 'x' } })).status, 401, 'tampered cookie');
  const out = await post('/admin/logout', {}); assert.ok(/Max-Age=0/.test(out.headers.get('set-cookie')));
});
