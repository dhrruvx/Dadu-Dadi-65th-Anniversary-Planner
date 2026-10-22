import { itemsToText, parseTicketText, looksComplete, guessJourney } from './parse.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // original PDF kept in Drive only if it is this small

const cfg = window.APP_CONFIG || {};
const $ = (s, el = document) => el.querySelector(s);
const form = $('#form');
const ticketsEl = $('#tickets');
const tickets = [];
let nextId = 1;

// ---------- reading files ----------

let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ||= import(`${PDFJS}pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

let tesseractPromise;
function tesseract() {
  tesseractPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('OCR failed to load'));
    document.head.append(s);
  });
  return tesseractPromise;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

async function imageToJpeg(file, maxSide = 1800) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToJpeg(canvas);
}

async function readPdf(file) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const text = itemsToText((await page.getTextContent()).items);
  const data = parseTicketText(text);
  if (looksComplete(data)) return { data, source: 'pdf' };

  // Scanned or unusual PDF: turn page 1 into an image and read it like a screenshot.
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return readImage(await canvasToJpeg(canvas));
}

async function readImage(jpeg, onProgress) {
  try {
    const res = await fetch(cfg.extractUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: 'image/jpeg', data: await blobToBase64(jpeg) }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ticket) return { data: normaliseAi(body.ticket), source: 'ai' };
    if (res.status === 422) return { data: null, source: 'ai', message: body.error };
    console.warn('AI reader unavailable:', res.status, body.error);
  } catch (err) {
    console.warn('AI reader unavailable:', err);
  }
  // Free fallback that runs entirely in the browser.
  onProgress?.('Reading the image on your phone, this can take a few seconds…');
  const T = await tesseract();
  const { data } = await T.recognize(jpeg, 'eng');
  return { data: parseTicketText(data.text), source: 'ocr' };
}

function normaliseAi(t) {
  const iso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : '');
  const hm = (s) => (/^\d{1,2}:\d{2}$/.test(s || '') ? s.padStart(5, '0') : '');
  return {
    ...t,
    depDate: iso(t.depDate), arrDate: iso(t.arrDate),
    depTime: hm(t.depTime), arrTime: hm(t.arrTime),
    boardingName: t.boardingName || t.fromName, boardingCode: t.boardingCode || t.fromCode,
    passengers: (t.passengers || []).map((p) => ({ ...p, gender: (p.gender || '').charAt(0).toUpperCase() })),
  };
}

async function processFile(ticket, file) {
  const status = (msg, kind = 'busy') => setStatus(ticket, msg, kind);
  try {
    if (file.size > MAX_FILE_BYTES) throw new UserError('This file is over 10 MB. Please upload a smaller screenshot or the PDF.');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    let result;
    if (isPdf) {
      status('Reading your PDF…');
      result = await readPdf(file);
      if (file.size <= MAX_UPLOAD_BYTES) {
        ticket.file = { name: file.name, mimeType: 'application/pdf', base64: await blobToBase64(file) };
      }
    } else {
      status('Reading your screenshot…');
      let jpeg;
      try {
        jpeg = await imageToJpeg(file);
      } catch {
        throw new UserError('This image format can’t be opened here. Please upload a JPG/PNG screenshot or the PDF.');
      }
      ticket.file = { name: file.name.replace(/\.\w+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: await blobToBase64(jpeg) };
      result = await readImage(jpeg, status);
    }
    ticket.source = result.source;

    if (!result.data || !(result.data.fromName || result.data.pnr || result.data.passengers?.length)) {
      throw new UserError(result.message || 'We couldn’t read this ticket. Please type the details below.');
    }
    fill(ticket, result.data);
    const full = looksComplete(result.data) && result.data.passengers.length;
    if (result.source === 'ocr' || !full) status('We filled in what we could read. Please check and complete every field.', 'warn');
    else status('Details read from your ticket. Please give them a quick check.', 'ok');
  } catch (err) {
    console.error(err);
    ticket.source = 'manual';
    if (!ticket.el.querySelector('.pax-row')) addPassenger(ticket);
    status(err instanceof UserError ? err.message : 'Something went wrong reading this file. Please type the details below.', 'warn');
  } finally {
    ticket.el.classList.remove('loading');
  }
}

class UserError extends Error {}

// ---------- ticket cards ----------

function setStatus(ticket, msg, kind) {
  const el = $('.status', ticket.el);
  el.textContent = msg;
  el.className = `status ${kind || ''}`;
}

function addTicket({ loading } = {}) {
  const el = $('#ticket-tpl').content.firstElementChild.cloneNode(true);
  const ticket = { id: nextId++, el, file: null, source: 'manual' };
  el.querySelectorAll('.seg input').forEach((r) => (r.name = `journey-${ticket.id}`));
  $('.remove', el).addEventListener('click', () => {
    tickets.splice(tickets.indexOf(ticket), 1);
    el.remove();
  });
  $('.add-pax', el).addEventListener('click', () => $('input', addPassenger(ticket)).focus());
  if (loading) el.classList.add('loading');
  // A second ticket is most likely the return journey.
  if (tickets.length) el.querySelector('.seg input[value="return"]').checked = true;
  ticketsEl.append(el);
  tickets.push(ticket);
  return ticket;
}

function addPassenger(ticket, p = {}) {
  const row = $('#pax-tpl').content.firstElementChild.cloneNode(true);
  for (const k of ['name', 'age', 'gender', 'status']) row.querySelector(`[data-p="${k}"]`).value = p[k] || '';
  $('button', row).addEventListener('click', () => row.remove());
  $('.pax-rows', ticket.el).append(row);
  return row;
}

const withCode = (name, code) => (name && code ? `${name} (${code})` : name || code || '');

function fill(ticket, d) {
  const set = (k, v) => (ticket.el.querySelector(`[data-k="${k}"]`).value = v || '');
  for (const k of ['pnr', 'trainNo', 'trainName', 'travelClass', 'depDate', 'depTime', 'arrDate', 'arrTime']) set(k, d[k]);
  set('fromName', withCode(d.fromName, d.fromCode));
  set('toName', withCode(d.toName, d.toCode));
  const boarding = withCode(d.boardingName, d.boardingCode);
  set('boardingName', boarding === withCode(d.fromName, d.fromCode) ? '' : boarding);
  $('.pax-rows', ticket.el).replaceChildren();
  (d.passengers?.length ? d.passengers : [{}]).forEach((p) => addPassenger(ticket, p));
  const journey = guessJourney(d, cfg.venueMatchers || []);
  ticket.el.querySelector(`.seg input[value="${journey}"]`).checked = true;
}

function splitStation(v) {
  const m = (v || '').trim().match(/^(.*?)\s*\(\s*([A-Za-z0-9]{2,5})\s*\)\s*$/);
  return m ? { name: m[1].toUpperCase(), code: m[2].toUpperCase() } : { name: (v || '').trim().toUpperCase(), code: '' };
}

function readTicket(ticket) {
  const get = (k) => ticket.el.querySelector(`[data-k="${k}"]`).value.trim();
  const from = splitStation(get('fromName'));
  const to = splitStation(get('toName'));
  const boarding = get('boardingName') ? splitStation(get('boardingName')) : from;
  return {
    journey: ticket.el.querySelector('.seg input:checked').value,
    pnr: get('pnr'), trainNo: get('trainNo'), trainName: get('trainName').toUpperCase(), travelClass: get('travelClass'),
    fromName: from.name, fromCode: from.code,
    boardingName: boarding.name, boardingCode: boarding.code,
    toName: to.name, toCode: to.code,
    depDate: get('depDate'), depTime: get('depTime'), arrDate: get('arrDate'), arrTime: get('arrTime'),
    passengers: [...ticket.el.querySelectorAll('.pax-row')]
      .map((r) => Object.fromEntries(['name', 'age', 'gender', 'status'].map((k) => [k, r.querySelector(`[data-p="${k}"]`).value.trim()])))
      .filter((p) => p.name),
    source: ticket.source,
    file: ticket.file,
  };
}

// ---------- form ----------

function handleFiles(files) {
  $('#notBooked').checked = false;
  form.classList.remove('disabled');
  for (const file of files) {
    const ticket = addTicket({ loading: true });
    processFile(ticket, file);
  }
}

$('#file').addEventListener('change', (e) => {
  handleFiles([...e.target.files]);
  e.target.value = '';
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFiles([...e.dataTransfer.files]);
});

$('#manual').addEventListener('click', () => {
  const t = addTicket();
  addPassenger(t, { name: form.submittedBy.value.trim() });
  setStatus(t, 'Fill in your journey below.', '');
  $('[data-k="pnr"]', t.el).focus();
});

$('#notBooked').addEventListener('change', (e) => form.classList.toggle('disabled', e.target.checked));

function showError(msg, focusEl) {
  const el = $('#error');
  el.textContent = msg;
  el.hidden = !msg;
  if (focusEl) focusEl.focus();
  else if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function invalid(el, bad) {
  el.setAttribute('aria-invalid', bad ? 'true' : 'false');
  return bad;
}

form.addEventListener('input', (e) => e.target.removeAttribute?.('aria-invalid'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const name = form.submittedBy;
  const phone = form.phone;
  if (invalid(name, name.value.trim().length < 2)) return showError('Please enter your name.', name);
  if (invalid(phone, phone.value.replace(/\D/g, '').length < 10)) return showError('Please enter a valid phone number.', phone);

  const notBooked = $('#notBooked').checked;
  if (!notBooked) {
    if (!tickets.length) return showError('Please upload your ticket, type the details, or tick “I haven’t booked yet”.');
    if (tickets.some((t) => t.el.classList.contains('loading'))) return showError('Still reading your ticket. Please wait a moment.');
    for (const t of tickets) {
      const need = ['fromName', 'toName', 'depDate'].map((k) => t.el.querySelector(`[data-k="${k}"]`));
      const missing = need.filter((el) => invalid(el, !el.value.trim()));
      if (missing.length) return showError('Please fill in From, To and the departure date for each ticket.', missing[0]);
      if (!readTicket(t).passengers.length) {
        return showError('Please add at least one passenger name for each ticket.', $('.pax-row input', t.el) || $('.add-pax', t.el));
      }
    }
  }

  if (!cfg.appsScriptUrl) return showError('This form isn’t connected to the sheet yet (appsScriptUrl in config.js is empty).');

  const payload = {
    submittedBy: name.value.trim(),
    phone: phone.value.trim(),
    notBooked,
    website: form.website.value,
    tickets: notBooked ? [] : tickets.map(readTicket),
  };

  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await saveWithRetry(payload, (n) => (btn.textContent = `Busy, retrying (${n})…`));
    form.hidden = true;
    $('#done').hidden = false;
    $('#done').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    console.error(err);
    showError(err instanceof UserError ? err.message : 'Could not send your details. Please check your internet and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send travel details';
  }
});

// Retries when the sheet is busy (many guests saving at once) or the network blips.
// Re-sending is safe: the script updates a passenger's existing row instead of adding a duplicate.
async function saveWithRetry(payload, onRetry, attempts = 4) {
  const body = JSON.stringify(payload);
  for (let i = 1; ; i++) {
    let result;
    try {
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
      const res = await fetch(cfg.appsScriptUrl, { method: 'POST', body });
      result = await res.json();
    } catch (err) {
      result = { ok: false, busy: true, error: String(err) };
    }
    if (result.ok) return result;
    if (!result.busy) throw new UserError(result.error || 'Could not save your details.');
    if (i >= attempts) throw new Error(result.error || 'Still busy');
    onRetry(i);
    await new Promise((r) => setTimeout(r, 2000 * i + Math.random() * 2000));
  }
}

$('#again').addEventListener('click', () => {
  form.reset();
  tickets.splice(0).forEach((t) => t.el.remove());
  form.classList.remove('disabled');
  form.hidden = false;
  $('#done').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
