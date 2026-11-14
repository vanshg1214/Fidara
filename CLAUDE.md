# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fidara is a customer training app for a dog-training product box (Verde Casa Brands). A QR code on the box opens the app, the customer works through 10 courses, and can record a video (up to 5 min) that is sent to Charlotte (trainer) for review. `HANDOFF.md` has the full product description, deploy checklist and test history; read it before larger changes.

## Commands

All commands run from `server/`:

```
npm install
cp .env.example .env     # LINK_SECRET (not a "change-me" value) and REVIEW_TO are required or the server exits
npm run dev              # node --watch server.js on http://localhost:3000  (npm start = no auto-restart)
npm test                 # 12 end-to-end tests; starts its own server on a spare port with temp folders
npm run icons            # regenerates public/icons/*.png (paw on green); replace the PNGs to use a real logo
```

- Health check: `GET /health`. With `SMTP_HOST` empty, emails are printed to the console.
- Reset local data: delete `server/data` and `server/uploads`.
- No build step or linter. `BUILD_PLAN.md` tracks what is built, tested and still to do.

## Architecture

Two parts, no build tooling:

- **`public/`**: static front end. `index.html` is a single-file app (hash routes `#/lesson/1`..`#/lesson/10`, `#/back/<token>`). Settings at the top of its script: `SEND_URL`, `V[1..10]` (lesson video URLs), `VIDEO_ASPECT`. Also: `lessons.js` (course copy), `qr.html`+`qr.js` (QR sheet, own encoder), `studio.html` (Charlotte's local recorder), `manifest.webmanifest` + `sw.js` + `icons/` (home-screen install), `fonts/` (self-hosted).
- **`server/server.js`**: single-file Express server serving `public/` and the API:
  - `POST /api/register`: validates, stores in `customers.json` (keyed by `emailKey`: case and +tag ignored), appends `registrations.jsonl`, mirrors to the sheet, emails the personal link, optionally notifies `SIGNUP_NOTIFY_TO` / `ESTOY_AQUI_TO`. Requires `consent: true` (stores `consentAt` + `termsVersion`; wording lives in `public/terms.html` (Privacy Notice, EN + ES), version in `TERMS_VERSION` in `index.html`; optional `marketing` flag stored as `marketingOptIn`). Known email: returns `existing:true` and no token.
  - `POST /api/join` + `GET /join`: the QR landing form (public/join.html). Saves a lead (name, email, optional WhatsApp, optional puppy, contact channels, consent) to `leads.jsonl` + the sheet tab "QR sign-ups"; `/admin/leads.csv`. The box QR points here; after joining, the page offers the PWA install and opening the installed app (standalone) redirects to `/`. Prefills the main register form via `fidara_join`.
  - `POST /api/restore` / `POST /api/progress`: token = `base64url(emailKey).HMAC`; restore returns details, ticked courses, review status.
  - `POST /api/review`: multer upload (300 MB), rate limit counted on success only, one review per box checked by typed email and by account (`X-Fidara-Token` header), permanent counter in `customers.json`. Mail failures are logged, not shown to the customer.
  - `GET /v/:id/:sig`: private signed video page.
  - Admin (all off unless `ADMIN_KEY` is set): `GET /admin` serves `server/admin.html` (single-file dashboard, kept out of `public/`); `POST /admin/login` sets a 12 h HttpOnly SameSite=Strict cookie scoped to `/admin`; `GET /admin/api/data` returns customers, reviews and system flags; `POST /admin/api/review-status` toggles `new`/`replied` in the review's `.json`; `/admin/registrations.csv` and `/admin/reviews.csv` accept the cookie or HTTP Basic auth and are formula-safe.
  - Retention sweep deletes only `UPLOAD_DIR` files older than `RETENTION_DAYS`. `.env` is parsed by hand (no dotenv).

## Front-end details worth knowing

- Course copy lives in `public/lessons.js` (`FIDARA_LESSONS`, `FIDARA_CHAPTERS`), shared by `index.html` and `studio.html`. Keep its order in step with `LESSONS` in `server.js`.
- Lesson videos: set `V[n]` at the top of the script in `index.html`. Empty shows a "Video lesson coming soon" placeholder with the audio player underneath.
- Customer state is in `localStorage`: `fidara_reg`, `fidara_done`, `fidara_review_used`, `fidara_token` (+ install-bar flags). The sign-up is posted once (`syncReg`, retried until the server answers < 500 and not 429); the server's token then syncs progress (`pushProgress`) and is sent on review uploads.
- Routing is hash-based (`#/lesson/N`; other hashes like `#courses` are in-page anchors handled in `route()`). An unregistered visitor opening a lesson link is held on the registration form, then forwarded (`wantLesson`).
- `studio.html` is fully local (IndexedDB, never uploaded), a separate tool for Charlotte.
- Fonts are self-hosted in `public/fonts/` (Latin subset of Poppins, Nunito Sans, Fraunces).

## Data storage

- Source of truth: `DATA_DIR/customers.json` (+ append-only `registrations.jsonl`), kept outside `UPLOAD_DIR`. Both must be on a persistent disk in production.
- Optional mirrors: Google Sheet via `toSheet()` + `server/google-sheet.gs` (`SHEETS_WEBHOOK_URL`/`SHEETS_SECRET`; failures only logged) and a per-sign-up email to `ESTOY_AQUI_TO`.

## Constraints

- Do not rename the upload field names (an optional `X-Fidara-Token` header exists beside them): `video, lesson, lessonName, name, email, dog, note, receipt, duration`. The front end and server both depend on them.
- Keep the box promise intact: record, press Send, review emailed back. Charlotte's reply to the review email goes to the customer (`replyTo` is set to the customer email).
- `LESSONS` in `server.js` and the course list in `public/index.html` must stay in the same order (10 courses).
- QR codes are printed on physical boxes, so URL paths (`/#/lesson/N`, `/qr.html`) must remain stable once the domain is final.
- The live camera only works over https in phones; local testing uses localhost.
