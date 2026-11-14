# EventSync: 10-Minute University Final Project Demo Script

**Project Title:** EventSync: A Distributed Event Registration and Attendance Management System  
**Presentation Time:** 10 Minutes Total  
**Target Audience:** Parallel and Distributed Computing Panel / Course Instructor  
**Deployment Modes Supported:**  
- **Flexible Mode:** 1 Fixed Laptop (Node 1 Server) + Any 3 Physical Devices (Phones, Tablets, or Laptops)
- **Classic Mode:** 4 Physical Laptops (Nodes 1, 2, 3, 4)

---

## Pre-Demo Checklist (2 Minutes Before Panel)
- [ ] Connect all devices to the same mobile hotspot (or local Wi-Fi router).
- [ ] Laptop 1: Open PowerShell as Admin, run server: `npm start` (Note down LAN IP, e.g. `https://192.168.43.10:3000/connect`).
- [ ] Laptop 1: Pre-seed clean database: `npm run seed`.
- [ ] Device 2 (Phone/Tablet/Laptop): Open `https://<IP>:3000/registration` (Registration Station).
- [ ] Device 3 (Phone/Tablet/Laptop): Open `https://<IP>:3000/scanner` (tap "Activate Scanner & Audio", camera active).
- [ ] Device 4 (Tablet/Laptop): Open `https://<IP>:3000/organizer` (Live Monitor & Cluster Health).

---

## 10-Minute Presentation Flow

### Minute 0:00 - 1:30 | Introduction & Architecture Overview
- **Speaker 1 (at Laptop 4):**
  > "Good day, Professor and panel members. We present **EventSync**, a distributed event registration and attendance management system engineered specifically for campus school activities.
  >
  > Rather than running a monolithic website in separate browser tabs, our system physically distributes distinct, necessary computational roles across four physical laptops:
  > - **Laptop 1 (Node 1):** Central Application Server and SQLite Database Host in WAL mode.
  > - **Laptop 2 (Node 2):** Dedicated Registration Desk.
  > - **Laptop 3 (Node 3):** Verification & Attendance Scanner with an offline store-and-forward queue.
  > - **Laptop 4 (Node 4):** Live Organizer Console and Cluster Supervisor.
  >
  > Notice on Laptop 4's Cluster Health panel: all 4 physical machines are currently ONLINE, communicating through real REST commands and real-time Socket.IO WebSockets."

---

### Minute 1:30 - 3:30 | Feature 1: Real-Time Event Creation & Distributed Registration
- **Speaker 2 (at Laptop 4):**
  > "First, let's create a new event here on Laptop 4: *'Autonomous Robotics Symposium 2026'*, seating capacity: 5. Status: OPEN."
  > *(Click Save Event on Laptop 4)*.
- **Speaker 3 (at Laptop 2):**
  > "Look at Laptop 2. Within milliseconds, via WebSocket broadcast, the new event appears in our registration catalog with 5 available seats.
  >
  > Now, let's register a student: School ID `2023-99001`, Name `Gabriel Santos`, Department `BS Computer Science`.
  > *(Click Complete Registration on Laptop 2)*.
  >
  > Immediately, Node 1 signs an HMAC-SHA256 token and generates this official university QR ticket. We can print it or download it."
- **Speaker 2 (at Laptop 4):**
  > "Simultaneously on Laptop 4, without any page refresh, the 'Total Registered' counter incremented and the venue seating capacity bar updated to reflect the new reservation."

---

### Minute 3:30 - 5:00 | Feature 2: High-Speed Verification & Duplicate Prevention
- **Speaker 4 (at Laptop 3):**
  > "Now, the student arrives at the auditorium entrance. On Laptop 3, our webcam scanner is active. We present Gabriel's newly generated QR code from Laptop 2's screen to Laptop 3's camera."
  > *(Camera scans QR code)*.
  >
  > "Listen to that crisp double chime. The screen flashes **GREEN (ATTENDANCE VERIFIED)** displaying Gabriel Santos, BS Computer Science.
  >
  > Now, watch what happens if Gabriel tries to pass his phone to a friend to double check-in:
  > *(Scan the same QR code again)*.
  >
  > The screen flashes **AMBER (ALREADY CHECKED IN)**, plays a warning tone, and displays the exact timestamp Gabriel already checked in. Our unique constraint on `registration_id` guarantees that double check-ins are mathematically impossible."
- **Speaker 2 (at Laptop 4):**
  > "And look at Laptop 4's Live Monitor: Gabriel's check-in just streamed into our live activity feed, and our hourly timeline and department breakdown charts updated automatically."

---

### Minute 5:00 - 7:30 | Feature 3: FAILURE & RECOVERY DEMO (Critical Course Requirement)
- **Speaker 4 (at Laptop 3):**
  > "Now, we will demonstrate **distributed fault tolerance**. Imagine the Wi-Fi connection in the auditorium drops or the access point resets.
  >
  > Watch closely: I am turning OFF the Wi-Fi on Laptop 3 right now."
  > *(Disable Wi-Fi on Laptop 3)*.
  >
  > "Notice the status indicator on Laptop 3 instantly switches to **OFFLINE (QUEUE MODE)**.
  > Now, attendees are still in line. Does the entrance shut down? No!
  >
  > I will scan a registered attendee's QR code right now while completely disconnected."
  > *(Scan QR code on Laptop 3)*.
  >
  > "Laptop 3 performs a provisional format check, persists the scan into an **IndexedDB store-and-forward queue**, and flashes a blue card: **SAVED TO OFFLINE QUEUE**. Notice the badge: '1 Pending Sync'.
  >
  > Let's scan a second student while offline:
  > *(Scan second QR code)*.
  > Badge updates to: '2 Pending Sync'."
- **Speaker 2 (at Laptop 4):**
  > "Meanwhile, look at Laptop 4's Cluster Health panel. Because Laptop 3 stopped sending heartbeats, within our 15-second timeout window, Node 3 turned **RED (OFFLINE)**."
- **Speaker 4 (at Laptop 3):**
  > "Now, the network connection is restored. I am re-enabling Wi-Fi on Laptop 3."
  > *(Turn Wi-Fi back on Laptop 3)*.
  >
  > "Watch: Socket.IO auto-reconnects, detects the 2 pending items in our queue, and immediately flushes them in chronological order via `/api/attendance/sync`."
- **Speaker 2 (at Laptop 4):**
  > "Look at Laptop 4's live feed! Both check-ins have arrived and are prominently flagged with this purple **[OFFLINE SYNC]** badge. And because each scan was generated with a unique `clientScanId`, replaying or re-sending the sync batch is strictly **idempotent**—zero duplicate entries can be created."

---

### Minute 7:30 - 9:00 | Feature 4: Certified Automated Reporting (CSV & PDF)
- **Speaker 2 (at Laptop 4):**
  > "Finally, let's look at the Reports tab on Laptop 4. The organizer has full visibility over the attendance roster, with filters for Present vs. Absent participants.
  >
  > With one click on **Export CSV**, we generate an Excel-compatible CSV file with UTF-8 BOM encoding.
  >
  > And with one click on **Export Official PDF**, Node 1's PDFKit engine dynamically streams a certified attendance report with event header, attendance statistics summary box, and an alphabetical roster of attendees."

---

### Minute 9:00 - 10:00 | Conclusion & Q&A Readiness
- **Speaker 1 (Group Leader):**
  > "To summarize:
  > 1. We satisfied all course requirements using 4 distinct physical laptops with necessary distributed roles.
  > 2. We enforced strict ACID capacity and duplicate check-in consistency using SQLite in WAL mode.
  > 3. We proved distributed fault tolerance through store-and-forward queueing and idempotent batch synchronization.
  >
  > We are now ready to answer any technical questions from the panel."

