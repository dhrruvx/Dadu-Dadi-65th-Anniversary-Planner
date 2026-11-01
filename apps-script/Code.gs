/**
 * Google Apps Script backend: paste into Extensions → Apps Script of your Google Sheet.
 * 1. Run `setup` once (authorise when asked).
 * 2. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 * 3. Put the /exec URL into config.js (appsScriptUrl).
 */

const TZ = 'Asia/Kolkata';
const FOLDER_NAME = 'Anniversary travel tickets';
const NOT_BOOKED = 'Not booked yet';
const AADHAAR_FOLDER = 'Aadhaar Cards';
const NO_AADHAAR = 'Not uploaded';

// One tab per direction. Each tab's name is also its Drive subfolder and its "Journey" value.
const TABS = {
  arrival: {
    name: 'Coming to Malda',
    headers: ['Journey', 'Passenger', 'Phone', 'Train No', 'Train Name', 'Seat', 'Arrival', 'Ticket File', 'Aadhaar'],
    time: 'Arrival',
  },
  return: {
    name: 'Going from Malda',
    headers: ['Journey', 'Passenger', 'Phone', 'Train No', 'Train Name', 'Seat', 'Departure', 'Ticket File', 'Aadhaar'],
    time: 'Departure',
  },
  none: { name: NOT_BOOKED, headers: ['Passenger', 'Phone', 'Aadhaar'] },
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  ['arrival', 'return', 'none'].forEach(function (k, i) {
    const tab = TABS[k];
    const sh = ss.getSheetByName(tab.name) || ss.insertSheet(tab.name, i);
    sh.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers])
      .setFontWeight('bold').setBackground('#9a3d14').setFontColor('#fffaf3');
    sh.setFrozenRows(1);
    if (tab.time) sh.getRange('G:G').setNumberFormat('ddd dd-mmm-yyyy hh:mm');
  });

  const sum = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  sum.clear();
  const c = "'" + TABS.arrival.name + "'";
  const g = "'" + TABS.return.name + "'";
  const n = "'" + NOT_BOOKED + "'";
  sum.getRange('A1:B3').setValues([
    ['Guests coming to Malda', '=MAX(0,COUNTA(' + c + '!B:B)-1)'],
    ['Guests going from Malda', '=MAX(0,COUNTA(' + g + '!B:B)-1)'],
    ['Not booked yet', '=MAX(0,COUNTA(' + n + '!A:A)-1)'],
  ]);
  sum.getRange('A4:B4').setValues([['Arriving families with Aadhaar uploaded',
    '=IFERROR(COUNTUNIQUE(FILTER(' + c + '!C2:C,' + c + '!I2:I<>"' + NO_AADHAAR + '",' + c + '!C2:C<>"")),0)' +
    '&" of "&IFERROR(COUNTUNIQUE(FILTER(' + c + '!C2:C,' + c + '!C2:C<>"")),0)']]);
  sum.getRange('A5').setValue('Arrivals into Malda by train').setFontWeight('bold');
  sum.getRange('A6').setFormula('=IFERROR(QUERY(' + c + '!A1:H,"select G, D, E, count(B) where B is not null ' +
    'group by G, D, E order by G label G \'Arrives\', D \'Train No\', E \'Train\', count(B) \'Guests\'",1),"No arrivals yet")');
  sum.getRange('G5').setValue('Departures from Malda by train').setFontWeight('bold');
  sum.getRange('G6').setFormula('=IFERROR(QUERY(' + g + '!A1:H,"select G, D, E, count(B) where B is not null ' +
    'group by G, D, E order by G label G \'Departs\', D \'Train No\', E \'Train\', count(B) \'Guests\'",1),"No departures yet")');
  sum.getRange('A6:A300').setNumberFormat('ddd dd-mmm hh:mm');
  sum.getRange('G6:G300').setNumberFormat('ddd dd-mmm hh:mm');
  sum.setColumnWidth(1, 200);

  getFolder_(TABS.arrival.name);
  getFolder_(TABS.return.name);
  getFolder_(AADHAAR_FOLDER);
}

function doGet() {
  return json_({ ok: true, message: 'Travel collector is running' });
}

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.website) return json_({ ok: true }); // honeypot field filled → bot
    const by = clean_(p.submittedBy, 80);
    const phone = clean_(p.phone, 20).replace(/^'/, '');
    if (!by || !phone) return json_({ ok: false, error: 'Name and phone are required' });

    // Save files to Drive and build every row *before* taking the lock:
    // uploads are the slow part and don't need to wait in line.
    // `sid` identifies this submission, so an automatic retry doesn't save the same files twice.
    const sid = clean_(p.submissionId, 64);
    const aadhaarUrl = saveAadhaar_(p.aadhaar || [], by, phone, sid) || NO_AADHAAR;
    const byTab = { arrival: [], return: [], none: [] };
    if (p.notBooked || !p.tickets || !p.tickets.length) {
      byTab.none.push({ Passenger: by, Phone: text_(phone), Aadhaar: aadhaarUrl });
    } else {
      p.tickets.slice(0, 10).forEach(function (t, i) {
        const k = t.journey === 'return' ? 'return' : 'arrival';
        const tab = TABS[k];
        const fileUrl = t.file && t.file.base64
          ? once_(sid && sid + ':t' + i, function () { return saveFile_(t.file, by, t, tab.name); })
          : '';
        const time = k === 'arrival' ? when_(t.arrDate, t.arrTime) : when_(t.depDate, t.depTime);
        const people = (t.passengers || []).filter(function (x) { return x && clean_(x.name, 80); });
        (people.length ? people : [{ name: by }]).slice(0, 12).forEach(function (x) {
          const row = {
            Journey: tab.name, Passenger: clean_(x.name, 80), Phone: text_(phone),
            'Train No': text_(clean_(t.trainNo, 6)), 'Train Name': clean_(t.trainName, 60),
            Seat: clean_(x.status, 40), 'Ticket File': fileUrl, Aadhaar: aadhaarUrl,
          };
          row[tab.time] = time;
          byTab[k].push(row);
        });
      });
    }

    // Only the quick sheet writes happen one submission at a time (well under a second each).
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(120000)) return json_({ ok: false, busy: true, error: 'Busy, please try again' });
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss.getSheetByName(TABS.arrival.name)) setup();
      let rows = 0;
      ['arrival', 'return', 'none'].forEach(function (k) {
        if (byTab[k].length) rows += upsertRows_(ss, TABS[k], byTab[k], phone);
      });
      // Someone who first said "not booked yet" and now uploads tickets: drop the placeholder row.
      if (!byTab.none.length) removeRows_(ss.getSheetByName(NOT_BOOKED), function (r) { return String(r[1]) === phone; });
      // Aadhaar sent later (or with only one of the tickets) → link it on all of this family's rows.
      if (aadhaarUrl !== NO_AADHAAR) linkAadhaar_(ss, phone, aadhaarUrl);
      return json_({ ok: true, rows: rows });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, busy: true, error: 'Could not save, please try again' });
  }
}

// Writes rows to a tab in one pass. A row whose passenger + phone already exists is replaced,
// so re-submitting fixes the row instead of duplicating it; new rows are appended in a single write.
function upsertRows_(ss, tab, objs, phone) {
  const sh = ss.getSheetByName(tab.name);
  const pi = tab.headers.indexOf('Passenger');
  const fi = tab.headers.indexOf('Phone');
  const data = sh.getDataRange().getValues();
  const fresh = [];
  objs.forEach(function (obj) {
    const values = tab.headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
    const name = String(obj.Passenger).replace(/^'/, '').toUpperCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][pi]).toUpperCase() === name && String(data[i][fi]) === phone) {
        sh.getRange(i + 1, 1, 1, values.length).setValues([values]);
        return;
      }
    }
    fresh.push(values);
  });
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, tab.headers.length).setValues(fresh);
  return objs.length;
}

// Puts the family's Aadhaar folder link on every row with this phone number, in all tabs.
function linkAadhaar_(ss, phone, url) {
  ['arrival', 'return', 'none'].forEach(function (k) {
    const tab = TABS[k];
    const sh = ss.getSheetByName(tab.name);
    const fi = tab.headers.indexOf('Phone');
    const ai = tab.headers.indexOf('Aadhaar');
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][fi]) === phone && data[i][ai] !== url) sh.getRange(i + 1, ai + 1).setValue(url);
    }
  });
}

// Saves Aadhaar photos/PDFs into "Aadhaar Cards/<name> - <phone>/" and returns that folder's link.
// With no new files, returns the family's existing folder link (if they uploaded before), else ''.
function saveAadhaar_(files, by, phone, sid) {
  const digits = phone.replace(/\D/g, '').slice(-10);
  const props = PropertiesService.getScriptProperties();
  const key = 'AADHAAR_' + digits;
  let folder = null;
  const id = props.getProperty(key);
  if (id) {
    try {
      folder = DriveApp.getFolderById(id);
      if (folder.isTrashed()) folder = null;
    } catch (e) { folder = null; }
  }
  files = files.filter(function (f) { return f && f.base64; }).slice(0, 30);
  if (!files.length) return folder ? folder.getUrl() : '';
  if (!folder) {
    folder = getFolder_(AADHAAR_FOLDER).createFolder((by + ' - ' + digits).replace(/[\\/:*?"<>|']/g, ''));
    props.setProperty(key, folder.getId());
  }
  let n = 0;
  const it = folder.getFiles();
  while (it.hasNext()) { it.next(); n++; }
  files.forEach(function (f, j) {
    once_(sid && sid + ':a' + j, function () {
      const types = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
      const mime = types[f.mimeType] ? f.mimeType : 'image/jpeg';
      const name = (by + ' - Aadhaar ' + (++n)).replace(/[\\/:*?"<>|']/g, '') + types[mime];
      return folder.createFile(Utilities.newBlob(Utilities.base64Decode(f.base64), mime, name)).getUrl();
    });
  });
  return folder.getUrl();
}

// Runs `fn` once per key for 6 hours (remembering its result), so retries of the same submission
// don't create duplicate files in Drive. Without a key it just runs `fn`.
function once_(key, fn) {
  if (!key) return fn();
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit !== null) return hit;
  const result = fn();
  cache.put(key, String(result), 21600);
  return result;
}

function removeRows_(sh, test) {
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) if (test(data[i])) sh.deleteRow(i + 1);
}

// Saves the ticket into the "Coming to Malda" or "Going from Malda" folder,
// named like "Ritu Agarwal - 12524 - 2026-12-19 - PNR 2456789013.pdf".
function saveFile_(file, by, t, folderName) {
  const bytes = Utilities.base64Decode(file.base64);
  const ext = (String(file.name).match(/\.[a-z0-9]{2,4}$/i) || [''])[0];
  const parts = [by, t.trainNo, t.depDate, t.pnr ? 'PNR ' + t.pnr : ''].filter(String);
  const name = parts.join(' - ').replace(/[\\/:*?"<>|']/g, '').slice(0, 120) + ext;
  const blob = Utilities.newBlob(bytes, clean_(file.mimeType, 40) || 'application/octet-stream', name);
  return getFolder_(folderName).createFile(blob).getUrl();
}

// Returns the main tickets folder, or one of its subfolders when a name is given.
// Folder ids are remembered so renaming or moving them in Drive is fine; a deleted folder is recreated.
function getFolder_(sub) {
  const props = PropertiesService.getScriptProperties();
  const key = sub ? 'FOLDER_ID_' + sub : 'FOLDER_ID';
  const id = props.getProperty(key);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* folder deleted, make a new one */ }
  }
  const folder = sub ? getFolder_().createFolder(sub) : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty(key, folder.getId());
  return folder;
}

function when_(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '00:00';
  return Utilities.parseDate(date + ' ' + t, TZ, 'yyyy-MM-dd HH:mm');
}

// Trims, caps length and stops spreadsheet formula injection ("=", "+", "-", "@" at the start).
function clean_(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// Leading apostrophe keeps "+91…" and train numbers like "05123" as text instead of numbers.
function text_(s) {
  s = String(s || '').replace(/^'/, '');
  return s ? "'" + s : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
