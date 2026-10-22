/**
 * Google Apps Script backend: paste into Extensions → Apps Script of your Google Sheet.
 * 1. Run `setup` once (authorise when asked).
 * 2. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 * 3. Put the /exec URL into config.js (appsScriptUrl).
 */

const TZ = 'Asia/Kolkata';
const FOLDER_NAME = 'Anniversary travel tickets';
const NOT_BOOKED = 'Not booked yet';

// One tab per direction. Each tab's name is also its Drive subfolder and its "Journey" value.
const TABS = {
  arrival: {
    name: 'Coming to Malda',
    headers: ['Journey', 'Passenger', 'Phone', 'Train No', 'Train Name', 'Seat', 'Arrival', 'Ticket File'],
    time: 'Arrival',
  },
  return: {
    name: 'Going from Malda',
    headers: ['Journey', 'Passenger', 'Phone', 'Train No', 'Train Name', 'Seat', 'Departure', 'Ticket File'],
    time: 'Departure',
  },
  none: { name: NOT_BOOKED, headers: ['Passenger', 'Phone'] },
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

    // Build every row first, and save ticket files to Drive *before* taking the lock:
    // uploads are the slow part and don't need to wait in line.
    const byTab = { arrival: [], return: [], none: [] };
    if (p.notBooked || !p.tickets || !p.tickets.length) {
      byTab.none.push({ Passenger: by, Phone: text_(phone) });
    } else {
      p.tickets.slice(0, 10).forEach(function (t) {
        const k = t.journey === 'return' ? 'return' : 'arrival';
        const tab = TABS[k];
        const fileUrl = t.file && t.file.base64 ? saveFile_(t.file, by, t, tab.name) : '';
        const time = k === 'arrival' ? when_(t.arrDate, t.arrTime) : when_(t.depDate, t.depTime);
        const people = (t.passengers || []).filter(function (x) { return x && clean_(x.name, 80); });
        (people.length ? people : [{ name: by }]).slice(0, 12).forEach(function (x) {
          const row = {
            Journey: tab.name, Passenger: clean_(x.name, 80), Phone: text_(phone),
            'Train No': text_(clean_(t.trainNo, 6)), 'Train Name': clean_(t.trainName, 60),
            Seat: clean_(x.status, 40), 'Ticket File': fileUrl,
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
