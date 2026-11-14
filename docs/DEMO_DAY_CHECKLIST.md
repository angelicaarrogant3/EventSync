# EventSync: Demo Day Execution & Readiness Checklist

This checklist guarantees a smooth, zero-failure presentation of **EventSync** on demo day, whether your team has 4 laptops, 1 laptop + 3 smartphones, or any mixed device setup.

---

## 1. Pre-Demo Equipment Checklist (T - 1 Hour)

| Item | Requirement | Status |
|---|---|---|
| **Laptop 1 (Fixed)** | Runs Node 1 Server + Database. Battery charged + power brick. | [ ] |
| **Client Devices (3x)** | Any combination of phones, tablets, or laptops (iOS/Android/Windows/macOS). | [ ] |
| **Local Wi-Fi Network** | Mobile Hotspot (phone LTE/5G sharing) OR router where client isolation is disabled. | [ ] |
| **Node.js Environment** | Node.js v18+ verified on Laptop 1 (`node -v`). | [ ] |
| **Database Seed** | Test events and sample participants loaded (`node scripts/seed.js`). | [ ] |

> [!TIP]
> **Use a Smartphone Mobile Hotspot** instead of university campus Wi-Fi. University Wi-Fi networks often enable "Client Isolation" (AP isolation), which blocks devices from communicating with each other on the LAN. A personal mobile hotspot guarantees direct, low-latency device-to-device communication.

---

## 2. Server Startup on Laptop 1 (T - 15 Minutes)

1. Connect Laptop 1 to the mobile hotspot.
2. Open PowerShell / Terminal in the project root:
   ```bash
   cd d:\eventsync
   npm start
   ```
3. Observe console output:
   - Certificate engine verifies SAN IP list.
   - SQLite WAL database connects cleanly.
   - Server announces LAN HTTPS endpoints:
     ```
     ================================================================
        EVENTSYNC IS LIVE ON YOUR LOCAL NETWORK (HTTPS)
     ================================================================
     Server IP:       192.168.43.10
     Root CA Cert:    data/certs/rootCA.pem

     Device Onboarding Hub (Open this on other devices):
     --> https://192.168.43.10:3000/connect
     ```

---

## 3. Device Onboarding & Role Assignment (T - 10 Minutes)

1. Open `https://<LAPTOP_IP>:3000/connect` on Laptop 1's browser to display the QR codes on the laptop screen.
2. Connect each borrowed device (phones, tablets, or laptops) to the **same mobile hotspot**.
3. Point each device's camera at the corresponding QR code on Laptop 1's screen:

| Station | Recommended Device | Target URL | Actions Upon Opening |
|---|---|---|---|
| **Node 2: Registration** | Phone or Tablet | `https://<IP>:3000/registration` | Tap device badge to name (e.g. "Front Desk iPad"). Form is ready. |
| **Node 3: Scanner** | Smartphone (rear camera) | `https://<IP>:3000/scanner` | Tap **"Activate Scanner & Audio"**, allow camera permissions. Select rear camera. |
| **Node 4: Organizer** | Tablet or Laptop | `https://<IP>:3000/organizer` | Shows real-time KPIs and Cluster Health monitor. |

---

## 4. Platform Certificate Trust Quick Reference

Browsers require a secure context (HTTPS) for webcam access and service workers.

### iOS (iPhone / iPad) - Safari:
1. On the `/connect` page, tap **"Download Root CA Certificate (.crt)"**.
2. Tap **Allow** when prompted to download configuration profile.
3. Open **Settings > Profile Downloaded > Install** (enter device passcode).
4. **CRITICAL STEP**: Open **Settings > General > About > Certificate Trust Settings** (at bottom).
5. Under "Enable full trust for root certificates", toggle **EventSync Distributed Root CA** to **ON (Green)**.
6. Return to Safari and refresh. The padlock icon will show secure green HTTPS!

### Android - Chrome:
1. On the `/connect` page, tap **"Download Root CA Certificate (.crt)"**.
2. Go to **Settings > Security > Encryption & credentials > Install a certificate > CA certificate**.
3. Select the downloaded `rootCA.crt` and tap OK.
4. *Shortcut alternative*: When Chrome warns "Your connection is not private", tap **Advanced > Proceed to [IP] (unsafe)**. Camera access works properly once accepted.

### Windows Laptop - Chrome / Edge:
1. Double-click `data/certs/rootCA.crt`.
2. Click **Install Certificate > Local Machine > Place all certificates in following store**.
3. Choose **Trusted Root Certification Authorities > Finish**.

---

## 5. Pre-Flight Verification on Organizer Console

Before starting the defense presentation, open **Cluster Health** on Node 4 (Organizer):
- [ ] Server (Node 1) is **ONLINE** (green dot).
- [ ] Registration Station (Node 2) is **ONLINE**.
- [ ] Scanner Station (Node 3) is **ONLINE**.
- [ ] Organizer Console (Node 4) is **ONLINE**.
- [ ] The yellow "Missing-roles" banner is **HIDDEN** ("All 4 Stations Synchronized").

---

## 6. Live Demonstration Sequence (Step-by-Step)

1. **Architecture & Topology Walkthrough (1 min)**:
   - Show Laptop 1 running Node 1 Server.
   - Show the other 3 physical devices and their assigned roles.
   - Point out the device name and type pills (`📱`, `📲`, `💻`) on the Organizer's Cluster Health tab.

2. **Real-Time Registration (1 min)**:
   - On Node 2 (Registration), register a new student for the open event.
   - Show instant generation of cryptographically signed HMAC-SHA256 QR pass.
   - Tap **"Share Pass"** to show mobile Web Share sheet or download QR PNG.
   - Show that Node 4 (Organizer) live feed instantly logged the registration and updated remaining seats via WebSocket!

3. **QR Attendance Verification (1 min)**:
   - On Node 3 (Scanner), scan the generated QR ticket from Node 2's screen or printed ticket.
   - Instant visual feedback: large green card **"VALID ATTENDANCE"**, audio confirmation ding, and haptic buzz.
   - Show Node 4 immediately appending the check-in to the live feed and updating the hourly timeline and department breakdown!

4. **Consistency & Duplicate Guard (30 sec)**:
   - Scan the **exact same QR code a second time** on Node 3.
   - Instant amber warning: **"DUPLICATE ATTENDANCE: Already checked in at [time]"**.
   - Explain to the panel: *"ACID database transaction with `UNIQUE(registration_id)` prevents double counting."*

5. **Failure & Store-and-Forward Recovery Demo (2 min - Highest Impact)**:
   - On Node 3 (Scanner), toggle **Airplane Mode ON** or turn off Wi-Fi.
   - Show scanner header switching to **"OFFLINE (STORE & FORWARD)"**.
   - Show Node 4 (Organizer) within 15 seconds marking Node 3 **OFFLINE (red)** and displaying the missing-role banner!
   - Scan another participant on Node 3:
     - Blue card shows **"SAVED TO OFFLINE QUEUE"**.
     - Badge updates: **"1 Pending Sync"**.
   - Turn **Airplane Mode OFF** on Node 3:
     - Scanner automatically detects network restoration (`online` event).
     - Batch POST `/api/attendance/sync` flushes the queue.
     - Node 4 live feed receives the check-in marked with the **[OFFLINE SYNC]** badge!
     - Cluster Health returns to all green.

6. **Automated Reporting (30 sec)**:
   - On Node 4, switch to **Reports & Roster** tab.
   - Tap **"Export Official PDF"** to generate the university-branded PDF attendance sheet.
   - Tap **"Export CSV"** for registrar data export.

---

## 7. Emergency Fallback Plans

| Issue | Rapid Fix |
|---|---|
| **Camera permission blocked on mobile** | Use the built-in **"Manual School ID Verification"** form directly below the camera viewport on Node 3. It checks in attendees through the exact same verification pipeline. |
| **Hotspot IP address changed** | Run `npm start` again on Laptop 1. The server dynamically detects the new LAN IP, reissues the SAN certificate in <100ms, and updates `/connect`. |
| **One device battery dies** | Pick up any team member's phone, scan the QR code for that role from `/connect`, and resume immediately without restarting the server! |
| **HTTPS certificate issue in emergency** | Stop server (`Ctrl+C`) and run `npm run start:http` (`HTTP_ONLY=true`). Test locally or use localhost tunneling. |
