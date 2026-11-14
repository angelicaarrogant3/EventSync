/**
 * EventSync - Node 3: Attendance Verification Station
 * Flexible Device-Agnostic Client Engine (Phone, Tablet, Laptop)
 */

let appConfig = {
  serverUrl: window.location.origin, // Default to same-origin (HTTPS)
  deviceId: null,
  role: 'SCANNER',
  deviceType: 'laptop',
  deviceName: 'Scanner Station'
};

let socket = null;
let heartbeatInterval = null;
let html5QrCode = null;
let isScanning = false;
let selectedEventId = null;
let allEvents = [];
let isOnline = false;
let currentVideoTrack = null;
let torchActive = false;

// Scan debounce state
let lastScannedText = null;
let lastScannedTime = 0;
const DEBOUNCE_WINDOW_MS = 2500;
let cardResetTimer = null;

// DOM Elements
const connectionPill = document.getElementById('connectionPill');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const deviceBadgePill = document.getElementById('deviceBadgePill');
const headerDeviceName = document.getElementById('headerDeviceName');
const headerDeviceTypeIcon = document.getElementById('headerDeviceTypeIcon');

const offlineStatusNotice = document.getElementById('offlineStatusNotice');
const queueCountBadge = document.getElementById('queueCountBadge');
const btnViewQueue = document.getElementById('btnViewQueue');
const btnForceSync = document.getElementById('btnForceSync');

const eventSelect = document.getElementById('eventSelect');
const cameraSelect = document.getElementById('cameraSelect');
const btnToggleCamera = document.getElementById('btnToggleCamera');
const btnToggleTorch = document.getElementById('btnToggleTorch');
const cameraStartOverlay = document.getElementById('cameraStartOverlay');
const btnOverlayStart = document.getElementById('btnOverlayStart');
const cameraStatusLabel = document.getElementById('cameraStatusLabel');
const scanDebounceLabel = document.getElementById('scanDebounceLabel');

const manualEntryForm = document.getElementById('manualEntryForm');
const manualSchoolIdInput = document.getElementById('manualSchoolIdInput');
const btnSubmitManual = document.getElementById('btnSubmitManual');

const resultCard = document.getElementById('resultCard');
const resultIcon = document.getElementById('resultIcon');
const resultTitle = document.getElementById('resultTitle');
const resultSubtitle = document.getElementById('resultSubtitle');
const resultDetails = document.getElementById('resultDetails');

// Modals
const queueModal = document.getElementById('queueModal');
const queueItemsList = document.getElementById('queueItemsList');
const btnCloseQueueModal = document.getElementById('btnCloseQueueModal');
const btnCancelQueueModal = document.getElementById('btnCancelQueueModal');
const btnSyncFromModal = document.getElementById('btnSyncFromModal');

const deviceModal = document.getElementById('deviceModal');
const inputDeviceName = document.getElementById('inputDeviceName');
const selectDeviceType = document.getElementById('selectDeviceType');
const btnCloseDeviceModal = document.getElementById('btnCloseDeviceModal');
const btnCancelDeviceModal = document.getElementById('btnCancelDeviceModal');
const btnSaveDeviceModal = document.getElementById('btnSaveDeviceModal');

// ============================================================================
// INITIALIZATION & DEVICE IDENTITY
// ============================================================================
async function initApp() {
  setupEventListeners();
  updateQueueUI();

  // Register PWA Service Worker if available
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  }

  // 1. Initialize persistent device identity
  appConfig.deviceId = window.deviceManager.getDeviceId();
  appConfig.deviceType = window.deviceManager.detectDeviceType();
  appConfig.deviceName = window.deviceManager.getDeviceName('Scanner');

  updateDeviceBadge();

  // 2. Check if running standalone on custom port or same-origin
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const data = await res.json();
      if (data.serverUrl && !window.location.pathname.startsWith('/scanner')) {
        appConfig.serverUrl = data.serverUrl;
      }
    }
  } catch {
    // Same-origin mode
    appConfig.serverUrl = window.location.origin;
  }

  // Check saved serverUrl in localStorage
  const savedUrl = localStorage.getItem('eventsync_server_url');
  if (savedUrl) {
    appConfig.serverUrl = savedUrl;
  }

  // 3. Connect to Socket.IO & populate events
  connectSocket();
  await refreshEvents();
  await initCameraDevices();

  // 4. Mobile Lifecycle: Listen for wake-up from sleep / tab backgrounding
  window.deviceManager.setupLifecycleListeners(async (trigger) => {
    console.log(`[Lifecycle] Scanner received ${trigger}. Refreshing cluster state...`);
    if (socket && !socket.connected) {
      socket.connect();
    }
    await refreshEvents();
    if (window.offlineQueue.count() > 0) {
      syncOfflineQueue();
    }
  });
}

function updateDeviceBadge() {
  headerDeviceName.textContent = appConfig.deviceName;
  const icons = { phone: '📱', tablet: '📲', laptop: '💻' };
  headerDeviceTypeIcon.textContent = icons[appConfig.deviceType] || '📱';
}

// ============================================================================
// SOCKET.IO REAL-TIME HUB & CLUSTER CONNECTION
// ============================================================================
function connectSocket() {
  if (socket) socket.disconnect();

  updateConnectionStatus('connecting', 'Connecting...');

  socket = io(appConfig.serverUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected to Node 1 Server:', socket.id);
    isOnline = true;
    updateConnectionStatus('online', 'Station Online');
    offlineStatusNotice.textContent = 'Station Mode: Synchronized with Node 1';
    offlineStatusNotice.style.color = '#ffffff';

    // Identify device to server cluster
    socket.emit('node:identify', {
      nodeId: appConfig.deviceId,
      deviceId: appConfig.deviceId,
      role: 'SCANNER',
      deviceType: appConfig.deviceType,
      deviceName: appConfig.deviceName
    });

    startHeartbeat();

    // AUTO-SYNC ON RECONNECT: If offline queue contains scans, flush immediately!
    const pendingCount = window.offlineQueue.count();
    if (pendingCount > 0) {
      console.log(`[Recovery] Reconnected with ${pendingCount} offline scans. Triggering auto-sync...`);
      syncOfflineQueue();
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from Node 1 Server:', reason);
    isOnline = false;
    updateConnectionStatus('offline', 'OFFLINE (Queue Mode)');
    offlineStatusNotice.textContent = 'Station Mode: Disconnected from Node 1 (Scans will queue locally)';
    offlineStatusNotice.style.color = '#fbbf24';
    stopHeartbeat();
  });

  socket.on('connect_error', () => {
    isOnline = false;
    updateConnectionStatus('offline', 'OFFLINE (Queue Mode)');
    offlineStatusNotice.textContent = 'Station Mode: Offline (Scans will queue locally in IndexedDB)';
    offlineStatusNotice.style.color = '#fbbf24';
  });

  socket.on('event:updated', () => {
    refreshEvents(true);
  });

  socket.on('event:deleted', (payload) => {
    console.log('[Socket] event:deleted received:', payload);
    if (selectedEventId && payload && payload.eventId === selectedEventId) {
      const verb = payload.archived ? 'archived' : 'deleted';
      selectedEventId = null;
      resetResultCard();
      showToast(`Active event "${payload.title || ''}" was ${verb}. Returning to event picker. Offline queue preserved.`, 'warning');
      refreshEvents(false);
      if (eventSelect) eventSelect.focus();
    } else {
      refreshEvents(true);
    }
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('node:heartbeat', {
        nodeId: appConfig.deviceId,
        deviceId: appConfig.deviceId,
        role: 'SCANNER',
        deviceType: appConfig.deviceType,
        deviceName: appConfig.deviceName
      });
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function updateConnectionStatus(state, text) {
  statusDot.className = 'pulse-dot ' + state;
  statusText.textContent = text;
}

// ============================================================================
// CAMERA & QR SCANNING (html5-qrcode with Rear Camera & Torch)
// ============================================================================
async function initCameraDevices() {
  try {
    if (!window.Html5Qrcode) {
      cameraStatusLabel.textContent = 'Loading QR library...';
      return;
    }

    const devices = await Html5Qrcode.getCameras();
    cameraSelect.innerHTML = '';

    if (!devices || devices.length === 0) {
      cameraSelect.innerHTML = '<option value="">No cameras detected</option>';
      cameraStatusLabel.textContent = 'No webcam detected. Use Manual ID entry below.';
      return;
    }

    // Sort to place back/environment camera first on phones
    devices.sort((a, b) => {
      const labelA = (a.label || '').toLowerCase();
      const labelB = (b.label || '').toLowerCase();
      if (labelA.includes('back') || labelA.includes('rear') || labelA.includes('environment')) return -1;
      if (labelB.includes('back') || labelB.includes('rear') || labelB.includes('environment')) return 1;
      return 0;
    });

    for (const dev of devices) {
      const opt = document.createElement('option');
      opt.value = dev.id;
      opt.textContent = dev.label || `Camera ${cameraSelect.children.length + 1}`;
      cameraSelect.appendChild(opt);
    }

    cameraStatusLabel.textContent = `${devices.length} camera(s) ready. Tap to scan.`;
  } catch (err) {
    console.warn('[Camera] Enumeration error:', err.message);
    cameraStatusLabel.textContent = 'Camera permission required or not accessible. Use Manual ID fallback.';
  }
}

async function startCamera() {
  // Mobile audio context unlock & wake lock
  window.sounds.init();
  window.deviceManager.requestWakeLock();

  cameraStartOverlay.style.display = 'none';

  let cameraConfig = { facingMode: { ideal: "environment" } };
  if (cameraSelect.value) {
    cameraConfig = cameraSelect.value;
  }

  try {
    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode("reader");
    }

    await html5QrCode.start(
      cameraConfig,
      {
        fps: 15,
        qrbox: { width: 220, height: 220 }
      },
      onScanSuccess,
      onScanFailure
    );

    isScanning = true;
    btnToggleCamera.textContent = 'Stop Camera';
    btnToggleCamera.className = 'btn btn-secondary';
    cameraStatusLabel.textContent = 'Camera active: Scanning QR passes in real-time...';
    document.getElementById('scannerReticle').style.display = 'block';

    // Inspect video track for torch support
    checkTorchSupport();
  } catch (err) {
    console.error('[Camera] Start failure:', err);
    showToast('Failed to start camera: ' + err.message, 'error');
    cameraStartOverlay.style.display = 'flex';
  }
}

function checkTorchSupport() {
  try {
    const videoElem = document.querySelector('#reader video');
    if (videoElem && videoElem.srcObject) {
      const track = videoElem.srcObject.getVideoTracks()[0];
      if (track) {
        currentVideoTrack = track;
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.torch) {
          btnToggleTorch.style.display = 'inline-flex';
        } else {
          btnToggleTorch.style.display = 'none';
        }
      }
    }
  } catch (e) {
    console.warn('[Torch] Capability check error:', e);
  }
}

async function toggleTorch() {
  if (!currentVideoTrack) return;
  try {
    torchActive = !torchActive;
    await currentVideoTrack.applyConstraints({
      advanced: [{ torch: torchActive }]
    });
    btnToggleTorch.textContent = torchActive ? '🔦 Torch ON' : '🔦 Torch OFF';
  } catch (e) {
    showToast('Torch error: ' + e.message, 'error');
  }
}

async function stopCamera() {
  if (html5QrCode && isScanning) {
    try {
      await html5QrCode.stop();
    } catch (e) {
      console.warn('[Camera] Stop error:', e);
    }
    isScanning = false;
    btnToggleCamera.textContent = 'Start Camera';
    btnToggleCamera.className = 'btn btn-primary';
    btnToggleTorch.style.display = 'none';
    cameraStatusLabel.textContent = 'Camera stopped.';
    document.getElementById('scannerReticle').style.display = 'none';
  }
}

function onScanSuccess(decodedText) {
  const now = Date.now();

  // Debounce repeat reads
  if (decodedText === lastScannedText && (now - lastScannedTime) < DEBOUNCE_WINDOW_MS) {
    scanDebounceLabel.textContent = `Debouncing (${Math.round((DEBOUNCE_WINDOW_MS - (now - lastScannedTime)) / 100) / 10}s)`;
    return;
  }

  lastScannedText = decodedText;
  lastScannedTime = now;
  scanDebounceLabel.textContent = 'Code detected!';

  handleQrCodeVerification(decodedText.trim());
}

function onScanFailure() {
  // Silent frame scan failure
}

// ============================================================================
// VERIFICATION ENGINE (ONLINE VS OFFLINE)
// ============================================================================
async function handleQrCodeVerification(qrToken) {
  if (!selectedEventId) {
    showToast('Please select an active event first!', 'error');
    return;
  }

  const clientScanId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'scan-' + Date.now();
  const scannedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

  if (isOnline) {
    try {
      const response = await fetch(`${appConfig.serverUrl}/api/attendance/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': appConfig.deviceId,
          'x-node-role': 'SCANNER',
          'x-device-id': appConfig.deviceId
        },
        body: JSON.stringify({
          eventId: selectedEventId,
          qrToken,
          clientScanId,
          scannedAt
        })
      });

      if (response.status === 401) {
        // Session expired: save scan to offline queue so nothing is lost and prompt re-login
        window.offlineQueue.enqueue({ eventId: selectedEventId, qrToken, clientScanId, scannedAt });
        updateQueueUI();
        showToast('Session expired. Scan saved to offline queue. Please log in again.', 'error');
        if (confirm('Your Administrator session expired. Your scan was saved in the offline queue. Log in again now?')) {
          window.location.href = '/login?next=/scanner';
        }
        return;
      }

      const json = await response.json();

      if (response.ok && json.ok) {
        renderResultCard('valid', json.data);
      } else if (response.status === 409) {
        renderResultCard('duplicate', json.error);
      } else {
        renderResultCard('invalid', json.error);
      }
      return;
    } catch (fetchErr) {
      console.warn('[Scan] Network request failed. Falling back to offline queue...', fetchErr);
      isOnline = false;
      updateConnectionStatus('offline', 'OFFLINE (Queue Mode)');
    }
  }

  // OFFLINE QUEUE PATH
  const provisionalValid = verifyProvisionalTokenFormat(qrToken);

  if (!provisionalValid) {
    renderResultCard('invalid', {
      code: 'INVALID_TOKEN_FORMAT',
      message: 'Token format is malformed or invalid.'
    });
    return;
  }

  window.offlineQueue.enqueue({
    clientScanId,
    eventId: selectedEventId,
    qrToken,
    scannedAt
  });

  updateQueueUI();

  renderResultCard('offline-pending', {
    clientScanId,
    scannedAt,
    queueCount: window.offlineQueue.count()
  });
}

function verifyProvisionalTokenFormat(token) {
  try {
    let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const decoded = atob(base64);
    const parts = decoded.split('.');
    return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0 && parts[2].length === 64;
  } catch {
    return false;
  }
}

// ============================================================================
// RESULT CARD RENDERING & AUDIO / HAPTICS
// ============================================================================
function renderResultCard(status, data) {
  clearTimeout(cardResetTimer);
  resultCard.className = `result-card ${status}`;

  if (status === 'valid') {
    window.sounds.playSuccess();
    window.deviceManager.vibrate([100]); // 1 crisp haptic pulse

    const p = data.participant || {};
    const att = data.attendance || {};

    resultIcon.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    resultTitle.textContent = 'ATTENDANCE VERIFIED';
    resultSubtitle.textContent = p.fullName || p.full_name;
    resultDetails.innerHTML = `
      <div><strong>School ID:</strong> ${escapeHtml(p.schoolId || p.school_id)}</div>
      <div><strong>Department:</strong> ${escapeHtml(p.departmentOrCourse || p.department_or_course)}</div>
      <div><strong>Year & Role:</strong> ${escapeHtml(p.yearLevel || p.year_level)} &bull; ${escapeHtml(p.role || 'STUDENT')}</div>
      <div style="margin-top:0.4rem; font-size:0.8rem; opacity:0.85;">Check-in: ${att.checked_in_at || 'Recorded'}</div>
    `;
  } else if (status === 'duplicate') {
    window.sounds.playWarning();
    window.deviceManager.vibrate([100, 50, 100]); // 2 amber haptic pulses

    const p = data.participant || {};
    const orig = data.originalCheckIn || {};

    resultIcon.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    resultTitle.textContent = 'ALREADY CHECKED IN';
    resultSubtitle.textContent = p.fullName || 'Participant';
    resultDetails.innerHTML = `
      <div><strong>School ID:</strong> ${escapeHtml(p.schoolId || '')}</div>
      <div style="margin-top: 0.4rem; color: #fef08a;">
        Already checked in at <strong>${orig.checked_in_at || 'earlier'}</strong> by station <strong>${orig.scanned_by_node || 'scanner'}</strong>
      </div>
    `;
  } else if (status === 'invalid') {
    window.sounds.playError();
    window.deviceManager.vibrate([250]); // long warning buzz

    resultIcon.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    resultTitle.textContent = 'INVALID PASS';
    resultSubtitle.textContent = data.code || 'REJECTED';
    resultDetails.innerHTML = `
      <div style="color: #fecaca;">${escapeHtml(data.message || 'Verification rejected by system.')}</div>
    `;
  } else if (status === 'offline-pending') {
    window.sounds.playSuccess();
    window.deviceManager.vibrate([80]);

    resultIcon.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    resultTitle.textContent = 'SAVED TO OFFLINE QUEUE';
    resultSubtitle.textContent = 'Scan captured in local storage';
    resultDetails.innerHTML = `
      <div>Format Verified &bull; Pending Node 1 Sync</div>
      <div style="margin-top: 0.4rem; font-size: 0.8rem; opacity: 0.9;">
        Queue ID: <code>${data.clientScanId.substring(0, 16)}...</code><br>
        Will sync automatically upon reconnection.
      </div>
    `;
  }

  cardResetTimer = setTimeout(() => {
    resetResultCard();
  }, 4500);
}

function resetResultCard() {
  resultCard.className = 'result-card idle';
  resultIcon.innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
  resultTitle.textContent = 'Scanner Ready';
  resultSubtitle.textContent = 'Position attendee QR code in front of camera';
  resultDetails.innerHTML = '<span>Awaiting attendance scan...</span>';
}

// ============================================================================
// OFFLINE QUEUE MANAGEMENT & BATCH SYNCHRONIZATION
// ============================================================================
function updateQueueUI() {
  const count = window.offlineQueue.count();
  if (count > 0) {
    queueCountBadge.style.display = 'inline-block';
    queueCountBadge.textContent = `${count} Pending Sync`;
    btnViewQueue.style.display = 'inline-flex';
    btnForceSync.style.display = 'inline-flex';
  } else {
    queueCountBadge.style.display = 'none';
    btnViewQueue.style.display = 'none';
    btnForceSync.style.display = 'none';
  }
}

async function syncOfflineQueue() {
  const queuedScans = window.offlineQueue.getAll();
  if (queuedScans.length === 0) {
    showToast('Offline queue is already empty.', 'info');
    return;
  }

  updateConnectionStatus('syncing', 'Syncing Queue...');
  offlineStatusNotice.textContent = `Syncing ${queuedScans.length} offline scan(s) with Node 1...`;

  try {
    const response = await fetch(`${appConfig.serverUrl}/api/attendance/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-node-id': appConfig.deviceId,
        'x-node-role': 'SCANNER',
        'x-device-id': appConfig.deviceId
      },
      body: JSON.stringify(queuedScans)
    });

    if (response.status === 401) {
      // Preserve offline queue completely when session expires
      updateConnectionStatus('offline', 'Session Expired (Queue Saved)');
      offlineStatusNotice.textContent = `Session expired. ${queuedScans.length} scan(s) safely saved. Please log in to sync.`;
      showToast(`Session expired. ${queuedScans.length} queued scan(s) kept safe. Please log in again.`, 'error');
      if (confirm(`Your Administrator session expired while offline. Your ${queuedScans.length} queued scan(s) are safely preserved. Log in again to sync?`)) {
        window.location.href = '/login?next=/scanner';
      }
      return;
    }

    const json = await response.json();

    if (response.ok && json.ok) {
      const syncReport = json.data;
      const missingEventResults = syncReport.results.filter(r => r.status === 'EVENT_NOT_FOUND');
      const processedIds = syncReport.results
        .filter(r => r.status !== 'EVENT_NOT_FOUND')
        .map(r => r.clientScanId);

      window.offlineQueue.removeItems(processedIds);

      if (missingEventResults.length > 0) {
        const errorMap = {};
        for (const r of missingEventResults) {
          errorMap[r.clientScanId] = 'Event no longer exists';
        }
        window.offlineQueue.markErrors(errorMap);
        showToast(
          `${missingEventResults.length} scan(s) could not be synced: event no longer exists. Kept in queue for review.`,
          'error'
        );
      }

      updateQueueUI();
      updateConnectionStatus('online', 'Station Online');
      offlineStatusNotice.textContent = 'Station Mode: Synchronized with Node 1';
      offlineStatusNotice.style.color = '#ffffff';

      if (syncReport.syncedCount > 0 || missingEventResults.length === 0) {
        showToast(`Batch Sync Complete: ${syncReport.syncedCount} valid check-ins processed!`, 'success');
      }

      if (queueModal.classList.contains('open')) {
        renderQueueModal();
      }
    } else {
      throw new Error((json && json.error && json.error.message) || 'Sync failed');
    }
  } catch (err) {
    console.error('[Sync] Sync failed:', err);
    updateConnectionStatus('offline', 'OFFLINE (Queue Mode)');
    offlineStatusNotice.textContent = 'Sync failed. Will retry automatically.';
    showToast('Failed to sync queue: ' + err.message, 'error');
  }
}

function renderQueueModal() {
  const items = window.offlineQueue.getAll();
  queueItemsList.innerHTML = '';

  if (items.length === 0) {
    queueItemsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No pending scans in offline storage.</div>';
    return;
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.style.background = '#0f172a';
    div.style.padding = '0.65rem 0.85rem';
    div.style.borderRadius = '6px';
    div.style.border = item.syncError ? '1px solid #ef4444' : '1px solid #334155';
    div.style.fontSize = '0.8rem';
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.alignItems = 'center';
    div.style.gap = '0.5rem';

    const statusBadge = item.syncError
      ? `<span class="badge" style="background:#ef4444; color:#fff;">${escapeHtml(item.syncError)}</span>`
      : `<span class="badge" style="background:#f59e0b; color:#000;">PENDING</span>`;

    div.innerHTML = `
      <div>
        <strong>Scan ID:</strong> ${item.clientScanId.substring(0, 16)}...<br>
        <span style="color: var(--text-muted);">Scanned: ${item.scannedAt}</span>
      </div>
      <div style="display:flex; align-items:center; gap:0.4rem;">
        ${statusBadge}
        ${item.syncError ? `<button class="btn btn-sm btn-secondary" data-discard-id="${item.clientScanId}" style="padding:0.2rem 0.5rem; font-size:0.75rem;">Discard</button>` : ''}
      </div>
    `;

    const discardBtn = div.querySelector('[data-discard-id]');
    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        window.offlineQueue.removeItems([item.clientScanId]);
        updateQueueUI();
        renderQueueModal();
      });
    }

    queueItemsList.appendChild(div);
  }
}

// ============================================================================
// MANUAL FALLBACK & MODAL LISTENERS
// ============================================================================
function setupEventListeners() {
  btnOverlayStart.addEventListener('click', startCamera);

  btnToggleCamera.addEventListener('click', () => {
    if (isScanning) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  btnToggleTorch.addEventListener('click', toggleTorch);

  cameraSelect.addEventListener('change', () => {
    if (isScanning) {
      stopCamera().then(() => startCamera());
    }
  });

  eventSelect.addEventListener('change', (e) => {
    selectedEventId = e.target.value;
  });

  // Manual Form Fallback
  manualEntryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const schoolId = manualSchoolIdInput.value.trim();
    if (!schoolId) return;

    if (!selectedEventId) {
      showToast('Please select an active event first!', 'error');
      return;
    }

    btnSubmitManual.disabled = true;

    try {
      const response = await fetch(`${appConfig.serverUrl}/api/attendance/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': appConfig.deviceId,
          'x-node-role': 'SCANNER',
          'x-device-id': appConfig.deviceId
        },
        body: JSON.stringify({
          eventId: selectedEventId,
          schoolId
        })
      });

      if (response.status === 401) {
        // Session expired: save scan to offline queue so nothing is lost and prompt re-login
        window.offlineQueue.enqueue({ eventId: selectedEventId, qrToken, clientScanId, scannedAt });
        updateQueueUI();
        showToast('Session expired. Scan saved to offline queue. Please log in again.', 'error');
        if (confirm('Your Administrator session expired. Your scan was saved in the offline queue. Log in again now?')) {
          window.location.href = '/login?next=/scanner';
        }
        return;
      }

      const json = await response.json();

      if (response.ok && json.ok) {
        renderResultCard('valid', json.data);
        manualSchoolIdInput.value = '';
      } else if (response.status === 409) {
        renderResultCard('duplicate', json.error);
      } else {
        renderResultCard('invalid', json.error);
      }
    } catch {
      showToast('Server unreachable: Manual verification requires active Node 1 connection.', 'error');
    } finally {
      btnSubmitManual.disabled = false;
    }
  });

  // Sync buttons
  btnForceSync.addEventListener('click', () => syncOfflineQueue());
  btnSyncFromModal.addEventListener('click', () => syncOfflineQueue());

  btnViewQueue.addEventListener('click', () => {
    renderQueueModal();
    queueModal.classList.add('open');
  });

  btnCloseQueueModal.addEventListener('click', () => queueModal.classList.remove('open'));
  btnCancelQueueModal.addEventListener('click', () => queueModal.classList.remove('open'));

  // Device settings modal
  deviceBadgePill.addEventListener('click', () => {
    inputDeviceName.value = appConfig.deviceName;
    selectDeviceType.value = appConfig.deviceType;
    deviceModal.classList.add('open');
  });

  btnCloseDeviceModal.addEventListener('click', () => deviceModal.classList.remove('open'));
  btnCancelDeviceModal.addEventListener('click', () => deviceModal.classList.remove('open'));

  btnSaveDeviceModal.addEventListener('click', () => {
    const newName = inputDeviceName.value.trim();
    const newType = selectDeviceType.value;
    if (newName) {
      window.deviceManager.setDeviceName(newName);
      appConfig.deviceName = newName;
    }
    appConfig.deviceType = newType;
    localStorage.setItem('eventsync_device_type', newType);
    updateDeviceBadge();
    deviceModal.classList.remove('open');
    showToast('Device settings updated.', 'info');

    // Announce update to server
    if (socket && socket.connected) {
      socket.emit('node:heartbeat', {
        nodeId: appConfig.deviceId,
        deviceId: appConfig.deviceId,
        role: 'SCANNER',
        deviceType: appConfig.deviceType,
        deviceName: appConfig.deviceName
      });
    }
  });
}

// ============================================================================
// EVENT LIST FETCHING
// ============================================================================
async function refreshEvents(keepSelection = true) {
  try {
    const res = await fetch(`${appConfig.serverUrl}/api/events?status=OPEN`);
    const json = await res.json();
    if (res.ok && json.ok) {
      allEvents = json.data;
      eventSelect.innerHTML = '';

      if (allEvents.length === 0) {
        eventSelect.innerHTML = '<option value="">No open events</option>';
        return;
      }

      for (const ev of allEvents) {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = `${ev.title} (${ev.venue})`;
        eventSelect.appendChild(opt);
      }

      if (!keepSelection || !selectedEventId || !allEvents.some(e => e.id === selectedEventId)) {
        selectedEventId = allEvents[0].id;
      }
      eventSelect.value = selectedEventId;
    }
  } catch (err) {
    console.warn('[Events] Failed to fetch events from Node 1:', err.message);
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';

  const iconColors = {
    info: '#3b82f6',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444'
  };

  toast.innerHTML = `
    <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${iconColors[type] || '#3b82f6'};"></span>
    <span style="margin-left:8px;">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', initApp);
