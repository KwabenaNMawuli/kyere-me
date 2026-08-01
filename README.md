# Kyere Me — PDF to Quiz

Upload a PDF (lecture notes, a textbook chapter, study material) and get an
interactive multiple-choice quiz generated from it by Google's Gemini API.
Take the quiz in the browser and review your score with explanations.

It's a static site — plain HTML/CSS/JS, no build step, no backend. PDF text
extraction happens in the browser with [pdf.js](https://mozilla.github.io/pdf.js/),
and the extracted text is sent straight from the browser to the Gemini API.
Your API key is stored only in `localStorage` on your own machine.

## Running it locally

Any static file server works, e.g.:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`. Opening `index.html` directly via
`file://` will **not** work — `fetch`/PDF parsing require a server origin.

## Getting a Gemini API key

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Sign in with a Google account and click "Create API key"
3. Paste it into the app via the "Add API key" button (top right)

The free tier allows 15 requests/minute — plenty for personal use. The key
never leaves your browser except in direct calls to Google's API.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch".
4. Pick the branch (e.g. `main`) and folder `/ (root)`, then **Save**.
5. GitHub will publish the site at `https://<username>.github.io/<repo>/`
   within a minute or two.

No secrets to configure — each visitor supplies their own Gemini API key
in the browser.

## Project structure

```
index.html          App shell — upload, loading, quiz, and results screens
css/style.css        Styling, design tokens, light/dark mode
js/app.js            PDF extraction, Gemini API calls, quiz logic
vendor/pdf.min.js    pdf.js (text extraction) — third-party, vendored
vendor/pdf.worker.min.js
```

## Notes

- Max upload size is 10MB.
- Scanned/image-only PDFs without a text layer will show an error asking
  for a text-based PDF (no OCR is performed).
- Quiz generation uses `gemini-2.5-flash` with structured JSON output, so
  responses are always parsed as data, never free-form markdown.
