# EventSync

**A Distributed Event Registration and Attendance Management System.**
Vanilla HTML/CSS/ES6 frontend · Supabase (PostgreSQL, Auth, Realtime, RPC) · `serve` on port 8080 · deployable to Vercel/Netlify.

EventSync is its own project with its own database. It does **not** use or touch any MathALINO resources.

## Features
- **Admin:** event CRUD + publish/unpublish, registrations management, QR attendance scanner, live monitor, reports (Excel/PDF), user management.
- **Participant:** sign up/log in, browse events, register, unique QR per registration, registration status, attendance history, profile.
- **Distributed:** any number of devices share one Supabase database; changes propagate through Supabase Realtime.
- **Safety:** RLS on every table, all writes to registrations/attendance via `SECURITY DEFINER` RPCs, `UNIQUE(event_id,user_id)` and `UNIQUE(registration_id)` stop duplicate registration/attendance, capacity checks under row lock, role-escalation trigger.
- **Resilience:** 8-second health ping + browser online/offline events, status chip (Live/Connecting/Offline), offline banner, automatic data refetch on reconnection.

## Structure
```
eventsync/
├── index.html  login.html  signup.html
├── admin/      events · registrations · scan · monitor · reports · logs (.html)
├── user/       events · registrations · profile (.html)
├── css/app.css
├── js/config.js              <- placeholders: put YOUR Supabase URL + anon key here
├── js/core/                  supabase.js · boot.js (route guard + shell) · ui.js (toast, network, realtime, CSV)
├── js/admin/  js/user/  js/pages/
├── supabase/schema.sql       <- tables, RLS, RPCs, realtime
├── tools/generate-config.js  <- builds js/config.js from env vars on Vercel/Netlify
├── serve.json  vercel.json  netlify.toml  .env.example
└── TESTING.md
```

## Setup
1. **Create a NEW Supabase project** at supabase.com (not the MathALINO one).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.
3. **Authentication → Providers → Email:** for easy demos turn *Confirm email* OFF.
4. **Project Settings → API:** copy the Project URL and the **anon/publishable** key into `js/config.js`. Never use the `service_role` key in the frontend.
5. Install and run:
   ```powershell
   cd D:\eventsync
   npm install
   npm start        # http://localhost:8080
   ```
6. **Create an admin (terminal only).** Public signup always creates a `user`; there is no admin signup in the UI.
   `powershell
   $env:SUPABASE_SERVICE_ROLE_KEY = '<service_role key from Dashboard -> Settings -> API Keys>'
   npm run create-admin     # prompts for name, email, password
   ``n   The service-role key stays in your terminal session only - never put it in the app, git, or chat. Log in at `/login`; admins land on `/admin/events`.

## Access modes
| Mode | URL | Camera/QR scanning |
|---|---|---|
| Local testing (laptop) | `http://localhost:8080` | works (localhost is a secure context) |
| Production / Deployed (HTTPS) | Your Vercel/Netlify URL | works everywhere (phones & laptops) |

## Deployment
**Vercel:** push to GitHub → import in Vercel → add env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY` → deploy (`vercel.json` runs `node tools/generate-config.js`).  
**Netlify:** same, using `netlify.toml`.  
Afterwards, in Supabase **Authentication → URL Configuration**, set the Site URL to your deployed URL.

## Real-time notes
Tables `events`, `registrations`, `attendance`, `activity_logs` are added to the `supabase_realtime` publication by the schema. Realtime respects RLS, so participants only receive their own rows; admins receive everything.

## Testing
See [TESTING.md](TESTING.md) for the multi-device distributed test plan, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the distributed system architecture overview.

## Participant sign-up fields & BiPSU Main Campus Programs
The sign-up, profile, and admin 'Register a participant' forms share one component (`js/shared/participant-form.js`) and one searchable School -> Program -> Major selector (`js/shared/program-selector.js`).
- **Single source of truth:** All BiPSU Main Campus schools, programs, and majors live in **`config/programs.js`** (and `public.program_catalog` in PostgreSQL via `supabase/migrations/008_bipsu_programs.sql`).
- **Database fields on `public.profiles`:** `department` (School / Office or Other), `program` (official program name or custom text), `major` (nullable; required only for programs with majors like BSED, BSBA, BSIT), `course` (short display label kept in sync), and `program_needs_update` (`boolean`, flags legacy accounts that could not be auto-mapped cleanly).
- **Server validation:** `resolve_program_selection()` + `validate_participant()` + `validate_profile_update()` reject unknown schools/programs, missing required majors, extra majors on non-major programs, and missing year levels for Students.
- **User guide:** Students pick **School / College** -> **Program** -> **Major** (if applicable) -> **Year level** (1st–4th year), or use the **Search program** box (e.g. typing `"comp"`). Faculty/Staff pick **School / Office** (including `Administrative / Office`) without a year level. Guests can choose **Other / Not listed**. Legacy accounts flagged `program_needs_update` see a banner on `/user/profile` prompting them to select their official program.
- **Defense Q&A — Why does the program list live in one config file?** Keeping all schools, programs, and majors in `config/programs.js` (mirrored by `public.program_catalog` on the database) eliminates duplicate hard-coded lists across forms, filters, QR tickets, and reports, prevents spelling/validation drift, and lets the school update or add a program in one place.

## Event Images (Database, Architecture, User Manual & Defense Q&A)

### Database Design
Migration `supabase/migrations/007_event_images.sql` adds two nullable columns to `public.events` (preserving all existing events) and recreates `public.event_stats`:
- `image_path` (`text`, nullable) — relative object key inside the `event-images` bucket (e.g. `evt_<eventId>_<random>.webp`).
- `image_updated_at` (`timestamptz`, nullable) — timestamp used as a `?v=` cache-buster in public URLs.

### Architecture & Storage
- **Storage module:** `js/shared/event-images.js` encapsulates image validation, client-side 16:9 canvas resize/crop (max 1600 px wide, WebP/JPEG quality 0.82, EXIF stripped), upload, replacement, removal, and URL construction.
- **Bucket & serving:** Stored in the Supabase Storage `event-images` bucket (public read, 5 MB limit, `image/jpeg`, `image/png`, `image/webp` only) with long cache headers (`cacheControl: '31536000'`); object names change on every replacement.
- **Security:** Storage RLS (`storage.objects`) restricts `INSERT`/`UPDATE`/`DELETE` to `public.is_admin()` (`403` for participants, `401` for anonymous). Client and bucket validate real file types by magic bytes (JPEG/PNG/WebP only; SVG/GIF and renamed text files are rejected) and block path traversal.
- **Lifecycle & logs:** Replacing an image deletes the old object; permanently deleting an event deletes its object; archiving (`closed`) keeps it. Uploads, replacements, and removals are logged in `public.activity_logs` and broadcast live via Supabase Realtime (`events`).
- **Offline / missing fallback:** If an event has no image or the image fails to load, cards, details, registrations, QR tickets, and the landing page fall back to a dark + crimson placeholder with the EventSync logo and event initials (no broken image icons). Reports, Excel/CSV exports, and the scanner page intentionally omit images.
- **Printing / PDF Export:** Printouts (`Ctrl+P` or **Export PDF**) hide all site navigation and chrome, using A4 landscape light formatting. If a browser still shows URL/date headers and footers in the print preview, untick **Headers and footers** in the print dialog.

### User Manual: Adding an Event Image
1. Sign in as an **Administrator** and open **Events** (`/admin/events`).
2. Click **+ New event** (or **Edit** on an existing event).
3. Drag and drop an image onto the **Event banner** box, or tap **Choose** to pick a photo from your computer or phone camera/gallery (JPEG, PNG, or WebP, max 5 MB).
4. Adjust the **Zoom**, **Horizontal**, and **Vertical** sliders to frame the 16:9 crop, then click **Save**.
5. Use **Replace** or **Remove** in the edit modal at any time to update or clear the banner.

### Defense Q&A
- **Where are event images stored?** In the Supabase Storage `event-images` bucket; PostgreSQL stores only the relative key (`events.image_path`) and version timestamp (`events.image_updated_at`).
- **Why not store images as blobs inside PostgreSQL?** Storing binary blobs in database rows bloats backups, slows down table scans/queries, and increases memory/egress overhead. Object storage serves cached images directly while keeping `events` fast.
- **How are uploads secured?** Only authenticated administrators can write or delete in `event-images` (enforced by Supabase Storage RLS + `public.is_admin()`). Files are checked by magic bytes (JPEG, PNG, WebP only — no SVG/GIF), capped at 5 MB, re-encoded on canvas (stripping EXIF metadata), and given server-safe random filenames.
- **What happens if an image is missing or the server is unreachable?** An `onerror` handler removes the failed `<img>` and reveals the built-in dark/crimson placeholder with the EventSync logo and event initials, with zero layout shift.
- **How do you track who did what?** Actions are written to an `activity_logs` table in the background; it is not shown in the interface to keep it simple. (Administrators can clear old logs via `npm run clear-activity-logs`.)

## Scanner Station (Full-Screen Result Modal)
- Every scan (camera, manual entry, or offline queue) opens a full-screen result modal on phones (`100dvh`, safe-area insets) and a centered 520 px card on desktop (`js/admin/scan-modal.js`), locking page scroll while open and pausing camera decoding without stopping the camera stream.
- Outcomes use icon + title + color + distinct audio/vibration: **CHECKED IN** (green, 2s auto-close), **CHECKED OUT** (blue, 2s auto-close), **ALREADY CHECKED IN / ALREADY CHECKED OUT / NOT OPEN YET / ATTENDANCE CLOSED / SAVED OFFLINE** (amber/blue, 3s auto-close), and **NO TIME-IN RECORDED / WRONG EVENT / REGISTRATION CANCELLED / EVENT CANCELLED / INVALID QR** (red, stays until **Scan next**, backdrop tap, or `Enter`/`Space`/`Escape`). Durations are configurable in `SCAN_MODAL_CONFIG` (`js/admin/scan-modal.js`).

## Time-In & Time-Out
- **Scanner switch (`/admin/scan`):** Staff choose **[ Time In ]** (green, default) or **[ Time Out ]** (blue), persisted on the device with a visible `Mode: TIME IN` / `Mode: TIME OUT` badge.
- **Database (`supabase/migrations/014_time_out.sql`):** Adds `check_out_time`, `check_out_scan_id` (unique), `check_in_scan_id` (unique), and `checked_out_by_user_id` to `public.attendance`.
- **Atomic concurrency & offline sync:** Time-out uses `UPDATE ... WHERE check_out_time IS NULL AND NOT voided` so two concurrent scanners cannot both set time-out. Offline sync processes queued items in `scanned_at` order and is idempotent by `scan_id`.
- **Defense Q&A — Why use the same QR code for Time In and Time Out?** The QR pass identifies the registration (`qr_token`), while the scanner's selected mode (`IN` | `OUT`) and the stored database state (`checked_in_at` / `check_out_time`) determine whether to record a time-in, record a time-out, or reject (`NO TIME-IN RECORDED`, `ALREADY CHECKED IN`, `ALREADY CHECKED OUT`).

## Post-Event Feedback (Google Form)
- **Database (`supabase/migrations/015_event_feedback.sql`):** Adds `feedback_url` (nullable `text`, protected from direct participant `SELECT`), `feedback_audience` (`'attended'` default or `'registered'`), and `feedback_opened_early` (`boolean`, default `false`) to `public.events`.
- **User Manual:**
  1. Create a Google Form beforehand (set sharing to *"Anyone with the link"* and include a question for school ID or name).
  2. In **Events** (`/admin/events`), paste the Google Form `https://` link under **Feedback form link**, choose **Who can answer** (*People who attended* or *Everyone who registered*), and use **Test link** to verify it.
  3. After the event's end time passes (or if you click **Open feedback now**), eligible participants see a **Give feedback** button under **My Registrations** and a dismissible portal banner.
- **Defense Q&A:**
  - *Why does the server hide the feedback link until the event ends?* `events.feedback_url` is revoked from direct participant `SELECT` and returned only by `my_registrations()` once the server clock is past `ends_at` (or `feedback_opened_early = true`) and the participant meets the audience rule. This prevents participants from inspecting network responses to answer feedback before attending.
  - *Why are only Google Form links accepted?* Both `config/feedback.js` and `validate_event_feedback_url()` restrict URLs to `https://` on `docs.google.com/forms/...`, `forms.gle`, and `forms.google.com`, blocking `javascript:`, `data:`, `http:`, and look-alike phishing hosts.

## Registration Window vs. Attendance Window & Test Mode
- **Two separate windows (`config/schedule.js` + `supabase/migrations/010_attendance_windows.sql`):**
  1. **Registration window:** `events.registration_opens_at` to `events.registration_deadline` (enforced server-side in `_register_core()` for both participant and admin registration).
  2. **Attendance window:** `events.starts_at - early_grace_minutes` (default 60 min) to `events.ends_at + late_grace_minutes` (default 60 min), in `Asia/Manila`. Enforced server-side by `get_attendance_state()` across scan, manual, and offline sync (`sync_offline_attendance()`).
- **Database fields added:** `events` (`registration_opens_at`, `early_grace_minutes`, `late_grace_minutes`, `allow_early_test_attendance`), `attendance` (`is_test`, `clock_suspect`, `voided`, `void_reason`, `voided_by`, `voided_at`).
- **Test mode:** Admins can toggle *"Allow attendance outside the schedule (test mode)"* per event to demo early; those records are flagged `is_test = true`, excluded from reports/dashboards by default, and removable via **Clear test check-ins**.
- **Optional "Late" label (`events.late_after_minutes`):** Default `15` minutes (`0` or blank disables it). Check-ins more than `N` minutes after `starts_at` are labeled **Present (Late)** in the attendance sheet (Excel/PDF/print with a `Total Late` line), My Registrations, and Live Monitor, while still counting as **Present** in totals and attendance rate. Late is computed from stored `checked_in_at` so offline scans keep their true scan time.
- **Fixing historical out-of-window check-ins:** Run `PGURL=... npm run fix-early-checkins` (dry-run by default) and `PGURL=... npm run fix-early-checkins -- --apply` to void out-of-window records with an audit trail (or restore via **Check-ins** on `/admin/events`).
- **Defense Q&A:**
  - *Why is attendance validated on the server?* Client UI checks can be bypassed or run with a wrong device clock. PostgreSQL (`get_attendance_state()` inside `_record_attendance()`) uses the authoritative server clock before writing any row.
  - *How are offline scans validated?* Each queued scan records `scanned_at` on the device; `sync_offline_attendance()` rejects future timestamps, flags `clock_suspect` if `scanned_at` differs >1 hour from server receive time, and validates `scanned_at` against the event's attendance window.



