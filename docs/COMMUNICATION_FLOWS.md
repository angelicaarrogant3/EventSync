# EventSync: Network Communication & Sequence Flows

This document details the exact network communication sequences across the 4 physical laptops in the EventSync distributed cluster.

---

## 1. Participant Registration Flow (Nodes 2, 1, and 4)

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Student / Attendee
    participant N2 as Node 2 (Laptop 2: Registration Station)
    participant N1 as Node 1 (Laptop 1: Server + SQLite DB)
    participant N4 as Node 4 (Laptop 4: Organizer Console)

    Attendee->>N2: Fills registration form (School ID, Name, Dept)
    N2->>N1: HTTP POST /api/registrations (eventId, participant)
    
    activate N1
    Note over N1: BEGIN SQLite Transaction<br/>1. Check event status = OPEN<br/>2. Count active registrations < capacity<br/>3. Upsert participant by school_id<br/>4. Insert registration UNIQUE(event_id, participant_id)<br/>5. Calculate HMAC-SHA256 QR token<br/>COMMIT Transaction
    N1->>N1: Generate QR PNG Data URL
    N1-->>N2: HTTP 201 Created (registration, participant, qrDataUrl)
    deactivate N1

    N1-)N2: WebSocket broadcast "registration:created" (remainingCapacity)
    N1-)N4: WebSocket broadcast "registration:created" (registration, participant)
    
    Note over N2: Updates remaining capacity badge<br/>Renders official printable QR Ticket
    Note over N4: Increments registered count<br/>Updates capacity utilization bar
    N2->>Attendee: Displays / Prints QR Ticket
```

---

## 2. Real-Time QR Check-in Verification Flow (Nodes 3, 1, and 4)

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Student with QR Pass
    participant N3 as Node 3 (Laptop 3: Scanner Station)
    participant N1 as Node 1 (Laptop 1: Server + SQLite DB)
    participant N4 as Node 4 (Laptop 4: Organizer Console)

    Attendee->>N3: Presents QR Pass to Webcam
    N3->>N3: html5-qrcode decodes raw token string
    Note over N3: Debounce check (prevents repeat read within 2.5s)
    
    N3->>N1: HTTP POST /api/attendance/scan (eventId, qrToken, clientScanId)
    activate N1
    Note over N1: 1. Cryptographic HMAC token validation<br/>2. Event scope check (tokenEventId == eventId)<br/>3. Event status check (must be OPEN)<br/>4. Idempotency check (clientScanId)<br/>5. Duplicate check (registration_id)<br/>6. Insert attendance record & audit log
    
    alt Verification Valid
        N1-->>N3: HTTP 200 OK (status: VALID, attendance, participant)
        N1-)N4: WebSocket broadcast "attendance:checked_in" (participant, stats)
        Note over N3: Plays high pleasant chime (587Hz -> 880Hz)<br/>Displays large GREEN card with student details
        Note over N4: Prepends check-in to live feed with animation<br/>Recalculates hourly & department charts
    else Already Checked In
        N1-->>N3: HTTP 409 Conflict (status: ALREADY_CHECKED_IN, origTime)
        Note over N3: Plays warning tone (440Hz -> 330Hz)<br/>Displays large AMBER card with original check-in time
    else Invalid Signature or Wrong Event
        N1-->>N3: HTTP 400 Bad Request (status: INVALID_TOKEN | WRONG_EVENT)
        Note over N3: Plays low error buzz (220Hz)<br/>Displays large RED card with rejection reason
    end
    deactivate N1
```

---

## 3. Failure & Recovery: Store-and-Forward Offline Sync Flow

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Student with QR Pass
    participant N3 as Node 3 (Laptop 3: Scanner)
    participant N1 as Node 1 (Laptop 1: Server)
    participant N4 as Node 4 (Laptop 4: Organizer)

    Note over N3: Network Failure: Laptop 3 disconnected from LAN
    Attendee->>N3: Presents QR Pass to Webcam
    N3->>N1: HTTP POST /api/attendance/scan (Fails: Network unreachable)
    
    Note over N3: OFFLINE QUEUE PATH:<br/>1. Verify provisional token format (3-part base64url)<br/>2. Generate unique clientScanId (UUID)<br/>3. Persist scan object in IndexedDB / localStorage<br/>4. Plays chime & shows BLUE card: "SAVED OFFLINE"<br/>5. Queue badge shows "1 Pending Sync"

    Note over N1,N4: Meanwhile, Laptop 4 marks Node 3 as OFFLINE after 15s

    Note over N3: Network Restored: Wi-Fi reconnects
    N3->>N1: WebSocket auto-reconnects
    Note over N3: Reconnect trigger detects 1+ items in queue
    
    N3->>N1: HTTP POST /api/attendance/sync ([queuedScansArray])
    activate N1
    Note over N1: BATCH SYNC TRANSACTION:<br/>For each scan in batch:<br/>- Validate token HMAC<br/>- Check client_scan_id idempotency<br/>- Check registration_id uniqueness<br/>- Insert with was_offline_sync = 1<br/>- Audit log
    N1-->>N3: HTTP 200 OK (syncReport: syncedCount, results)
    deactivate N1

    Note over N3: Removes synced clientScanIds from local storage<br/>Clears queue badge to 0<br/>Shows toast: "Batch sync complete"

    N1-)N4: WebSocket broadcast "attendance:checked_in" (with wasOfflineSync=true)
    Note over N4: Live feed displays check-in with purple [OFFLINE SYNC] tag<br/>KPIs update without missed data
```

---

## 4. Node Health & Heartbeat Supervision Flow

```mermaid
sequenceDiagram
    autonumber
    participant Nodes as Client Nodes (Nodes 2, 3, 4)
    participant Hub as Node 1 (Socket.IO Hub & Health Supervisor)
    participant DB as Node 1 (SQLite node_status Table)
    participant Monitor as Node 4 (Organizer Health Panel)

    Nodes->>Hub: WebSocket connect
    Nodes->>Hub: Emit "node:identify" { nodeId, role }
    Hub->>DB: UPSERT node_status (status = ONLINE, last_seen = NOW)
    Hub-)Monitor: Broadcast "node:status" (all nodes)
    
    loop Every 5 Seconds
        Nodes->>Hub: Emit "node:heartbeat" { nodeId, role }
        Hub->>DB: UPDATE node_status SET last_seen = NOW, status = 'ONLINE'
    end

    loop Every 3 Seconds (Supervisor Health Scan)
        Hub->>DB: Query nodes where (NOW - last_seen) > 15 seconds
        alt Node Timed Out (> 15s without heartbeat)
            Hub->>DB: UPDATE node_status SET status = 'OFFLINE'
            Hub-)Monitor: Broadcast "node:status"
            Note over Monitor: Node card turns RED (OFFLINE)
        end
    end
```



---

## 6. Authenticated Flows (Login, Self-Registration, Assisted Registration, Scan & Reconnect)

1. **Login Flow:** Client submits `POST /api/auth/login` -> rate-limit check (10 failures / 10 min) -> `bcryptjs` verify -> SQLite `sessions` row created -> `httpOnly` `eventsync_sid` cookie set -> redirected to `/admin` (Administrator) or `/app` (Participant).
2. **Participant Self-Registration:** Participant logs in -> browses `GET /api/events` (only `OPEN` events) -> `POST /api/my/registrations` -> atomic capacity & deadline check -> HMAC QR generated -> `my:registration_updated` emitted to `user:<id>` and `registration:created` emitted to `role:administrator`.
3. **Administrator-Assisted Registration:** Administrator opens `/registration` -> fills participant details (optionally checking "Create participant account with temporary password") -> `POST /api/registrations` records `registered_by_user_id` -> printable QR pass displayed.
4. **QR Scan & Reissue:** Scanner submits `POST /api/attendance/scan` -> verifies HMAC signature, event status (`OPEN`/`ONGOING`), `token_version` match (rejecting reissued old tokens), and double check-in guard -> records `verified_by_user_id` -> broadcasts `attendance:checked_in` to `role:administrator`.
5. **Offline Reconnect & Session Expiry:** If the scanner goes offline, scans are saved in `localStorage`. On reconnect, if the session expired while offline (`401`), the scanner preserves the entire queue and prompts the Administrator to log in at `/login?next=/scanner` before clicking **Sync Queue**.
