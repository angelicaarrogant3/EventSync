# EventSync: Distributed Consistency Strategy & Concurrency Control

In a distributed environment where multiple physical machines (Laptops 2, 3, and 4) concurrently generate transactions, maintaining data integrity without race conditions or data loss is the central engineering challenge.

This document explains the formal distributed consistency model of EventSync.

---

## 1. Single Source of Truth (SSOT) & Linearizability

EventSync adopts a **Centralized Primary Source of Truth** topology:
- **Node 1 (Laptop 1)** is the sole authoritative state holder.
- **Client Nodes (2, 3, 4)** are stateless consumers and command originators. They communicate state changes strictly through REST commands to Node 1.
- All writes are serialized through Node 1's transactional database engine. This delivers **linearizability** (strict serializability for write transactions), meaning every client node observes the exact same state order.

---

## 2. SQLite in WAL (Write-Ahead Logging) Mode

SQLite was configured specifically for high-concurrency LAN operations using three critical PRAGMAs:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

### Why WAL Mode is Ideal for this Distributed Scale
1. **Readers Never Block Writers, and Writers Never Block Readers:** In default rollback journal mode, writing locks the entire database file from readers. In **WAL mode**, new writes append to an independent `-wal` file while read queries continue reading committed frames from the main database file concurrently.
2. **High Throughput:** WAL mode drastically reduces disk fsync operations, delivering sub-5ms write transaction speeds on standard laptop solid-state drives (SSDs).
3. **Automatic Busy Timeout (`busy_timeout = 5000`):** If two concurrent HTTP worker threads attempt to write simultaneously, rather than failing immediately with `SQLITE_BUSY`, SQLite waits up to 5,000 milliseconds for the active transaction to commit.

---

## 3. Concurrency Protection & Invariant Enforcement

### 3.1 Invariant 1: Zero Overbooking (Atomic Capacity Guard)
**The Problem:** Two registration stations submit a registration for the last remaining seat at the exact same millisecond.
**The EventSync Solution:**
Registration is executed inside an atomic transaction:
```javascript
const executeRegistrationTx = db.transaction(() => {
  // 1. Read current active registrations under transaction lock
  const activeCount = countRegsStmt.get(eventId).count;
  const event = getEventStmt.get(eventId);

  // 2. Strict capacity boundary check
  if (activeCount >= event.capacity) {
    const err = new Error('Event is at full capacity');
    err.code = 'EVENT_FULL';
    throw err; // Rolls back transaction
  }

  // 3. Insert registration record
  insertRegStmt.run(...);
});
```
Because the count check and insertion occur within the same SQLite transaction, no concurrent request can slip between the check and the insert. Exactly one transaction commits, and the second transaction encounters `activeCount >= event.capacity` and throws `EVENT_FULL (HTTP 409)`.

### 3.2 Invariant 2: Duplicate Check-In Prevention (Race-Safe)
**The Problem:** Two marshals attempt to check in the same participant simultaneously, or a student's QR code is captured twice in rapid succession.
**The EventSync Solution:**
At the database layer, the `attendance` table enforces:
```sql
CONSTRAINT uq_attendance_registration UNIQUE (registration_id)
```
Even if two network threads pass the application-level check simultaneously, the underlying B-Tree index guarantees that only the first write commits. The second write encounters an `SQLITE_CONSTRAINT` violation, which the central error middleware cleanly maps to:
```json
{
  "ok": false,
  "error": {
    "code": "ALREADY_CHECKED_IN",
    "message": "Already checked in at 2026-11-13 13:20:00 by node-3"
  }
}
```

---

## 4. Idempotency & Offline Synchronization

**Idempotency** guarantees that receiving the same network message multiple times produces the identical side-effect as receiving it once:
$$f(f(x)) = f(x)$$

### How Offline Sync Achieves Idempotency:
1. When Laptop 3 scans a QR code while offline, it generates a **`clientScanId`** (UUID v4) at that exact millisecond.
2. The `client_scan_id` is persisted in the local queue and sent in the batch payload to `POST /api/attendance/sync`.
3. In SQLite, `attendance` enforces:
   ```sql
   CONSTRAINT uq_attendance_client_scan UNIQUE (client_scan_id)
   ```
4. If a network blip causes Laptop 3 to retry or re-send a batch that was already partially processed, Node 1 checks:
   ```javascript
   const existingScan = getAttendanceByClientScanStmt.get(clientScanId);
   if (existingScan) {
     return { status: 'VALID', isIdempotentReplay: true };
   }
   ```
   No duplicate attendance record is created, and the client receives confirmation that the item is resolved.

---

## 5. Cryptographic QR Token Integrity (HMAC-SHA256)

To prevent attendee fraud (such as fabricating a QR code with an arbitrary registration ID):
1. Node 1 generates tokens using an HMAC-SHA256 signature:
   $$\text{Signature} = \text{HMAC-SHA256}(K, \text{registrationId} \mathbin{\Vert} \text{eventId})$$
2. Token string:
   $$\text{Token} = \text{base64url}(\text{registrationId} \mathbin{\Vert} \text{eventId} \mathbin{\Vert} \text{Signature})$$
3. Verification uses constant-time comparison (`crypto.timingSafeEqual`) to protect against timing attacks.
4. Client scanners never require the secret key: they transmit the scanned token string over the secure local network to Node 1 for validation.

