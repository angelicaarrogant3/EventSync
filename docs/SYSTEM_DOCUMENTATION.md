# EventSync: System Documentation
**Course:** Parallel and Distributed Computing  
**Project Title:** EventSync: A Distributed Event Registration and Attendance Management System  
**System Version:** 1.0.0  

---

## 1. System Objectives

EventSync is an enterprise-grade distributed system tailored specifically for academic environments (universities, colleges, and schools). It addresses chronic bottlenecks found in traditional event organization:
- **Long registration and queue lines** during large assemblies, symposia, and university workshops.
- **Data corruption and duplicate entries** arising from paper sheets or uncoordinated spreadsheets.
- **Inaccurate attendance logs** and vulnerable manual attendance sign-in methods.
- **Slow, manual reporting** that delays event certification and post-event administrative audits.

The primary engineering objective of EventSync is to demonstrate practical distributed systems principles—including **physical node separation**, **centralized single-source-of-truth transactional consistency**, **cryptographic token verification**, **sub-second push synchronization via WebSockets**, and **store-and-forward fault tolerance**—using 4 distinct physical laptops operating across a single local area network (LAN/Wi-Fi).

---

## 2. Scope & Target Audience

### 2.1 Scope
- **Campus-Restricted Operations:** EventSync is engineered strictly for school activities (academic seminars, tech summits, college orientations, org assemblies, and faculty colloquia).
- **Physical 4-Node Topology:** Exactly 4 physical laptops running role-specific node applications communicating over a LAN without requiring external cloud databases or paid third-party APIs.
- **Air-Gapped / Offline LAN Capability:** All libraries (Socket.IO client, QR scanning engine, Web Audio API synthesis) are bundled locally. The system requires zero public internet connectivity.

### 2.2 Target Users
1. **Students, Faculty, and Staff:** Event participants registering online and obtaining verifiable QR passes.
2. **Registration Station Operators (Node 2):** Marshals overseeing attendee signups and re-issuing lost passes.
3. **Verification Marshals (Node 3):** Gatekeepers scanning QR tickets or performing manual lookups.
4. **Event Organizers & University Administrators (Node 4):** Supervisors monitoring live attendance metrics and exporting certified audit reports.

---

## 3. Core Features Breakdown

| Feature | Description | Primary Node | Protocol |
|---|---|---|---|
| **Event Creation & Full CRUD** | Create, read, update, change status (`DRAFT`, `OPEN`, `CLOSED`, `ENDED`), archive (`?archive=true`), and safe/force delete (`DELETE /api/events/:id`) with audit logging and `event:updated` / `event:deleted` WebSocket broadcasts. | Node 1 & 4 | REST / WebSocket |
| **Online Participant Registration** | Self-service registration verifying capacity and assigning signed QR tokens. | Node 2 | REST / WebSocket |
| **Cryptographic QR Pass Issuance** | HMAC-SHA256 signed QR codes with printable tickets and downloadable PNGs. | Node 1 & 2 | REST / Crypto |
| **High-Speed QR Verification** | Webcam-based scanning verifying cryptographic signature and event validity. | Node 3 | Local Camera / REST |
| **Store-and-Forward Offline Queue** | Uninterrupted offline scanning with local queueing and idempotent batch sync. | Node 3 | IndexedDB / REST Sync |
| **Real-Time Live Attendance Monitor** | Real-time live feed of incoming check-ins, capacity utilization, and analytics. | Node 4 | WebSocket Push |
| **Cluster Node Health Supervisor** | 5-second heartbeats tracking online/offline status with 15s fault detection. | Node 1 & 4 | WebSockets / REST |
| **Automated Multi-Format Reports** | Instant certified attendance report generation in CSV and vector-quality PDF. | Node 1 & 4 | REST / PDFKit |

---

## 4. System Limitations & Assumptions

1. **Local Area Network Assumption:** The 4 physical laptops must be connected to the same subnet (via Wi-Fi router, local switch, or mobile hotspot).
2. **Single Database Host (Node 1):** Node 1 acts as the authoritative primary. If Node 1 is offline, Nodes 2 and 4 pause write operations, while Node 3 continues in offline queueing mode.
3. **Camera Hardware Requirement:** Laptop 3 requires an operational integrated webcam or external USB camera. A manual school ID fallback is provided if camera permissions are unavailable.
4. **Scope Limitation:** The system is purposefully engineered for LAN campus deployments without multi-datacenter sharding or distributed two-phase commit (2PC) over WAN.

