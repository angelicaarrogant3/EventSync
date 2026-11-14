# EventSync

**A Distributed Event Registration and Attendance Management System.**
Vanilla HTML/CSS/ES6 frontend · Supabase (PostgreSQL, Auth, Realtime, RPC) · `serve` on port 8080 · deployable to Vercel/Netlify.

EventSync is its own project with its own database. It does **not** use or touch any MathALINO resources.

## Features
- **Admin:** event CRUD + publish/unpublish, registrations management, QR attendance scanner, live monitor, reports (print/CSV), activity & transaction logs.
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
| Same laptop | `http://localhost:8080` | works (localhost is a secure context) |
| LAN (phones on same Wi-Fi) | `http://<laptop-ip>:8080` (`ipconfig` → IPv4; `serve` also prints it) | browsing/registration works; **camera is blocked on http** |
| Public HTTPS | Vercel/Netlify URL, or `npm run tunnel` | works everywhere |

> Allow Node.js through Windows Firewall (private network) for LAN access. Mobile browsers only expose the camera on HTTPS, so for the scanner phone use a deployed URL or a tunnel (`npm run tunnel` gives an `https://*.loca.lt` URL; ngrok or `cloudflared tunnel --url http://localhost:8080` also work).

## Deployment
**Vercel:** push to GitHub → import in Vercel → add env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY` → deploy (`vercel.json` runs `node tools/generate-config.js`).  
**Netlify:** same, using `netlify.toml`.  
Afterwards, in Supabase **Authentication → URL Configuration**, set the Site URL to your deployed URL.

## Real-time notes
Tables `events`, `registrations`, `attendance`, `activity_logs` are added to the `supabase_realtime` publication by the schema. Realtime respects RLS, so participants only receive their own rows; admins receive everything.

## Testing
See [TESTING.md](TESTING.md) for the multi-device distributed test plan.

## Participant sign-up fields
The sign-up, profile and admin 'Register a participant' forms share one component (`js/shared/participant-form.js`). Edit the courses, member types and year levels in **one file**: `js/shared/participant-options.js`. Validation rules live in `js/shared/validation.js` (client) and `validate_participant()` in the database (server, authoritative). Run `supabase/migrations/002` and `003` on existing databases (they are also appended to `schema.sql` for new ones). In Supabase -> Authentication -> Sign In / Providers -> Email set **Minimum password length = 8** and **Password requirements = Letters and digits** so the password rule is also enforced by the auth server.

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


