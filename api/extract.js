// Vercel serverless function: reads a ticket screenshot with Google Gemini (free tier) and returns
// the same shape as js/parse.js. The API key stays on the server in the GEMINI_API_KEY env variable.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BASE64_CHARS = 4_000_000; // Vercel caps request bodies at 4.5 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const PROMPT = `You are reading an Indian Railways train ticket (IRCTC e-ticket, ERS PDF, booking
confirmation screenshot from IRCTC/ConfirmTkt/Paytm/etc., or an SMS screenshot).
Extract the journey details. Rules:
- Station names in UPPERCASE as printed, station codes are the short codes in brackets (e.g. "MLDT").
- "from" is where the ticket is booked from, "boarding" is the boarding station (same as from if not shown),
  "to" is the destination.
- Dates as YYYY-MM-DD, times as 24-hour HH:MM.
- travelClass like "SECOND AC (2A)" or "SLEEPER (SL)".
- For each passenger give the CURRENT status with coach/berth if shown (e.g. "CNF/B2/34/LOWER", "RAC 12", "WL 5").
- gender is "M", "F" or "T".
- Use an empty string for anything not visible. Do not guess.
- If the image is not a train ticket, set isTicket to false.`;

const str = { type: 'STRING' };
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isTicket: { type: 'BOOLEAN' },
    pnr: str, trainNo: str, trainName: str, travelClass: str,
    fromName: str, fromCode: str, boardingName: str, boardingCode: str, toName: str, toCode: str,
    depDate: str, depTime: str, arrDate: str, arrTime: str,
    passengers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: str, age: str, gender: str, status: str },
        required: ['name'],
      },
    },
  },
  required: ['isTicket', 'fromName', 'toName', 'depDate', 'passengers'],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (!process.env.GEMINI_API_KEY) return res.status(501).json({ error: 'GEMINI_API_KEY is not set' });

  const { mimeType, data } = req.body || {};
  if (!ALLOWED_TYPES.includes(mimeType) || typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'Send { mimeType, data } with a base64 image or PDF' });
  }
  if (data.length > MAX_BASE64_CHARS) return res.status(413).json({ error: 'File too large' });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.error('Gemini error', r.status, JSON.stringify(body).slice(0, 500));
      return res.status(502).json({ error: r.status === 429 ? 'Reader is busy, try again in a minute' : 'Reader failed' });
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const ticket = JSON.parse(text);
    if (!ticket.isTicket) return res.status(422).json({ error: 'This does not look like a train ticket' });
    delete ticket.isTicket;
    return res.status(200).json({ ticket });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not read the ticket' });
  }
}
