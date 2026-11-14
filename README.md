# EventSync

**EventSync** is a local-network school event registration, QR ticket, and attendance verification system designed to run on a single laptop server (`Node 1`) with phones, tablets, and other laptops connecting over the same Wi-Fi or hotspot.

## Features

- **Two Application Roles**:
  - **Administrator**: creates/manages events, runs assisted registration (`/registration`), scans QR passes (`/scanner`) with offline store-and-forward queue, monitors live attendance (`/organizer`), exports CSV/Excel/PDF reports, manages participant/admin accounts, and reviews activity logs.
  - **Participant**: signs up (`/signup`), logs in (`/login`), browses open events, registers, views/downloads their own HMAC-signed QR pass, tracks attendance history, and edits their profile (`/app`).
- **One-Command Network Links**: `npm start` prints clickable `localhost`, LAN Wi-Fi, and Hotspot URLs plus a terminal QR code and a public `/connect` hub.
- **Distributed Reliability**: SQLite WAL mode with transactional capacity guards, unique registration/attendance constraints, idempotent offline scan sync, and authenticated Socket.IO real-time updates.

## Architecture (5-Line Overview)

1. **Node 1 (Central Server)**: Express + Socket.IO + SQLite (WAL mode) running on the host laptop.
2. **Auth & Sessions**: `bcryptjs` password hashing + SQLite-backed `httpOnly` session cookies shared by HTTP routes and Socket.IO.
3. **Participant Portal (`/app`)**: Self-service event browsing, registration, personal QR passes, and attendance history.
4. **Admin Stations (`/admin`, `/registration`, `/scanner`, `/organizer`)**: Role-protected management, assisted registration, camera/manual QR verification, and live monitor.
5. **Offline Queue**: Scanner persists scans in `localStorage` when offline and syncs idempotently once reconnected (preserving the queue if the session expires).

## Quick Start

```bash
git clone <your-repo-url>
cd eventsync
npm --prefix server install
npm run create-admin
npm start
```

1. `npm run create-admin` prompts for your first Administrator username, email, and password (or reads `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` from `.env`).
2. `npm start` auto-creates `.env` with random secrets on first run, initializes `data/eventsync.db`, and prints your **Local**, **Network**, and **Connect** links plus a QR code in the terminal.
3. Open the printed **On your network** link (e.g. `http://192.168.1.14:3000/connect`) on any phone or laptop on the same Wi-Fi.

## Opening on Phones & Camera / HTTPS Note

- **Default HTTP (`npm start`)**: Works immediately on all phones and laptops with **no certificate warnings**. Manual School ID check-in and all portal features work over HTTP.
- **Camera QR Scanning (`npm run start:https`)**: Modern mobile browsers require **HTTPS** for camera access (`getUserMedia`) on non-localhost addresses. Run `npm run start:https` (or set `HTTPS=true` in `.env`) and open `/connect` to download and trust the local Root CA certificate once.

## Windows Firewall & Hotspot Tips

- **Windows Firewall**: If phones on the same Wi-Fi cannot reach the server, run this in an **Administrator Command Prompt**:
  ```cmd
  netsh advfirewall firewall add rule name="EventSync (3000)" dir=in action=allow protocol=TCP localport=3000 profile=any
  ```
- **Windows Mobile Hotspot**: Turn on Windows Mobile Hotspot, connect phones to the laptop's hotspot, and open the `Hotspot network` URL printed by `npm start` (typically `http://192.168.137.1:3000`).

## Scripts

| Command | Description |
| :--- | :--- |
| `npm start` | Start server in HTTP mode (default) and print LAN links + QR |
| `npm run start:https` | Start server in HTTPS mode (for phone camera QR scanning) |
| `npm run start:server` | Alias for `npm start` |
| `npm run create-admin` | Create an Administrator account via terminal prompt or `.env` |
| `npm run seed` | Ask for confirmation, wipe data, and seed sample events & participants |
| `npm run seed:demo` | Seed sample data + demo accounts (`demoadmin`, `demouser`) with warning |
| `npm test` | Run automated unit, CRUD, auth/RBAC, socket, and migration tests |
| `npm run network-check` | Verify server health endpoint and LAN reachability |

## Project Structure

```
eventsync/
├── server/
│   ├── src/
│   │   ├── config.js          # Env loader & first-run secret generator
│   │   ├── db/                # SQLite schema & safe migrations
│   │   ├── middleware/        # Session auth, RBAC, logging, error handler
│   │   ├── routes/            # Auth, events, registrations, attendance, reports, admin, participant
│   │   ├── services/          # Business logic & transactions
│   │   ├── sockets/           # Authenticated Socket.IO hub
│   │   └── utils/             # Network interface detection, HMAC QR, certs
│   └── public/                # /connect, /login, /signup, /app, /admin UIs
├── clients/                   # /registration, /scanner, /organizer station UIs
├── scripts/                   # create-admin.js, seed.js, network-check.js, concurrency-test.js
├── tests/                     # run-all.js, events-crud.test.js, auth-rbac.test.js
└── docs/                      # Architecture, DB, flows, manual, testing, defense Q&A
```

## Troubleshooting

- **Port 3000 already in use**: Run `PORT=3001 npm start` (or in PowerShell `$env:PORT=3001; npm start`), or find the PID with `netstat -ano | findstr :3000`.
- **Phone cannot connect**: Confirm phone and laptop are on the same Wi-Fi/hotspot, and add the Windows Firewall rule above.
- **Session expired on offline scanner**: Do not clear browser storage; log back in as Administrator and click **Sync Queue** — queued scans in `localStorage` are preserved.
