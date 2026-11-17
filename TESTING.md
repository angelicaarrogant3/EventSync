# EventSync – Distributed Testing Guide

Prerequisites: README setup done, one admin account, 2+ participant accounts, HTTPS URL available for the scanner phone.

## Mode A – 1 laptop + cellphones
| Device | Role | Open |
|---|---|---|
| Laptop | Admin – event management | `http://localhost:8080/admin/events` |
| Phone 1 | Participant registration | `https://<public-url>/user/events` (any network, incl. mobile data) |
| Phone 2 | QR verification (admin login) | `https://<public-url>/admin/scan` |
| Phone 3 | Real-time monitoring (admin login) | `https://<public-url>/admin/monitor` |

## Mode B – 3–4 laptops
Laptop 1 `/admin/events` · Laptop 2 `/user/events` · Laptop 3 `/admin/scan` (use *manual code entry* if no webcam/HTTPS) · Laptop 4 `/admin/monitor` + `/admin/reports`.
Use your deployed HTTPS URL (or `http://localhost:8080` for local testing).

## Test scenarios
1. **Event propagation** – Laptop/Admin creates an event as *Draft* → not visible to participants. Click **Publish** → it appears on Phone 1 without refresh.
2. **Registration** – Phone 1 registers. Expect: toast, event shows "You are registered", Admin *Registrations* and *Monitor* "Registered" counter increase within ~1 s, and a `registration.created` row is recorded in `activity_logs` in the background.
3. **QR code** – Phone 1 → *My Registrations* shows a QR. Each registration has a different QR.
4. **Attendance verification** – Phone 2 scans Phone 1's QR → green "Checked in". Phone 3 feed and counters update live; Phone 1's card flips to "Checked in"; profile history shows the event.
5. **Duplicate attendance** – scan the same QR again → amber "Already checked in"; attendance count unchanged.
6. **Duplicate registration** – on two tabs of the same participant click **Register** simultaneously → only one succeeds, the other shows "already registered".
7. **Capacity** – set capacity 1; register with participant A, then B → B gets "Event is full" (also from two devices simultaneously).
8. **Invalid QR** – enter a random UUID in manual entry → red "Invalid QR"; a non-UUID string → "Not an EventSync QR code".
9. **Authorization** – log in as participant and browse to `/admin/events` → redirected to `/user/events`. In the browser console a participant cannot read `attendance` of others or insert into `events` (RLS).
10. **Simultaneous operations** – have 2 participants register while the admin edits an event and a scan happens; all views converge without refresh.
11. **Disconnection & recovery** – on the monitor device enable airplane mode / turn off Wi-Fi → red banner + chip "Offline". Perform a check-in from another device meanwhile. Turn network back on → "Back online" toast and counters/feed refresh automatically with the missed check-in.
12. **Cancellation rules** – participant cancels a registration (QR disappears, spot freed); cancelling after check-in is rejected.
13. **Reports** – *Reports* shows registered/attended/no-show/rate; select an event → attendee table; **Export CSV** and **Print** work.
14. **Cross-network** – put Phone 1 on mobile data and the laptop on Wi-Fi using the HTTPS URL; repeat tests 2–4.

## Pass criteria
All devices show the same counts within ~1–2 s; no duplicates in `registrations`/`attendance`; every transaction is logged in `activity_logs` in the background; app recovers from network loss without manual reload.
