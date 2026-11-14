# EventSync: Defense Q&A Cheat Sheet (15 Key Technical Questions)

Use these concise, technically rigorous answers during your oral examination and project defense.

---

### Q1: Why is this considered a distributed system rather than a regular web application?
**Answer:**  
"A distributed system is defined by distinct autonomous computing nodes communicating over a network with independent states and failure modes. EventSync is not one website opened in four tabs. It runs four physically separate application processes on four laptops, each with necessary, role-specific logic:
- Laptop 1 is the transactional server and database host.
- Laptop 2 enforces registration client workflows and ticket generation.
- Laptop 3 drives camera hardware and maintains an autonomous local offline queue.
- Laptop 4 supervises node heartbeats and renders live analytical streams.  
Crucially, when Laptop 3 disconnects, it continues operating independently—a hallmark of true distributed systems."

---

### Q2: What happens if two stations try to register the very last available seat at the exact same millisecond?
**Answer:**  
"We prevent overbooking using an atomic SQLite transaction on Node 1. Inside `db.transaction`, we query `SELECT COUNT(*) WHERE status = 'REGISTERED'` under transaction lock and compare it against `event.capacity`. If capacity is reached, the transaction immediately rolls back and throws `EVENT_FULL (HTTP 409)`. SQLite's write-lock serializes concurrent transactions, guaranteeing that exactly one station claims the slot, and the other receives a clean rejection. We verified this with our automated stress test firing 10 simultaneous requests for the last slot."

---

### Q3: How do you mathematically guarantee that an attendee cannot check in twice?
**Answer:**  
"We enforce a dual-layer defense:
1. **Application Layer:** We query whether an attendance row exists for the `registration_id`. If found, we return `409 ALREADY_CHECKED_IN` with the original timestamp.
2. **Database Engine Layer (The Invariant Lock):** In the schema, `attendance` defines `CONSTRAINT uq_attendance_registration UNIQUE (registration_id)`. Even if two concurrent network requests somehow bypassed application checks, the database B-Tree index guarantees that only one row can ever be committed for that registration."

---

### Q4: Why did you choose SQLite with WAL mode instead of MySQL or PostgreSQL?
**Answer:**  
"In distributed systems, choosing an appropriate database is about matching the scale and operational requirements. EventSync is an on-campus LAN deployment running on physical laptops. PostgreSQL or MySQL require heavy client-server database daemon setups on student laptops.  
SQLite in **WAL (Write-Ahead Logging)** mode provides:
- Fully ACID-compliant transactions with zero administrative overhead.
- True concurrent read-write capability: readers in WAL mode read from the main database file without blocking or waiting for active writers.
- `busy_timeout = 5000ms`, giving incoming writes a wait queue.
- Sub-5ms transaction commit latencies on SSDs, easily handling university event loads."

---

### Q5: Why did you combine REST with WebSockets instead of using only one?
**Answer:**  
"REST and WebSockets solve fundamentally different distributed communication problems:
- **REST (HTTP):** Best for request-response transactional commands that require standard status codes (`201 Created`, `409 Conflict`), idempotent retries, and large binary file streaming (like PDF reports).
- **WebSockets (Socket.IO):** Best for low-latency, bidirectional, server-to-client push notifications. When a student checks in on Laptop 3, Node 1 pushes the event to Laptop 4 over an open socket connection, avoiding the network waste and latency of polling."

---

### Q6: How does the offline queue work on the scanner (Laptop 3)?
**Answer:**  
"Laptop 3 implements the **Store-and-Forward** distributed pattern. When the browser fetch request to Node 1 fails or when the station detects an offline socket state:
1. The scanner performs a provisional format check on the QR token.
2. It assigns a cryptographically unique `clientScanId` (UUID) and local timestamp.
3. It enqueues the scan into `localStorage` / `IndexedDB`.
4. When network connectivity is restored, the scanner automatically flushes the queue in chronological order to `/api/attendance/sync`."

---

### Q7: What if the scanner re-sends the offline queue twice due to an unstable Wi-Fi connection?
**Answer:**  
"All synchronization operations in EventSync are **idempotent**. Every offline scan carries a unique `client_scan_id` generated at the moment of the scan. In the database, `client_scan_id` has a `UNIQUE` constraint. If Node 1 receives a scan ID it has already recorded, it returns `isIdempotentReplay: true` with `200 OK` and does not insert a duplicate row. Replaying the queue 100 times produces the exact same state as playing it once."

---

### Q8: What if a student takes a screenshot of their QR code and shares it with a friend?
**Answer:**  
"The first person to reach the gate gets checked in. When the second person presents the screenshot, Laptop 3 detects that the `registration_id` is already marked present, sounds an amber warning tone, and displays the exact time and station where the pass was already used."

---

### Q9: Could an attacker forge their own QR code by encoding someone else's ID?
**Answer:**  
"No. The QR token is not plain text. It is an **HMAC-SHA256 signed token**:
`base64url(registrationId + '.' + eventId + '.' + HMAC_SHA256(secret, registrationId + ':' + eventId))`  
The secret key lives strictly in Node 1's `.env`. If someone creates a fake token, Node 1's `crypto.timingSafeEqual` check fails with `INVALID_SIGNATURE`, returning `400 INVALID_TOKEN` and triggering a red error buzzer on Laptop 3."

---

### Q10: How does the system detect that a laptop has crashed or disconnected?
**Answer:**  
"Through a distributed **Heartbeat & Liveness Protocol**:
- Every client node (2, 3, 4) emits a `node:heartbeat` WebSocket message to Node 1 every 5 seconds.
- Node 1 updates the `last_seen` timestamp in the `node_status` table.
- Node 1 runs a supervisor interval every 3 seconds checking for nodes where `(NOW - last_seen) > 15 seconds`.
- If a node misses 3 consecutive heartbeats, Node 1 marks it `OFFLINE` and broadcasts a `node:status` event to the Organizer Console (Laptop 4), which instantly turns the node card red."

---

### Q11: What happens if the central server (Node 1) crashes completely?
**Answer:**  
"Because Node 1 is the authoritative database host, state-altering operations pause gracefully:
- **Node 2 (Registration):** Detects server unreachable, displays a red banner, preserves form inputs, and disables submission to prevent uncoordinated overbooking.
- **Node 3 (Scanner):** Automatically enters **Offline Queue Mode**, allowing marshals to keep scanning attendees without disruption.
- **When Node 1 restarts:** SQLite WAL mode recovers committed transactions instantly with zero data corruption. Client nodes auto-reconnect, Node 3 flushes its offline queue, and Node 4 refetches a fresh snapshot."

---

### Q12: Why does each client node run a local web server (e.g. `localhost:3002`) instead of just opening an HTML file?
**Answer:**  
"For two critical reasons:
1. **Browser Security (`getUserMedia` API):** Modern browsers restrict webcam access to `localhost` or `https://`. By running a tiny local static server on Laptop 3 (`http://localhost:3002`), the browser treats the origin as trusted and allows webcam scanning without needing expensive SSL certificates on a private LAN.
2. **Environment Portability:** Each local server serves a `/config` endpoint that injects `SERVER_URL` into the frontend, enabling students to switch target LAN IPs during testing with zero code modifications."

---

### Q13: How does Node 4 catch up if it was disconnected while check-ins were happening?
**Answer:**  
"When Node 4 re-establishes its WebSocket connection, it invokes our **reconnection catch-up handler (`syncOnReconnect`)**. This calls `GET /api/events/:id/attendance/live` and `GET /api/events/:id/stats`, fetching a complete snapshot of all transactions that occurred during the outage. It then resumes listening for real-time WebSocket events."

---

### Q14: How does EventSync handle participants who already exist in the university database?
**Answer:**  
"We use an upsert strategy indexed on `school_id`. In `registerParticipant`, we check if a participant with that `school_id` exists. If they do, we update their details (name, department, year level) and associate their existing `participant_id` with the new event registration. This prevents duplicate participant records while allowing students to attend multiple events."

---

### Q16: Can a web app running in a smartphone or tablet browser genuinely be considered a distributed system node?
**Answer:**  
"Yes, absolutely. In distributed computing theory, a **node** is defined not by its chassis or whether it has a terminal window open, but by its **independent execution runtime, local memory, private hardware peripherals, and network communication interface**.  
When Node 3 (Scanner) runs in a smartphone or tablet browser:
1. **Isolated Runtime & Process:** It executes an independent V8/WebKit process with its own call stack and execution thread.
2. **Direct Hardware Control:** It manages physical hardware—the optical camera sensor via `getUserMedia`, the haptic vibration motor via `navigator.vibrate`, the audio synthesizer via `AudioContext`, and the display state via `navigator.wakeLock`.
3. **Autonomous Local State (Store-and-Forward):** When network connectivity is severed (e.g. Airplane Mode), it continues executing without crashing, buffering scans in persistent browser storage (`localStorage` / `IndexedDB`) with local timestamps and UUIDs.
4. **Cluster Protocol Participation:** It identifies itself with a unique persistent `deviceId`, announces its hardware type (`phone`, `tablet`, `laptop`), emits periodic heartbeats every 5 seconds, and executes distributed batch synchronization (`POST /api/attendance/sync`).  
A client that maintains autonomous state, operates through network partitions, and synchronizes over a network is a true distributed node by every rigorous definition."

---

### Q17: Why did you implement a local Root CA and dynamic SAN certificate rather than just asking users to ignore SSL warnings?
**Answer:**  
"Modern mobile operating systems (specifically iOS Safari and Android Chrome) strictly block access to security-sensitive hardware like optical cameras and PWA Service Workers unless the web application is served in a verified **Secure Context** (HTTPS with a valid certificate, or `localhost`).  
By engineering a local Root CA with `node-forge` that dynamically signs certificates containing the laptop's exact LAN IP in the Subject Alternative Name (SAN) list:
1. Mobile devices can install and trust the Root CA profile in seconds via `/connect`.
2. Mobile browsers grant immediate, native webcam access without browser security blocks or mixed-content errors.
3. All network traffic across the local Wi-Fi or mobile hotspot is strongly encrypted with TLS 1.3 / AES-GCM, preventing passive packet sniffing of student records on open campus networks."

---

### Q18: If you had more time or were deploying across the entire university campus, what would you add?
**Answer:**  
"We would implement:
1. **Active-Passive Database Replication:** Using Raft consensus or Litestream to replicate SQLite WAL logs to a standby backup laptop in case Laptop 1 suffers hardware failure.
2. **Local Cryptographic Public-Key Verification:** Supplying client scanner nodes with an asymmetric public key (Ed25519) so they can verify digital signatures offline rather than just provisional token formats.
3. **Hardware Barcode Scanners:** Adding USB HID keyboard-wedge scanner support alongside the webcam."



---

## 6. Authentication, Security & Deployment Q&A

**Q: Why does EventSync have two application roles (`administrator` and `participant`)?**
A: Separates event staff operations (creating events, assisted registration, scanning QR passes, exporting reports, managing accounts) from attendee self-service (browsing open events, registering, viewing only their own QR pass and attendance history). Every API route and Socket.IO event enforces this on the server.

**Q: How are sessions and Socket.IO connections secured?**
A: Passwords are hashed with `bcryptjs`. Login issues a random 64-hex session ID stored in the SQLite `sessions` table and sent in an `httpOnly`, `SameSite=Lax` cookie (`Secure` when HTTPS is enabled) with sliding inactivity expiration. Socket.IO's `io.use()` middleware reads and validates the same session cookie, rejecting unauthenticated clients and restricting management broadcasts (`node:status`, `attendance:checked_in`, `registration:created`) to the `role:administrator` room.

**Q: Why SQLite instead of PostgreSQL?**
A: EventSync runs on a single laptop server (`Node 1`) in a campus/LAN environment with zero external database setup. SQLite in WAL mode provides ACID transactions, foreign keys, `UNIQUE` constraints, and high concurrent read/write throughput in a single portable file (`data/eventsync.db`).

**Q: What happens if an Administrator's session expires while the scanner is offline?**
A: Queued scans are stored in `localStorage` (`OfflineScanQueue`). On reconnect or sync, if the server returns `401 Unauthorized`, the scanner preserves the entire queue untouched and prompts the Administrator to log in again at `/login?next=/scanner` before retrying `/api/attendance/sync`.

**Q: Why are smartphones valid client devices in this system?**
A: Our group has the instructor's permission to use smartphones as client devices alongside the single host laptop. Serving all UIs from Node 1 over the same Wi-Fi/LAN lets any phone or tablet act as a Participant device or an Admin station without installing any software.
