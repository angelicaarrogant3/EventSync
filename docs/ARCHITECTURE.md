# EventSync — Distributed Architecture

This document preserves the technical architecture of **EventSync** for system design review and school defense.

## Overview
EventSync implements a **Multi-Tier Client–Server & Cloud-Backed Pub/Sub Distributed Architecture** across four independent device roles:

1. **Cloud Database & Middleware (Supabase):**
   - **PostgreSQL** with Row-Level Security (RLS), `FOR UPDATE` row locking, `UNIQUE` constraints, and `SECURITY DEFINER` RPCs (`register_for_event`, `cancel_registration`, `verify_attendance`, `sync_offline_attendance`, `attendance_sheet`, `admin_list_users`, `public_upcoming_events`).
   - **GoTrue Auth** for JWT session management and role enforcement (`admin` vs `user`).
   - **Supabase Realtime (WebSockets)** streaming WAL changes on `events`, `registrations`, `attendance`, and `profiles` to all connected clients.
   - **Supabase Storage (`event-images` bucket)** storing compressed 16:9 WebP/JPEG event banners.
2. **Registration Node (Participant Browser):**
   - Participants browse published events, reserve seats atomically, receive unique UUID QR passes, and view live Time-In / Time-Out updates.
3. **Scanner Station (Door Staff Browser):**
   - Verifies QR passes in **Time In** or **Time Out** mode over HTTPS/localhost using `get_attendance_state()` and queues offline scans with `scan_id` and `scanned_at` for idempotent sync.
4. **Organizer Hub (Admin Browser):**
   - Manages events, schedules, test mode, live attendance feeds, BiPSU Main Campus user directories, and A4 Excel/PDF attendance sheets.

## Network Resilience
An 8-second health ping (`GET /rest/v1/`) combined with browser `online`/`offline` listeners updates the connection status chip (`Live` / `Connecting` / `Offline`) and triggers automatic state resynchronization via `watch()` upon reconnection.
