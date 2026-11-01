# Travel Extractor

A one-page site for guests to share their train tickets for the anniversary celebration in Malda.
Guests upload an IRCTC PDF or a screenshot, check the details that were filled in, and submit.
Every passenger becomes a row in a Google Sheet. Everything runs on free tiers.

```
Browser (Vercel static site)
  ├─ IRCTC PDF  → read in the browser with pdf.js → js/parse.js           (no server, always free)
  ├─ Screenshot → /api/extract (Vercel function → Gemini free tier)
  │               └─ if that fails → Tesseract OCR in the browser → js/parse.js
  └─ Submit     → Google Apps Script web app → "Travel" sheet + original file saved in Google Drive
```

## Setup (about 15 minutes)

### 1. Google Sheet and Apps Script
1. Create a new Google Sheet, e.g. "Anniversary – Guest Travel".
2. Open **Extensions → Apps Script**, delete the sample code and paste in everything from `apps-script/Code.gs`.
3. Pick `setup` in the function dropdown and click **Run**. Approve the permissions (it's your own script, so click
   *Advanced → Go to project* if Google warns you). This creates the **Coming to Malda**, **Going from Malda**, **Not booked yet** and **Summary** tabs and a
   Drive folder called *Anniversary travel tickets* with three subfolders: **Coming to Malda**, **Going from Malda**
   and **Aadhaar Cards**. Each ticket is saved into the subfolder for its direction; each family's Aadhaar photos go
   into their own folder inside **Aadhaar Cards**.
4. Click **Deploy → New deployment → Select type: Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the Web app URL (it ends in `/exec`) and paste it into `config.js` as `appsScriptUrl`.

> If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version**.
> Creating a new deployment gives you a different URL.

### 2. Gemini API key (for screenshots)
1. Go to https://aistudio.google.com/apikey and create a free API key.
2. You'll add it to Vercel in the next step. **Don't put it in `config.js`**, because that file is public.

Without a key, screenshots are still read by the in-browser OCR, but less accurately. PDFs don't need the key.

### 3. Deploy on Vercel
1. Push this folder to a GitHub repo and import it at https://vercel.com/new (Framework preset: **Other**).
2. In **Settings → Environment Variables**, add:
   - `GEMINI_API_KEY`: your key
   - `ALLOWED_ORIGIN` *(optional)*: your site URL, e.g. `https://dadu-dadi-travel.vercel.app`, so only your site can use the reader
   - `GEMINI_MODEL` *(optional)*: defaults to `gemini-2.5-flash`
3. Redeploy, open the site and submit a test entry. A row should appear in the sheet.

## The sheet
`setup` creates these tabs, with the headers in row 1:

| Tab | Columns |
|---|---|
| **Coming to Malda** | Journey · Passenger · Phone · Train No · Train Name · Seat · Arrival · Ticket File · Aadhaar |
| **Going from Malda** | Journey · Passenger · Phone · Train No · Train Name · Seat · Departure · Ticket File · Aadhaar |
| **Not booked yet** | Passenger · Phone · Aadhaar |
| **Summary** | Headcounts, plus guests per arriving and departing train |

- Every passenger on a ticket gets their own row. "Ticket File" links to the file in the matching Drive subfolder.
- "Aadhaar" links to the family's folder in **Aadhaar Cards** (or says "Not uploaded"). Aadhaar sent in a later
  submission is linked on all of that family's rows. Aadhaar photos are never sent to Gemini.
- Re-submitting the same passenger from the same phone number updates their row instead of adding a duplicate.
- To get an Excel file, use **File → Download → Microsoft Excel (.xlsx)**.

## Local development
```bash
npm run dev
```
Then open http://localhost:5180. Locally `/api/extract` doesn't exist, so screenshots use the OCR fallback.
Use `vercel dev` if you want to test the Gemini path.

```bash
npm test
```
The parser tests use a made-up ticket, so no real passenger data goes into the repo.

## Privacy
Tickets include names, ages and PNRs. The sheet and Drive folder are private to you, so share them only with the organisers.
The page has `noindex` so search engines don't list it. Keep the **Aadhaar Cards** folder private (never "anyone with the link") and delete the Drive folder after the event.
