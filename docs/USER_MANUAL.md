# EventSync: User Manual & Physical Setup Guide

This guide provides complete, step-by-step instructions for deploying and running **EventSync** across:
- **Mode A (Recommended): Flexible Deployment (1 Laptop Server + Any 3 Devices: Phones, Tablets, or Laptops)**
- **Mode B: Original 4-Laptop Multi-Port Deployment**

---

## 1. Prerequisites

- **1 Fixed Laptop** (Windows, macOS, or Linux) with **Node.js 18+** installed (`node -v`).
- **3 Additional Devices** with modern web browsers (Chrome, Safari, Edge, Firefox). Can be smartphones (Android/iOS), tablets (iPad/Android), or other laptops.
- **One Shared Local Network:** Connect all devices to the same Wi-Fi router or a **Personal Mobile Hotspot**.
- No public internet access is required during the demonstration.

---

## 2. Windows Firewall Setup (Laptop 1 Only)

For other devices on your Wi-Fi/hotspot to reach port `3000`, allow inbound TCP traffic.

### On Laptop 1 (Run in PowerShell as Administrator):
```powershell
New-NetFirewallRule -DisplayName "EventSync Node 1 Server" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```
*(Alternatively, in Windows Security -> Firewall & network protection -> Allow an app through firewall -> ensure Node.js is checked for Private networks).*

---

## 3. Mode A: Flexible Deployment (1 Laptop + Any Devices)

This is the primary deployment mode. All roles are served directly from Laptop 1 over secure LAN HTTPS.

### Step 1: Start Node 1 Server on Laptop 1
1. Open PowerShell / Terminal in the project root:
   ```bash
   cd d:\eventsync
   npm start
   ```
2. The server will output its detected LAN IP and onboarding URL:
   ```
   ================================================================
      EVENTSYNC IS LIVE ON YOUR LOCAL NETWORK (HTTPS)
   ================================================================
   Server IP:       192.168.43.10
   Root CA Cert:    data/certs/rootCA.pem

   Device Onboarding Hub (Open this on other devices):
   --> https://192.168.43.10:3000/connect
   ```
3. Open `https://localhost:3000/connect` in Laptop 1's browser. This displays QR codes and links for all roles.

### Step 2: Connect Devices to Roles
Connect your other 3 devices to the same Wi-Fi or mobile hotspot. Scan the corresponding QR code from Laptop 1's screen (or type the URL into their browser):

1. **Device 1 (e.g. Phone/Tablet) -> Registration Station (`/registration`):**
   - Tap device badge at top to name it (e.g. "Front Desk Phone").
   - Select an open event, fill out attendee details, and tap "Complete Registration".
   - Tap **Share Pass** to send the ticket pass or download the QR PNG.

2. **Device 2 (e.g. Phone) -> Attendance Verification Station (`/scanner`):**
   - Tap **"Activate Scanner & Audio"** to unlock the rear camera and audio synthesizer.
   - Select "Camera 0 (Back/Environment)" if multiple cameras exist.
   - Point at any QR ticket to verify attendance.
   - Notice the Screen Wake Lock keeps the screen awake automatically.

3. **Device 3 (e.g. Tablet or Laptop 1) -> Organizer Console (`/organizer`):**
   - Shows live KPI cards, attendance rates, department breakdown, and live check-in stream.
   - Check the **Cluster Health** tab: confirms all devices are online and that no roles are missing.
   - Export CSV or university-branded PDF attendance reports from the **Reports** tab.

---

## 4. Platform Certificate Trust Quick Steps

Because browsers require HTTPS for camera and service worker APIs, devices trust the local Root CA:

### iOS (Safari):
1. Navigate to `https://<LAPTOP_IP>:3000/connect` and tap **"Download Root CA Certificate (.crt)"**.
2. Tap **Allow** to download the profile.
3. Open **Settings > Profile Downloaded > Install**.
4. Open **Settings > General > About > Certificate Trust Settings** (at the bottom).
5. Toggle **EventSync Distributed Root CA** to **ON (Green)**.
6. Refresh Safari. The site will load securely with full camera permissions.

### Android (Chrome):
1. Navigate to `https://<LAPTOP_IP>:3000/connect`.
2. When Chrome shows "Your connection is not private", tap **Advanced > Proceed to [IP] (unsafe)**. Camera access works properly once accepted.
3. *(Optional)* Download the Root CA `.crt` from the `/connect` page and install under **Settings > Security > Encryption & credentials > Install a certificate > CA certificate**.

---

## 5. Mode B: Original 4-Laptop Multi-Port Mode (Backward Compatible)

If you have 4 physical laptops, each running its own local client process:

1. **Laptop 1 (Server):**
   ```bash
   npm run start:server
   ```
2. **Laptop 2 (Registration on Port 3001):**
   ```bash
   npm run start:registration
   # Opens http://localhost:3001
   ```
3. **Laptop 3 (Scanner on Port 3002):**
   ```bash
   npm run start:scanner
   # Opens http://localhost:3002
   ```
4. **Laptop 4 (Organizer on Port 3003):**
   ```bash
   npm run start:organizer
   # Opens http://localhost:3003
   ```
5. **Local Single-Laptop Development:**
   ```bash
   npm run start:all
   ```
   Launches all 4 processes concurrently using `concurrently`.

---

## 6. Failure Simulation & Store-and-Forward Demonstration

1. Run the failure helper on Laptop 1:
   ```bash
   npm run failure:demo
   ```
2. Toggle **Airplane Mode** on the Scanner device (Node 3).
3. Observe the UI switches to **"OFFLINE (STORE & FORWARD)"**.
4. Scan a QR code: ticket is safely saved to local storage with **"1 Pending Sync"**.
5. Observe Node 4 marks Node 3 as **OFFLINE** within 15 seconds.
6. Turn Airplane Mode **OFF**:
   - The scanner immediately syncs the queue with `POST /api/attendance/sync`.
   - Node 4 displays the check-in with the **[OFFLINE SYNC]** badge.


---

## 7. User Accounts, Role Portals & One-Command Network Access

> **Note:** The group has the instructor's permission to use smartphones as client devices on the same Wi-Fi/hotspot as the single laptop server.

### 7.1 Starting & Connecting Devices
1. Create the first Administrator: `npm run create-admin`
2. Start the server: `npm start` (HTTP default, no certificate warning) or `npm run start:https` (for phone camera QR scanning).
3. The terminal prints clickable links (`Local`, `On your network`, `Hotspot network`, `/connect`, `/login`, `/signup`) and a QR code.
4. Open `/connect` on any phone or laptop on the same Wi-Fi to scan or tap Login / Sign Up.

### 7.2 Participant Pages (`/app`)
- **Sign Up (`/signup`)** and **Login (`/login`)**
- **Dashboard (`/app`)**: overview of open events, registrations, and attended events.
- **Browse Events (`/app/events`, `/app/events/:id`)**: search/filter open events and register.
- **My Events (`/app/my-events`)**: view or cancel registrations.
- **My QR Passes (`/app/my-qr`)**: view and download personal PNG QR passes.
- **My Attendance (`/app/my-attendance`)**: view personal attendance status (`PRESENT`, `PENDING`, `ABSENT` after event completion).
- **Profile (`/app/profile`)**: edit personal details and change password.

### 7.3 Administrator Pages (`/admin` & Stations)
- **Dashboard (`/admin`)**: KPIs matching reports, station shortcuts, recent activity.
- **Stations (`/registration`, `/scanner`, `/organizer`)**: assisted registration (with optional temporary-password account creation), QR scanning with offline queue, and live monitor.
- **Participants (`/admin/participants`)**, **Accounts (`/admin/accounts`)**, **Records & QR Reissue (`/admin/records`)**, **Reports (`/admin/reports` — CSV, Excel `.xlsx`, PDF, Print)**, and **Activity Logs (`/admin/activity`)**.
