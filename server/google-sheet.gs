/* Fidara -> Google Sheet receiver.
   SETUP (2 minutes)
   1. Create a Google Sheet. Extensions > Apps Script. Paste this whole file over the default code.
   2. Change SECRET below to a long random string (same value goes in server/.env as SHEETS_SECRET).
   3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
   4. Copy the Web app URL into server/.env as SHEETS_WEBHOOK_URL. Restart the server.
   Three tabs are created automatically: Registrations, QR sign-ups and Reviews. After changing this file: Deploy > Manage deployments > edit > New version. */
const SECRET = 'change-me-to-a-long-random-string';

const TABS = {
  registration: { name: 'Registrations', head: ['Registered at', 'Name', 'Email', 'Puppy', 'Puppy age', 'Receipt number', 'ZIP', 'Estoy Aqui opt-in', 'Agreed to terms at', 'Terms version', 'Offers and news opt-in'] },
  lead: { name: 'QR sign-ups', head: ['Signed up at', 'Name', 'Email', 'WhatsApp / phone', 'Puppy', 'OK to contact by', 'Agreed to terms at', 'Terms version'] },
  review: { name: 'Reviews', head: ['Received at', 'Course', 'Name', 'Email', 'Puppy', 'Receipt number', 'What is hard', 'Seconds', 'MB', 'Private video link'] }
};

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    const tab = TABS[d.kind];
    if (d.secret !== SECRET || !tab || !Array.isArray(d.row)) return out({ ok: false });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(tab.name);
    if (!sh) sh = ss.insertSheet(tab.name);
    if (sh.getLastRow() === 0) { sh.appendRow(tab.head); sh.setFrozenRows(1); sh.getRange(1, 1, 1, tab.head.length).setFontWeight('bold'); }
    // Text format keeps ZIPs like 01234 intact; the leading quote stops customer text being run as a formula.
    const row = d.row.map(function (v) { v = String(v == null ? '' : v); return /^[=+\-@]/.test(v) ? "'" + v : v; });
    const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
    rng.setNumberFormat('@'); rng.setValues([row]);
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
