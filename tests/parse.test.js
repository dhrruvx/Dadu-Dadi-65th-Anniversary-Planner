import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsToText, parseTicketText, guessJourney, toIsoDate, looksComplete } from '../js/parse.js';

// pdf.js text items laid out like a real IRCTC ERS (names are made up).
const at = (x, y, str) => ({ str, transform: [1, 0, 0, 1, x, y] });
const ERS_ITEMS = [
  at(188, 804, 'Electronic Reservation Slip (ERS)'), at(354, 804, '-Normal User'),
  at(77, 714, 'Booked from'), at(483, 714, 'To'),
  at(49, 690, 'NEW DELHI (NDLS)'), at(240, 690, 'DELHI (DLI)'), at(435, 690, 'MALDA TOWN (MLDT)'),
  at(47, 673, 'Start Date* 19-Dec-2026'), at(223, 673, 'Departure* 16:20 19-Dec-2026'), at(423, 673, 'Arrival* 09:05 20-Dec-2026'),
  at(75, 650, 'PNR'), at(261, 650, 'Train No./Name'), at(499, 650, 'Class'),
  at(51, 632, '2456789013'), at(243, 632, '12524/NDLS JPG SF EXP'), at(465, 632, 'THIRD AC (3A)'),
  at(71, 615, 'Quota'), at(56, 598, 'GENERAL (GN)'), at(282, 598, '1300 KM'),
  at(31, 545, '1.'), at(47, 545, 'ASHA GUPTA'), at(167, 545, '58'), at(218, 545, 'F'),
  at(268, 545, 'CNF/B3/21/LOWER'), at(422, 545, 'CNF/B3/21/LOWER'),
  at(31, 530, '2.'), at(47, 530, 'RAJ KUMAR GUPTA'), at(167, 530, '61'), at(218, 530, 'M'),
  at(268, 530, 'WL/12'), at(422, 530, 'RAC/B3/22'),
  at(39, 475, 'Acronyms:'), at(117, 475, 'RLWL: REMOTE LOCATION WAITLIST'),
];

test('reads an IRCTC ERS PDF layout', () => {
  const t = parseTicketText(itemsToText(ERS_ITEMS));
  assert.deepEqual(
    { ...t, passengers: undefined },
    {
      pnr: '2456789013', trainNo: '12524', trainName: 'NDLS JPG SF EXP', travelClass: 'THIRD AC (3A)',
      fromName: 'NEW DELHI', fromCode: 'NDLS', boardingName: 'DELHI', boardingCode: 'DLI',
      toName: 'MALDA TOWN', toCode: 'MLDT',
      depDate: '2026-12-19', depTime: '16:20', arrDate: '2026-12-20', arrTime: '09:05', passengers: undefined,
    },
  );
  assert.deepEqual(t.passengers, [
    { name: 'Asha Gupta', age: '58', gender: 'F', status: 'CNF/B3/21/LOWER' },
    { name: 'Raj Kumar Gupta', age: '61', gender: 'M', status: 'RAC/B3/22' },
  ]);
  assert.equal(guessJourney(t, ['MALDA', 'MLDT']), 'arrival');
  assert.ok(looksComplete(t));
});

test('reads OCR-style text with single spaces', () => {
  const flat = itemsToText(ERS_ITEMS).replace(/ {2,}/g, ' ');
  const t = parseTicketText(flat);
  assert.equal(t.trainName, 'NDLS JPG SF EXP');
  assert.equal(t.toCode, 'MLDT');
  assert.equal(t.passengers.length, 2);
});

test('return journey and missing boarding station', () => {
  const t = parseTicketText(
    'Booked from To\nMALDA TOWN (MLDT) HOWRAH JN (HWH)\nDeparture* 7:40 23-Dec-2026 Arrival* 14:55 23-Dec-2026\n' +
    'PNR 6612345678\n13154/GOUR EXPRESS SLEEPER (SL)\n1. MEERA SHAH 34 F CNF/S4/40/MIDDLE CNF/S4/40/MIDDLE',
  );
  assert.equal(t.boardingCode, 'MLDT');
  assert.equal(t.trainName, 'GOUR EXPRESS');
  assert.equal(t.travelClass, 'SLEEPER (SL)');
  assert.equal(t.depTime, '07:40');
  assert.equal(guessJourney(t, ['MALDA', 'MLDT']), 'return');
});

test('date formats', () => {
  assert.equal(toIsoDate('04-Oct-2026'), '2026-10-04');
  assert.equal(toIsoDate('4 October 2026'), '2026-10-04');
  assert.equal(toIsoDate('21/12/2026'), '2026-12-21');
  assert.equal(toIsoDate('nope'), '');
});

test('garbage text gives empty fields, not a crash', () => {
  const t = parseTicketText('hello world');
  assert.equal(looksComplete(t), false);
  assert.deepEqual(t.passengers, []);
});
