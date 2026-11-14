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
6. **Create the first admin:** sign up at `/signup`, then in the SQL Editor run  
   `update public.profiles set role = 'admin' where email = 'you@example.com';`  
   (Roles cannot be changed from the browser.) Log in again → you land on the Admin area.

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
