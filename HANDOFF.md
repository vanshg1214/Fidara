# Fidara app: handoff for Sujal

> **Update (Oct 2026):** the app was redesigned and extended (personal return link, server-side progress, home-screen install, CSV exports, tests). `BUILD_PLAN.md` is the current status and checklist; `CLAUDE.md` has the current architecture and commands. Where this file disagrees with them (for example "server.js has not been run" or Google-Fonts/localStorage-only notes), they win.

Hi Sujal. This package is the whole Fidara customer app plus the server that runs it. It replaces the earlier `Main.dc.html` + `record.html` handoff.

## 1. What the customer gets

1. They scan the **QR code** on the box. It opens the app.
2. They register once (name, email, puppy, age, receipt number, ZIP). This is saved on their phone.
3. They see **10 courses**. Charlotte's intro says to go in order (each builds on the last); the app highlights "Next up" but **nothing is locked**, and each course has its own address (`#/lesson/1` … `#/lesson/10`), so a QR code can point straight to one course.
4. Every course page has the lesson audio (or video, once filmed), the steps, common mistakes, "ready when" and practice notes.
5. Every course page has a **built-in video recorder for training review**:
   - Turn on camera → Switch camera (front/back) → Record (3-second countdown) → Stop.
   - **Up to 5 minutes.** The timer shows `m:ss / 5:00`, turns yellow in the last 30 seconds, and stops by itself at 5:00.
   - Watch it back, confirm email, add "what is hard", **Send for review**. An upload progress bar shows.
   - **One video review per box** (matches Charlotte's intro). The server counts reviews per customer email (capitals and +tags ignored) and answers HTTP 409 after the first; the app then shows "already used". Change with `REVIEWS_PER_BOX` in `.env`.
   - Fallbacks: "Record with phone camera" (opens the phone's camera app) or "Choose a video".
   - If sending fails, a "Save video to this phone" button appears so nothing is lost.
6. Charlotte gets an email with a private link to watch the video. **She replies to that email and the reply goes to the customer.**

## 2. Files

| Path | What it is |
|---|---|
| `public/index.html` | The app (home, registration, 10 courses, built-in recorder). Plain HTML/JS, no build step. |
| `public/qr.html` + `qr.js` | QR code sheet. Main code + one code per course. Download PNG/SVG or print. QR encoder is built in (no internet library). Verified: generated codes decode correctly. |
| `public/media/` | Charlotte intro video (**placeholder**: replace `charlotte-intro.mp4` with the new one, same file name, 9:16), poster, 10 lesson audios, Ready Check Board PDF, Verde Casa logo. |
| `public/studio.html` | Charlotte's trainer recording room (not linked from the app). Unchanged. |
| `server/server.js` | Serves `public/` **and** receives review videos at `POST /api/review`. |
| `box/fidara-box-exterior.png` | Box artwork (back-panel text still matches: record, press Send, review emailed back). |

## 3. Tested so far

- Headless Chromium on a phone-sized screen with a fake camera. Tested: course link before registering → register → that course opens; camera on and switch; record; stop; preview; send. The upload arrived with all fields (`video, lesson, lessonName, name, email, dog, note, receipt, duration`). Auto-stop at the time limit works. The QR page renders all 11 codes.
- Added in this pass: one-review-per-box rule, "Next up" highlight, Ready Check Board PDF link (home page), "My puppy passed the ready test" button. Front end re-tested in Chromium against a stand-in upload endpoint (register, record, send, second send blocked with 409).
- `server.js` passes a syntax check. It has **still not been run** (npm was blocked in both environments that tried). Please run the steps below, and also test a second upload with the same email: it must return 409.
- Box art says "10 VIDEO lessons" but the 10 lessons are still **audio**. Put each video address in `V[1..10]` as they are made, or change the box wording before printing.

## 4. What you need to do

1. **Run locally**
   ```
   cd server
   npm install
   cp .env.example .env      # fill in LINK_SECRET and REVIEW_TO at least
   npm start
   ```
   Open http://localhost:3000. Check `GET /health` returns `{"ok":true}`.
   Test upload:
   `curl -F video=@test.mp4 -F lesson=3 -F name=Test -F email=you@example.com -F dog=Buddy -F note=hi http://localhost:3000/api/review`
   With `SMTP_HOST` empty, the two emails are printed in the console instead of sent.
2. **Deploy over https** (Render, Railway, Fly.io or a small VPS). One service serves both the app and `/api/review`, so no CORS setup is needed. Phones only open the live camera on https.
   - Use a **persistent disk** for `UPLOAD_DIR` (or move to S3/Cloud Storage later).
   - Keep `TRUST_PROXY=1` behind Render/Railway/Fly so the rate limit (5 videos/hour/IP) sees real visitor IPs.
   - The server allows uploads up to 300 MB and 15-minute uploads, for slow phones and phone-camera files.
3. **Email**: set real SMTP (SendGrid, Mailgun, Google Workspace) with a sender on the Verde Casa Brands domain. Set `REVIEW_TO` to the inbox Charlotte checks.
4. **Set `PUBLIC_URL`** to the final https address.
5. **Make the QR codes**: open `https://YOUR-ADDRESS/qr.html`. Check the address and download the PNG/SVG for the box printer. **Only print once the address is final.** A printed code cannot be changed, so use a domain you control (e.g. `fidara.verdecasabrands.com`), not a temporary `*.onrender.com` address.
6. **Real-phone test**: iPhone Safari and Android Chrome. Scan the QR, register, record about 1 minute with the back camera, Send. Confirm both emails arrive and the private link plays the video.

## 5. Settings in `public/index.html` (top of the script)

- `SEND_URL`: `'/api/review'` (default, same server). Set `''` to turn off sending (the customer gets "Save video" instead).
- `MAX_SECONDS = 300`: 5-minute limit.
- `VIDEO_BPS = 1200000`: about 45 MB for 5 minutes. Raise for sharper video, lower for faster uploads.
- `V[1..10]`: when a lesson **video** is ready, put its address here (e.g. `'media/fidara-lesson-3.mp4'`). Empty = the audio is shown.

## 6. Privacy and housekeeping

- Videos show customers' homes. Links are signed and private, marked `noindex`, and not cached.
- Videos and their records are deleted automatically after `RETENTION_DAYS` (default 90).
- iPhones upload `.mp4`. Android/desktop usually upload `.webm`. Both play in Chrome; convert with ffmpeg on the server if Charlotte needs mp4 only.

## 7. Do not change

- The upload field names: `video, lesson, lessonName, name, email, dog, note, receipt, duration`.
- The box text promise: record, press Send, review emailed back.
