# Bismillah PDF Editor

Mark edits **once** on a template PDF, apply them at the same position across dozens of similar
PDFs (acceptance letters, invoices, certificates — anything where only the numbers/names change),
then download the results individually or as a ZIP. Everything runs locally in your browser —
no file ever leaves your machine.

![stack](https://img.shields.io/badge/React-TypeScript-blue) ![pdf](https://img.shields.io/badge/pdf.js%20%2B%20pdf--lib-local-success)

## Features

- **Batch upload** — drop 60+ PDFs at once; layout badges (`✓` / `⚠ layout`) flag files whose
  page size or page count differs from the template
- **Replace text** — click any word or value; only the contiguous text run is selected
- **Draw box** — drag out a rectangle, then **move it** (drag) or **resize it** (corner handle)
  before committing; text is centered inside the box
- **Place box** — click to drop a square, drag it anywhere, resize as needed
- **Add text** — click anywhere to overlay new text
- **Movable edits** — every committed edit box on the page can be dragged to a new position
- **Styling** — font size, bold, left/center/right alignment, background color; multi-line text
  wraps automatically
- **Unicode** — Korean/CJK text is embedded automatically (Malgun Gothic), Latin uses Helvetica
- **Templates** — save frequently used text snippets, insert with one click (persisted locally)
- **Undo / redo** — buttons and Ctrl+Z / Ctrl+Y
- **Preview & download** — per-file preview of the edited result, individual downloads,
  or everything as one ZIP
- **Progress bar** for large batches
- **Apply-edits lock** — an admin password (header → **Lock**) must be entered before edits are
  applied; stays unlocked 5 minutes, **Lock now** re-locks. Wrong attempts trigger a growing
  cooldown. Only salted PBKDF2 hashes are stored (this browser's localStorage)
- **Voice unlock (optional)** — say **“Bismillah”** (built-in) or your own English phrase. When you
  click Apply, the app starts listening by itself; once it hears the phrase, the edits apply.
  Recognised fully offline (Vosk) — no audio leaves the PC. Anyone who says the phrase can unlock,
  so the password stays the main lock. **Lock → Test voice** lets you try it without applying

> The lock is a workplace deterrent, not DRM: everything runs in the browser, so someone with
> developer tools on the same PC could bypass it.

## Getting started

```bash
npm install
npm run get-voice-model   # once: downloads the ~40 MB offline voice model into public/models/
npm run dev               # http://localhost:3000
```

### Run on a Windows PC without Node

Copy the folder (with a built `dist/`), then double-click **`Start Bismillah PDF Editor.bat`**. It starts a
tiny local server (`windows/server.ps1`) and opens http://localhost:5199. Close the window to stop.

### Checks (same as CI)

```bash
npm run lint
npm run typecheck
npm test          # unit tests: PDF engine + lock
npm run build
npm run test:e2e  # Playwright: editing, batch apply, downloads, password + real voice unlock
```

Build for production:

```bash
npm run build    # outputs to dist/
npm run preview  # serve the production build locally
```

## How it works

- [pdf.js](https://github.com/mozilla/pdf.js) renders pages and extracts text-span positions
  (each document gets its own module worker)
- [pdf-lib](https://pdf-lib.js.org/) applies the edits: a cover rectangle + wrapped, centered
  text at the same coordinates in every file
- [JSZip](https://stuk.github.io/jszip/) bundles results for download
- UI: React + Tailwind + shadcn/ui; templates persist in `localStorage`
- pdf.js **legacy** build is used so previews work on older Chrome/Edge too

Sample PDFs are included (`sample-*.pdf`) to try the workflow immediately.
