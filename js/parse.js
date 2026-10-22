// Turns the text of an IRCTC e-ticket (ERS PDF, or OCR of a screenshot) into structured travel details.
// Pure functions only, so the same code runs in the browser and in `node --test`.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const CLASS_RE =
  /(FIRST AC|SECOND AC|THIRD AC(?: ECONOMY)?|AC 3 (?:TIER )?ECONOMY|SLEEPER(?: CLASS)?|AC CHAIR CAR|EXEC(?:UTIVE|\.)? CHAIR CAR|SECOND SITTING|FIRST CLASS|VISTADOME[A-Z ]*|ANUBHUTI[A-Z ]*)\s*\(\s*([0-9A-Z]{2})\s*\)/i;

// Codes in brackets that are not stations: "(ERS)", quota "(GN)", class "(2A)" etc.
const NOT_STATION = new Set(['ERS', 'GN', 'TQ', 'PT', 'LD', 'SS', 'HP', 'DF', 'FT', 'YU', 'PH', 'GST', 'HRS', 'NA']);

const STATUS_RE = /\b(CNF|RAC|RLWL|PQWL|RSWL|GNWL|TQWL|NOSB|WL|CAN|CANCELLED)\b/g;

/** Groups pdf.js text items into lines (top to bottom), separating cells with three spaces. */
export function itemsToText(items) {
  const rows = [];
  for (const it of items) {
    const str = (it.str || '').trim();
    if (!str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) rows.push((row = { y, cells: [] }));
    row.cells.push({ x, str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.str).join('   ')).join('\n');
}

/** "04-Oct-2026" / "4 Oct 2026" / "04/10/2026" → "2026-10-04" (or "" if not a date). */
export function toIsoDate(s) {
  if (!s) return '';
  let m = String(s).match(/(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]*(\d{4})/);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${pad(MONTHS[m[2].toUpperCase()])}-${pad(m[1])}`;
  m = String(s).match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function normGender(g) {
  const c = (g || '').trim().charAt(0).toUpperCase();
  return c === 'M' || c === 'F' || c === 'T' ? c : '';
}

function stationsIn(text) {
  const out = [];
  const re = /([A-Z][A-Z0-9 .'&-]*?)\s*\(\s*([A-Z]{2,5})\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[2];
    const name = m[1].replace(/^(?:BOOKED FROM|BOARDING AT|FROM|TO)\s+/i, '').trim();
    if (!NOT_STATION.has(code) && name.length > 1) out.push({ name, code });
  }
  return out;
}

function findStations(text) {
  const start = text.search(/Booked\s*from/i);
  const end = text.search(/Start\s*Date|Departure/i);
  if (start >= 0 && end > start) {
    const found = stationsIn(text.slice(start, end));
    if (found.length >= 2) return found;
  }
  // OCR text may lose the labels; take the first plausible stations before the class marker.
  const cls = text.search(CLASS_RE);
  return stationsIn(cls > 0 ? text.slice(0, cls) : text).slice(0, 3);
}

function findPassengers(text) {
  const passengers = [];
  const lineRe = /^\s*(\d{1,2})\s*[.)]?\s+([A-Za-z][A-Za-z .'-]*?)\s+(\d{1,3})\s+(MALE|FEMALE|TRANSGENDER|M|F|T)\b(.*)$/gim;
  let m;
  while ((m = lineRe.exec(text))) {
    const rest = m[5].trim();
    const starts = [...rest.matchAll(STATUS_RE)].map((s) => s.index);
    // Booking status comes first, current status second; the current one is what matters on the day.
    const status = (starts.length >= 2 ? rest.slice(starts[1]) : rest).replace(/\s+/g, ' ').trim();
    passengers.push({ name: titleCase(m[2].trim()), age: m[3], gender: normGender(m[4]), status });
  }
  return passengers;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

function findTimed(text, label) {
  const re = new RegExp(`${label}\\*?[:\\s]*(\\d{1,2}[:.]\\d{2})\\s*(?:HRS)?\\s*(\\d{1,2}[-\\s/][A-Za-z]{3}[-\\s/]\\d{4})`, 'i');
  const m = text.match(re);
  return m ? { date: toIsoDate(m[2]), time: m[1].replace('.', ':').padStart(5, '0') } : { date: '', time: '' };
}

/** Parses ticket text. Fields that could not be found are returned as empty strings. */
export function parseTicketText(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const stations = findStations(text);
  const from = stations[0] || { name: '', code: '' };
  const to = stations[stations.length >= 3 ? 2 : 1] || { name: '', code: '' };
  const boarding = stations.length >= 3 ? stations[1] : from;

  const afterPnr = text.slice(Math.max(0, text.search(/PNR/i)));
  const pnr = (afterPnr.match(/\b(\d{10})\b/) || text.match(/\b(\d{10})\b/) || [])[1] || '';

  let trainNo = '';
  let trainName = '';
  let travelClass = '';
  const train = text.match(/\b(\d{5})\s*\/\s*([^\n]*)/);
  if (train) {
    trainNo = train[1];
    let rest = train[2];
    const cls = rest.match(CLASS_RE);
    if (cls) rest = rest.slice(0, cls.index);
    trainName = rest.split(/\s{2,}/)[0].trim();
  }
  const cls = text.match(CLASS_RE);
  if (cls) travelClass = `${cls[1].toUpperCase()} (${cls[2].toUpperCase()})`;

  const dep = findTimed(text, 'Departure');
  const arr = findTimed(text, 'Arrival');
  if (!dep.date) {
    const start = text.match(/Start\s*Date\*?[:\s]*(\d{1,2}[-\s/][A-Za-z]{3}[-\s/]\d{4})/i);
    if (start) dep.date = toIsoDate(start[1]);
  }

  return {
    pnr,
    trainNo,
    trainName,
    travelClass,
    fromName: from.name,
    fromCode: from.code,
    boardingName: boarding.name,
    boardingCode: boarding.code,
    toName: to.name,
    toCode: to.code,
    depDate: dep.date,
    depTime: dep.time,
    arrDate: arr.date,
    arrTime: arr.time,
    passengers: findPassengers(text),
  };
}

/** True when enough was read to be worth showing (rather than falling back to another reader). */
export function looksComplete(t) {
  return Boolean(t && t.fromCode && t.toCode && t.depDate);
}

/** Guesses whether a ticket is travel to the venue or back home. */
export function guessJourney(t, venueMatchers) {
  const hit = (name, code) =>
    venueMatchers.some((v) => (name || '').toUpperCase().includes(v) || (code || '').toUpperCase() === v);
  if (hit(t.toName, t.toCode)) return 'arrival';
  if (hit(t.fromName, t.fromCode) || hit(t.boardingName, t.boardingCode)) return 'return';
  return 'arrival';
}
