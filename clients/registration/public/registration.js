/**
 * EventSync - Node 2: Registration Station & QR Generator
 * Flexible Device-Agnostic Client Engine (Phone, Tablet, Laptop)
 */

let appConfig = {
  serverUrl: window.location.origin,
  deviceId: null,
  role: 'REGISTRATION',
  deviceType: 'laptop',
  deviceName: 'Registration Station'
};

let socket = null;
let heartbeatInterval = null;
let selectedEventId = null;
let allEvents = [];
let currentIssuedTicket = null;

// DOM Elements
const connectionPill = document.getElementById('connectionPill');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const disconnectBanner = document.getElementById('disconnectBanner');
const btnRetryConnection = document.getElementById('btnRetryConnection');

// Device Badge & Modal
const deviceBadgePill = document.getElementById('deviceBadgePill');
const headerDeviceName = document.getElementById('headerDeviceName');
const headerDeviceTypeIcon = document.getElementById('headerDeviceTypeIcon');
const deviceModal = document.getElementById('deviceModal');
const inputDeviceName = document.getElementById('inputDeviceName');
const selectDeviceType = document.getElementById('selectDeviceType');
const btnCloseDeviceModal = document.getElementById('btnCloseDeviceModal');
const btnCancelDeviceModal = document.getElementById('btnCancelDeviceModal');
const btnSaveDeviceModal = document.getElementById('btnSaveDeviceModal');

// Event Browser Elements
const eventsGrid = document.getElementById('eventsGrid');
const btnRefreshEvents = document.getElementById('btnRefreshEvents');

// Form Elements
const registrationForm = document.getElementById('registrationForm');
const btnSubmitRegistration = document.getElementById('btnSubmitRegistration');
const inputSchoolId = document.getElementById('inputSchoolId');
const inputFullName = document.getElementById('inputFullName');
const inputEmail = document.getElementById('inputEmail');
const inputDepartment = document.getElementById('inputDepartment');
const inputYearLevel = document.getElementById('inputYearLevel');
const inputRole = document.getElementById('inputRole');

// Ticket Elements
const ticketEmptyPlaceholder = document.getElementById('ticketEmptyPlaceholder');
const printableTicketSection = document.getElementById('printableTicketSection');
const ticketEventTitle = document.getElementById('ticketEventTitle');
const ticketEventMeta = document.getElementById('ticketEventMeta');
const ticketQrImg = document.getElementById('ticketQrImg');
const ticketParticipantName = document.getElementById('ticketParticipantName');
const ticketSchoolId = document.getElementById('ticketSchoolId');
const ticketDept = document.getElementById('ticketDept');
const ticketRole = document.getElementById('ticketRole');
const ticketTokenShort = document.getElementById('ticketTokenShort');
const btnShareTicket = document.getElementById('btnShareTicket');
const btnDownloadQr = document.getElementById('btnDownloadQr');
const btnPrintTicket = document.getElementById('btnPrintTicket');

// Lookup Modal
const lookupModal = document.getElementById('lookupModal');
const lookupForm = document.getElementById('lookupForm');
const lookupEventSelect = document.getElementById('lookupEventSelect');
const lookupSchoolId = document.getElementById('lookupSchoolId');
const btnOpenLookupModal = document.getElementById('btnOpenLookupModal');
const btnCloseLookupModal = document.getElementById('btnCloseLookupModal');
const btnCancelLookupModal = document.getElementById('btnCancelLookupModal');

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initApp() {
  setupEventListeners();

  // Register PWA Service Worker if available
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  }

  // 1. Initialize persistent device identity
  if (window.deviceManager) {
    appConfig.deviceId = window.deviceManager.getDeviceId();
    appConfig.deviceType = window.deviceManager.detectDeviceType();
    appConfig.deviceName = window.deviceManager.getDeviceName('Registration');
  } else {
    appConfig.deviceId = 'reg-' + Math.random().toString(36).substring(2, 9);
  }

  updateDeviceBadge();

  // 2. Check if running standalone on custom port or same-origin
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const data = await res.json();
      if (data.serverUrl && !window.location.pathname.startsWith('/registration')) {
        appConfig.serverUrl = data.serverUrl;
      }
    }
  } catch {
    appConfig.serverUrl = window.location.origin;
  }

  const savedUrl = localStorage.getItem('eventsync_server_url');
  if (savedUrl) {
    appConfig.serverUrl = savedUrl;
  }

  // 3. Connect to cluster & fetch open events
  connectSocket();
  await refreshEvents();

  // 4. Lifecycle listeners: Wake from sleep / tab backgrounding
  if (window.deviceManager) {
    window.deviceManager.setupLifecycleListeners(async (trigger) => {
      console.log(`[Lifecycle] Registration station woke up (${trigger}). Refreshing open events...`);
      if (socket && !socket.connected) {
        socket.connect();
      }
      await refreshEvents();
    });
  }
}

function updateDeviceBadge() {
  if (headerDeviceName) headerDeviceName.textContent = appConfig.deviceName;
  if (headerDeviceTypeIcon) {
    const icons = { phone: '📱', tablet: '📲', laptop: '💻' };
    headerDeviceTypeIcon.textContent = icons[appConfig.deviceType] || '💻';
  }
}

// ============================================================================
// SOCKET.IO REAL-TIME HUB
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
    updateConnectionStatus('online', 'Station Online');
    disconnectBanner.classList.remove('visible');
    btnSubmitRegistration.disabled = false;

    // Announce device identity & role to cluster
    socket.emit('node:identify', {
      nodeId: appConfig.deviceId,
      deviceId: appConfig.deviceId,
      role: 'REGISTRATION',
      deviceType: appConfig.deviceType,
      deviceName: appConfig.deviceName
    });

    startHeartbeat();
    refreshEvents();
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from Node 1 Server:', reason);
    updateConnectionStatus('offline', 'Server Offline');
    disconnectBanner.classList.add('visible');
    // Disable registration when central server is down to prevent capacity race conditions
    btnSubmitRegistration.disabled = true;
    stopHeartbeat();
  });

  socket.on('connect_error', () => {
    updateConnectionStatus('offline', 'Disconnected');
    disconnectBanner.classList.add('visible');
    btnSubmitRegistration.disabled = true;
  });

  // REAL-TIME CAPACITY UPDATES
  socket.on('registration:created', (payload) => {
    console.log('[Socket] registration:created received:', payload);
    // Dynamically update the slot counter on the event card without reloading the page
    updateEventRemainingCapacity(payload.eventId, payload.remainingCapacity);
  });

  socket.on('event:updated', () => {
    refreshEvents(true);
  });

  socket.on('event:deleted', (payload) => {
    console.log('[Socket] event:deleted received:', payload);
    if (selectedEventId && payload && payload.eventId === selectedEventId) {
      const verb = payload.archived ? 'archived' : 'deleted';
      selectedEventId = null;
      showToast(`The selected event "${payload.title || ''}" was ${verb}. Please choose another event.`, 'warning');
      if (eventsGrid) {
        eventsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      refreshEvents(false);
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
        role: 'REGISTRATION',
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
  if (statusDot) statusDot.className = 'pulse-dot ' + state;
  if (statusText) statusText.textContent = text;
}

// ============================================================================
// REST API CALLS
// ============================================================================
async function apiRequest(endpoint, options = {}) {
  const url = `${appConfig.serverUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-node-id': appConfig.deviceId,
    'x-node-role': 'REGISTRATION',
    'x-device-type': appConfig.deviceType,
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  const json = await response.json();

  if (!response.ok || !json.ok) {
    const errorMsg = (json && json.error && json.error.message) || `HTTP error ${response.status}`;
    const err = new Error(errorMsg);
    err.code = (json && json.error && json.error.code) || 'API_ERROR';
    throw err;
  }

  return json.data;
}

// ============================================================================
// EVENT SELECTION & RENDERING
// ============================================================================
async function refreshEvents(keepSelection = true) {
  try {
    const events = await apiRequest('/api/events');
    // Only open events can accept registrations
    allEvents = events.filter(e => e.status === 'OPEN');
    renderEventsGrid(allEvents, keepSelection);
    populateLookupEventSelect(allEvents);
  } catch (err) {
    console.error('[Events] Failed to fetch events:', err.message);
  }
}

function renderEventsGrid(events, keepSelection = true) {
  eventsGrid.innerHTML = '';
  if (events.length === 0) {
    eventsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: var(--text-muted);">No open events accepting registrations at this moment.</div>';
    return;
  }

  // Preserve previous selection if valid
  if (!keepSelection || !selectedEventId || !events.some(e => e.id === selectedEventId)) {
    selectedEventId = events[0].id;
  }

  for (const ev of events) {
    const card = document.createElement('div');
    const isFull = ev.remaining_capacity <= 0;
    const isSelected = ev.id === selectedEventId;

    card.className = `event-card ${isSelected ? 'selected' : ''} ${isFull ? 'full' : ''}`;
    card.dataset.id = ev.id;

    let slotClass = 'slots-count';
    if (isFull) slotClass += ' zero';
    else if (ev.remaining_capacity <= 5) slotClass += ' low';

    card.innerHTML = `
      <div class="event-card-header">
        <div class="event-card-title">${escapeHtml(ev.title)}</div>
        <div class="event-card-meta">
          <span><strong>Venue:</strong> ${escapeHtml(ev.venue)}</span>
          <span><strong>Date:</strong> ${ev.event_date} &bull; ${ev.start_time} - ${ev.end_time}</span>
        </div>
      </div>
      <div class="capacity-badge-row">
        <span style="font-size:0.8rem; color:var(--text-muted);">Available Slots:</span>
        <span class="${slotClass}" id="event-slots-${ev.id}">
          ${isFull ? 'EVENT FULL (0 Seats)' : `${ev.remaining_capacity} / ${ev.capacity} Seats Available`}
        </span>
      </div>
    `;

    card.addEventListener('click', () => {
      if (isFull) {
        showToast('This event is at full capacity. Please choose another event.', 'error');
        return;
      }
      selectEvent(ev.id);
    });

    eventsGrid.appendChild(card);
  }
}

function selectEvent(eventId) {
  selectedEventId = eventId;
  document.querySelectorAll('.event-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.id === eventId);
  });
}

function updateEventRemainingCapacity(eventId, remaining) {
  const slotEl = document.getElementById(`event-slots-${eventId}`);
  if (slotEl) {
    const ev = allEvents.find(e => e.id === eventId);
    if (ev) {
      ev.remaining_capacity = remaining;
      const isFull = remaining <= 0;
      slotEl.textContent = isFull ? 'EVENT FULL (0 Seats)' : `${remaining} / ${ev.capacity} Seats Available`;
      slotEl.className = isFull ? 'slots-count zero' : (remaining <= 5 ? 'slots-count low' : 'slots-count');
      const card = document.querySelector(`.event-card[data-id="${eventId}"]`);
      if (card) {
        card.classList.toggle('full', isFull);
      }
    }
  }
}

function populateLookupEventSelect(events) {
  lookupEventSelect.innerHTML = '';
  for (const ev of events) {
    const opt = document.createElement('option');
    opt.value = ev.id;
    opt.textContent = ev.title;
    lookupEventSelect.appendChild(opt);
  }
}

// ============================================================================
// REGISTRATION FORM SUBMISSION
// ============================================================================
function setupEventListeners() {
  btnRefreshEvents.addEventListener('click', () => refreshEvents(true));

  // Device settings modal
  if (deviceBadgePill) {
    deviceBadgePill.addEventListener('click', () => {
      if (inputDeviceName) inputDeviceName.value = appConfig.deviceName;
      if (selectDeviceType) selectDeviceType.value = appConfig.deviceType;
      if (deviceModal) deviceModal.classList.add('open');
    });
  }

  if (btnCloseDeviceModal) btnCloseDeviceModal.addEventListener('click', () => deviceModal.classList.remove('open'));
  if (btnCancelDeviceModal) btnCancelDeviceModal.addEventListener('click', () => deviceModal.classList.remove('open'));

  if (btnSaveDeviceModal) {
    btnSaveDeviceModal.addEventListener('click', () => {
      const newName = (inputDeviceName.value || '').trim() || 'Registration Station';
      const newType = selectDeviceType.value || 'laptop';

      appConfig.deviceName = newName;
      appConfig.deviceType = newType;

      if (window.deviceManager) {
        window.deviceManager.setDeviceName(newName);
        window.deviceManager.setDeviceType(newType);
      }

      updateDeviceBadge();
      deviceModal.classList.remove('open');
      showToast(`Device updated: ${newName} (${newType})`, 'success');

      // Re-announce to server
      if (socket && socket.connected) {
        socket.emit('node:identify', {
          nodeId: appConfig.deviceId,
          deviceId: appConfig.deviceId,
          role: 'REGISTRATION',
          deviceType: appConfig.deviceType,
          deviceName: appConfig.deviceName
        });
      }
    });
  }

  const chkAcc = document.getElementById('chkCreateAccount');
  const tempWrap = document.getElementById('tempPasswordWrap');
  const tempInp = document.getElementById('inputTempPassword');
  if (chkAcc && tempWrap) {
    chkAcc.addEventListener('change', () => {
      tempWrap.style.display = chkAcc.checked ? 'block' : 'none';
      if (tempInp) tempInp.required = chkAcc.checked;
    });
  }

  // Form submission
  registrationForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!selectedEventId) {
      showToast('Please select an event first.', 'error');
      return;
    }

    const chkCreateAccount = document.getElementById('chkCreateAccount');
    const inputTempPassword = document.getElementById('inputTempPassword');
    const createAccount = Boolean(chkCreateAccount && chkCreateAccount.checked);
    const tempPassword = inputTempPassword ? inputTempPassword.value : '';

    const payload = {
      eventId: selectedEventId,
      createAccount,
      tempPassword: createAccount ? tempPassword : null,
      participant: {
        school_id: inputSchoolId.value.trim(),
        full_name: inputFullName.value.trim(),
        email: inputEmail.value.trim(),
        department_or_course: inputDepartment.value.trim(),
        year_level: inputYearLevel.value.trim(),
        role: inputRole.value
      }
    };

    btnSubmitRegistration.disabled = true;
    btnSubmitRegistration.textContent = 'Processing Registration...';

    try {
      const result = await apiRequest('/api/registrations', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      showToast(`Registration Successful for ${result.participant.full_name}!`, 'success');
      displayIssuedTicket(result);

      // Reset form but keep school ID or clear smoothly
      inputFullName.value = '';
      inputEmail.value = '';
      inputDepartment.value = '';
      inputYearLevel.value = '';

      // Update remaining slots in UI immediately
      updateEventRemainingCapacity(selectedEventId, result.remainingCapacity);
    } catch (err) {
      if (err.code === 'ALREADY_REGISTERED') {
        showToast(`Participant with ID '${payload.participant.school_id}' is already registered for this event. Use 'Find Ticket' to view pass.`, 'warning');
      } else if (err.code === 'EVENT_FULL') {
        showToast('Registration failed: Event is at full capacity!', 'error');
      } else {
        showToast(err.message, 'error');
      }
    } finally {
      btnSubmitRegistration.disabled = false;
      btnSubmitRegistration.innerHTML = 'Complete Registration & Generate QR Ticket';
    }
  });

  // Ticket actions
  if (btnShareTicket) {
    btnShareTicket.addEventListener('click', async () => {
      if (!currentIssuedTicket || !currentIssuedTicket.qrDataUrl) {
        showToast('No active ticket to share', 'warning');
        return;
      }
      const participant = currentIssuedTicket.participant || {};
      const event = currentIssuedTicket.event || {};
      const schoolId = participant.school_id || participant.schoolId || 'ticket';

      if (window.deviceManager && window.deviceManager.shareOrDownload) {
        const shared = await window.deviceManager.shareOrDownload({
          title: `EventSync Pass: ${event.title || 'Event Pass'}`,
          text: `Official Event Pass for ${participant.full_name || 'Participant'} (${schoolId}) - ${event.title || ''}`,
          url: window.location.href,
          dataUrl: currentIssuedTicket.qrDataUrl,
          filename: `EventSync-Pass-${schoolId}.png`
        });
        if (shared) {
          showToast('Share sheet opened!', 'success');
        } else {
          showToast('Pass image downloaded to your device.', 'success');
        }
      }
    });
  }

  btnDownloadQr.addEventListener('click', () => {
    if (!currentIssuedTicket || !currentIssuedTicket.qrDataUrl) return;
    const participant = currentIssuedTicket.participant || {};
    const schoolId = participant.school_id || participant.schoolId || 'ticket';
    const a = document.createElement('a');
    a.href = currentIssuedTicket.qrDataUrl;
    a.download = `EventSync-QR-${schoolId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  btnPrintTicket.addEventListener('click', () => {
    window.print();
  });

  // Lookup modal
  btnOpenLookupModal.addEventListener('click', () => lookupModal.classList.add('open'));
  btnCloseLookupModal.addEventListener('click', () => lookupModal.classList.remove('open'));
  btnCancelLookupModal.addEventListener('click', () => lookupModal.classList.remove('open'));

  lookupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const eventId = lookupEventSelect.value;
    const schoolId = lookupSchoolId.value.trim();

    try {
      const result = await apiRequest(`/api/registrations/lookup?eventId=${eventId}&schoolId=${encodeURIComponent(schoolId)}`);
      lookupModal.classList.remove('open');
      showToast(`Ticket found for ${result.full_name}!`, 'success');

      displayIssuedTicket({
        event: {
          title: result.event_title,
          venue: result.event_venue,
          event_date: result.event_date,
          start_time: result.start_time,
          end_time: result.end_time
        },
        participant: {
          school_id: result.school_id,
          full_name: result.full_name,
          department_or_course: result.department_or_course,
          role: result.role
        },
        registration: {
          qrToken: result.qr_token
        },
        qrDataUrl: result.qrDataUrl
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  btnRetryConnection.addEventListener('click', () => {
    connectSocket();
    refreshEvents();
  });
}

// ============================================================================
// TICKET DISPLAY
// ============================================================================
function displayIssuedTicket(data) {
  currentIssuedTicket = data;

  const event = data.event || {};
  const participant = data.participant || {};
  const reg = data.registration || {};

  ticketEventTitle.textContent = event.title || 'University Event';
  ticketEventMeta.textContent = `${event.venue || ''} | ${event.event_date || ''} (${event.start_time || ''} - ${event.end_time || ''})`;

  ticketQrImg.src = data.qrDataUrl;
  ticketParticipantName.textContent = participant.full_name || participant.fullName;
  ticketSchoolId.textContent = participant.school_id || participant.schoolId;
  ticketDept.textContent = participant.department_or_course || participant.departmentOrCourse;
  ticketRole.textContent = participant.role || 'STUDENT';

  const tokenStr = reg.qrToken || reg.qr_token || '';
  ticketTokenShort.textContent = tokenStr ? `${tokenStr.substring(0, 20)}...` : '';

  ticketEmptyPlaceholder.style.display = 'none';
  printableTicketSection.style.display = 'block';

  // Scroll ticket into view smoothly on mobile/small laptops
  printableTicketSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================================
// TOAST NOTIFICATIONS & UTILS
// ============================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
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
    <span>${escapeHtml(message)}</span>
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
