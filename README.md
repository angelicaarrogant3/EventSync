# EventSync

**EventSync** is a local-network school event registration and attendance system with role-based accounts (**Administrator** and **Participant**), signed QR passes, offline-capable scanning, live organizer monitoring, and SQLite persistence.

## Quick Start

```powershell
git clone <repo-url>
cd eventsync
npm install
npm run create-admin
npm start
```

`.env` (with fresh random secrets) and `data/eventsync.db` are created automatically on first run.

## Open on a Phone

1. Connect the laptop and phones to the **same Wi-Fi or mobile hotspot**.
2. Open the **Network** link printed by `npm start` (for example `http://192.168.1.14:3000`) on your phone, or run `npm run start:qr` and scan the terminal QR code.
3. Open `/connect` for direct QR links to Login, Sign Up, and Admin stations.

**Phone camera note:** Browser camera access over LAN requires HTTPS. Run `npm run start:https` when scanning with a phone camera, then open `/connect` on the phone to trust the local certificate.

## Scripts

| Script | Description |
| :--- | :--- |
| `npm start` | Start EventSync on plain HTTP (prints Local and Network links). |
| `npm run start:https` | Start EventSync on HTTPS for phone camera QR scanning. |
| `npm run start:info` | Start and print all network interfaces, `/connect` links, and firewall hint. |
| `npm run start:qr` | Start and print a terminal QR code for the Network link. |
| `npm run share` | Start/reuse EventSync and print a public `https://...` link for any network or mobile data. |
| `npm run create-admin` | Create an Administrator account interactively (or via `ADMIN_*` env vars). |
| `npm run seed` | Seed sample events and participants without creating any admin account. |
| `npm run seed:demo` | Seed sample data with a demo admin (`--with-demo-admin`, dev only). |
| `npm test` | Run the automated unit, integration, RBAC, and concurrency test suite. |
| `npm run network-check` | Verify LAN reachability and `/api/health` on the configured server. |

## Windows Firewall

If phones on the same Wi-Fi cannot reach the Network link, allow TCP port `3000` in an **Administrator Command Prompt**:

```cmd
netsh advfirewall firewall add rule name="EventSync (3000)" dir=in action=allow protocol=TCP localport=3000 profile=any
```

## Troubleshooting

- **Port 3000 already in use**: Close the other EventSync terminal, or run `set PORT=3001 && npm start`.
- **Phone cannot open the Network link**: Confirm both devices are on the same Wi-Fi/hotspot and run the Windows Firewall command above.
- **No network detected**: Connect the laptop to Wi-Fi or a hotspot, then restart `npm start`.
- **Camera scanner blocked on phone**: Start with `npm run start:https` and install the Root CA from `/connect`.
- **Login rate-limited after failed attempts**: Wait 10 minutes or restart the server after creating your admin with `npm run create-admin`.

## Documentation

Detailed design and defense docs live in `docs/`:
[Architecture](file:///d:/eventsync/docs/ARCHITECTURE.md) | [Database Design](file:///d:/eventsync/docs/DATABASE_DESIGN.md) | [Communication Flows](file:///d:/eventsync/docs/COMMUNICATION_FLOWS.md) | [User Manual](file:///d:/eventsync/docs/USER_MANUAL.md) | [Testing](file:///d:/eventsync/docs/TESTING_DOCUMENTATION.md) | [Defense Q&A](file:///d:/eventsync/docs/DEFENSE_QA.md)
