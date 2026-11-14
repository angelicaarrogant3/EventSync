/**
 * EventSync - Node 4: Organizer Console & Live Monitor
 * Flexible Device-Agnostic Client Engine (Phone, Tablet, Laptop)
 */

let appConfig = {
  serverUrl: window.location.origin,
  deviceId: null,
  role: 'ORGANIZER',
  deviceType: 'laptop',
  deviceName: 'Organizer Console'
};

let socket = null;
let heartbeatInterval = null;
let currentEventId = null;
let allEvents = [];
let allNodes = [];
let currentReportAttendees = [];

// DOM Element References
const connectionPill = document.getElementById('connectionPill');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const serverUrlLabel = document.getElementById('serverUrlLabel');
const disconnectBanner = document.getElementById('disconnectBanner');
const btnReconnectNow = document.getElementById('btnReconnectNow');

// Device Identity & Missing Roles Elements
const deviceBadgePill = document.getElementById('deviceBadgePill');
const headerDeviceName = document.getElementById('headerDeviceName');
const headerDeviceTypeIcon = document.getElementById('headerDeviceTypeIcon');
const deviceModal = document.getElementById('deviceModal');
const inputDeviceName = document.getElementById('inputDeviceName');
const selectDeviceType = document.getElementById('selectDeviceType');
const btnCloseDeviceModal = document.getElementById('btnCloseDeviceModal');
const btnCancelDeviceModal = document.getElementById('btnCancelDeviceModal');
const btnSaveDeviceModal = document.getElementById('btnSaveDeviceModal');
const missingRoleBanner = document.getElementById('missingRoleBanner');
const missingRolesList = document.getElementById('missingRolesList');
const clusterStatusBadge = document.getElementById('clusterStatusBadge');

// Dashboard Elements
const dashboardEventSelect = document.getElementById('dashboardEventSelect');
const dashboardEventStatusBadge = document.getElementById('dashboardEventStatusBadge');
const btnRefreshDashboard = document.getElementById('btnRefreshDashboard');
const kpiRegistered = document.getElementById('kpiRegistered');
const kpiCheckedIn = document.getElementById('kpiCheckedIn');
const kpiRate = document.getElementById('kpiRate');
const kpiRemaining = document.getElementById('kpiRemaining');
const capacityProgressLabel = document.getElementById('capacityProgressLabel');
const capacityProgressFill = document.getElementById('capacityProgressFill');
const liveFeedList = document.getElementById('liveFeedList');
const feedCounterBadge = document.getElementById('feedCounterBadge');
const deptBarsContainer = document.getElementById('deptBarsContainer');
const hourlyTimelineContainer = document.getElementById('hourlyTimelineContainer');

// Events Tab Elements
const eventsTableBody = document.getElementById('eventsTableBody');
const toggleShowArchived = document.getElementById('toggleShowArchived');
const btnOpenCreateEventModal = document.getElementById('btnOpenCreateEventModal');
const eventModal = document.getElementById('eventModal');
const eventForm = document.getElementById('eventForm');
const eventFormError = document.getElementById('eventFormError');
const eventModalTitle = document.getElementById('eventModalTitle');
const btnCloseEventModal = document.getElementById('btnCloseEventModal');
const btnCancelEventModal = document.getElementById('btnCancelEventModal');

// Safe Delete Modal Elements
const deleteEventModal = document.getElementById('deleteEventModal');
const deleteModalEventTitle = document.getElementById('deleteModalEventTitle');
const deleteModalCounts = document.getElementById('deleteModalCounts');
const deleteNoDataSection = document.getElementById('deleteNoDataSection');
const deleteHasDataSection = document.getElementById('deleteHasDataSection');
const btnConfirmSimpleDelete = document.getElementById('btnConfirmSimpleDelete');
const btnArchiveEvent = document.getElementById('btnArchiveEvent');
const inputDeleteConfirmTitle = document.getElementById('inputDeleteConfirmTitle');
const btnConfirmForceDelete = document.getElementById('btnConfirmForceDelete');
const btnCloseDeleteModal = document.getElementById('btnCloseDeleteModal');
const btnCancelDeleteModal = document.getElementById('btnCancelDeleteModal');
let deleteTargetEvent = null;

// Nodes Tab Elements
const nodesContainer = document.getElementById('nodesContainer');
const nodesOnlineCount = document.getElementById('nodesOnlineCount');
const btnRefreshNodes = document.getElementById('btnRefreshNodes');

// Reports Tab Elements
const reportsEventSelect = document.getElementById('reportsEventSelect');
const reportsTableBody = document.getElementById('reportsTableBody');
const reportSearchInput = document.getElementById('reportSearchInput');
const reportStatusFilter = document.getElementById('reportStatusFilter');
const reportRowCountLabel = document.getElementById('reportRowCountLabel');
const btnExportCsv = document.getElementById('btnExportCsv');
const btnExportPdf = document.getElementById('btnExportPdf');

// Config Modal
const configModal = document.getElementById('configModal');
const inputServerUrl = document.getElementById('inputServerUrl');
const btnCloseConfigModal = document.getElementById('btnCloseConfigModal');
const btnCancelConfigModal = document.getElementById('btnCancelConfigModal');
const btnApplyServerUrl = document.getElementById('btnApplyServerUrl');

// ============================================================================
// INITIALIZATION & CONFIGURATION
// ============================================================================
async function initApp() {
  setupTabs();
  setupModals();
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
    appConfig.deviceName = window.deviceManager.getDeviceName('Organizer');
  } else {
    appConfig.deviceId = 'org-' + Math.random().toString(36).substring(2, 9);
  }

  updateDeviceBadge();

  // 2. Resolve server URL
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const data = await res.json();
      if (data.serverUrl && !window.location.pathname.startsWith('/organizer')) {
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

  serverUrlLabel.textContent = `(${appConfig.serverUrl.replace(/^https?:\/\//, '')})`;
  inputServerUrl.value = appConfig.serverUrl;

  // 3. Connect to cluster & load initial data
  connectSocket();
  await refreshEventsList();
  await refreshNodesList();

  // 4. Mobile Lifecycle: Wake from sleep / tab backgrounding
  if (window.deviceManager) {
    window.deviceManager.setupLifecycleListeners(async (trigger) => {
      console.log(`[Lifecycle] Organizer received ${trigger}. Refreshing cluster state...`);
      if (socket && !socket.connected) {
        socket.connect();
      }
      await refreshEventsList(false);
      await refreshNodesList();
      if (currentEventId) {
        loadEventDashboard(currentEventId);
      }
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
// SOCKET.IO REAL-TIME HUB CONNECTION
// ============================================================================
function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

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
    updateConnectionStatus('online', 'Cluster Online');
    disconnectBanner.classList.remove('visible');

    // Register node identity on Node 1 health registry
    socket.emit('node:identify', {
      nodeId: appConfig.deviceId,
      deviceId: appConfig.deviceId,
      role: 'ORGANIZER',
      deviceType: appConfig.deviceType,
      deviceName: appConfig.deviceName
    });

    startHeartbeat();
    syncOnReconnect();
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected from Node 1 Server:', reason);
    updateConnectionStatus('offline', 'Server Offline');
    disconnectBanner.classList.add('visible');
    stopHeartbeat();
  });

  socket.on('connect_error', (err) => {
    console.warn('[Socket] Connection error:', err.message);
    updateConnectionStatus('offline', 'Disconnected');
    disconnectBanner.classList.add('visible');
  });

  // REAL-TIME BROADCAST LISTENERS
  socket.on('node:status', (payload) => {
    console.log('[Socket] node:status received:', payload);
    if (payload && payload.nodes) {
      allNodes = payload.nodes;
      renderNodesGrid(allNodes, payload.summary);
    }
  });

  socket.on('registration:created', (payload) => {
    console.log('[Socket] registration:created received:', payload);
    showToast(`New registration: ${payload.participant.full_name} (${payload.participant.school_id})`, 'info');

    if (currentEventId === payload.eventId) {
      loadEventDashboard(currentEventId);
    }
    refreshEventsList(false);
  });

  socket.on('attendance:checked_in', (payload) => {
    console.log('[Socket] attendance:checked_in received:', payload);
    const syncBadge = payload.wasOfflineSync ? '[Offline Sync] ' : '';
    showToast(`${syncBadge}Check-in: ${payload.participant.fullName} (${payload.participant.schoolId})`, 'success');

    if (currentEventId === payload.eventId) {
      appendLiveFeedItem(payload);
      updateDashboardKpis(payload.stats);
      renderAnalytics(payload.stats);
    }
    refreshEventsList(false);
  });

  socket.on('event:updated', (payload) => {
    console.log('[Socket] event:updated received:', payload);
    refreshEventsList(true);
    if (currentEventId && payload && payload.event && currentEventId === payload.event.id) {
      loadEventDashboard(currentEventId);
    }
  });

  socket.on('event:deleted', (payload) => {
    console.log('[Socket] event:deleted received:', payload);
    const wasActive = currentEventId && payload && currentEventId === payload.eventId;
    if (wasActive) {
      const verb = payload.archived ? 'archived' : 'deleted';
      showToast(`Active event "${payload.title || ''}" was ${verb}.`, 'warning');
      currentEventId = null;
    }
    refreshEventsList(true);
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('node:heartbeat', {
        nodeId: appConfig.deviceId,
        deviceId: appConfig.deviceId,
        role: 'ORGANIZER',
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

async function syncOnReconnect() {
  await refreshEventsList(false);
  await refreshNodesList();
  if (currentEventId) {
    await loadEventDashboard(currentEventId);
  }
}

// ============================================================================
// REST API CLIENT
// ============================================================================
async function apiRequest(endpoint, options = {}) {
  const url = `${appConfig.serverUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-node-id': appConfig.deviceId,
    'x-node-role': 'ORGANIZER',
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
// EVENTS MANAGEMENT
// ============================================================================
async function refreshEventsList(updatePickers = true) {
  try {
    const includeArchived = toggleShowArchived && toggleShowArchived.checked ? 'true' : 'false';
    const events = await apiRequest(`/api/events?includeArchived=${includeArchived}`);
    allEvents = events;
    renderEventsTable(events);

    if (updatePickers) {
      // Pickers for active monitoring/reports prefer non-archived events
      const activeEvents = events.filter(e => !e.archived);
      populateEventPickers(activeEvents.length > 0 ? activeEvents : events);
    }
  } catch (err) {
    console.error('[Events] Error fetching events:', err.message);
  }
}

function populateEventPickers(events) {
  const currentSelected = dashboardEventSelect.value;
  dashboardEventSelect.innerHTML = '';
  reportsEventSelect.innerHTML = '';

  if (events.length === 0) {
    dashboardEventSelect.innerHTML = '<option value="">No events found</option>';
    reportsEventSelect.innerHTML = '<option value="">No events found</option>';
    return;
  }

  for (const ev of events) {
    const opt1 = document.createElement('option');
    opt1.value = ev.id;
    opt1.textContent = `${ev.title} (${ev.event_date}) - [${ev.status}]`;
    dashboardEventSelect.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = ev.id;
    opt2.textContent = `${ev.title} (${ev.event_date})`;
    reportsEventSelect.appendChild(opt2);
  }

  if (currentSelected && events.some(e => e.id === currentSelected)) {
    dashboardEventSelect.value = currentSelected;
    reportsEventSelect.value = currentSelected;
    currentEventId = currentSelected;
  } else {
    currentEventId = events[0].id;
    dashboardEventSelect.value = currentEventId;
    reportsEventSelect.value = currentEventId;
  }

  loadEventDashboard(currentEventId);
}

function renderEventsTable(events) {
  eventsTableBody.innerHTML = '';
  if (events.length === 0) {
    eventsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 2rem;">No events configured. Click "Create New Event" to begin.</td></tr>';
    return;
  }

  for (const ev of events) {
    const tr = document.createElement('tr');
    if (ev.archived) {
      tr.style.opacity = '0.72';
      tr.style.backgroundColor = '#f8fafc';
    }

    const statusBadgeClass = {
      OPEN: 'badge-open',
      CLOSED: 'badge-closed',
      DRAFT: 'badge-draft',
      ENDED: 'badge-closed'
    }[ev.status] || 'badge-draft';

    const archivedTag = ev.archived
      ? '<span class="badge badge-draft" style="margin-left:0.35rem; background:#e2e8f0; color:#475569;">ARCHIVED</span>'
      : '';

    const regCount = ev.registered_count || 0;

    tr.innerHTML = `
      <td><strong>${escapeHtml(ev.title)}</strong>${archivedTag}<br><span style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(ev.venue)}</span></td>
      <td>${ev.event_date}<br><span style="font-size: 0.8rem; color: var(--text-muted);">${ev.start_time} - ${ev.end_time}</span></td>
      <td><strong>${regCount} / ${ev.capacity}</strong></td>
      <td><strong style="color: #059669;">${ev.checked_in_count || 0}</strong></td>
      <td><span class="badge ${statusBadgeClass}">${ev.status}</span></td>
      <td>
        <div style="display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center;">
          <button class="btn btn-secondary btn-sm" style="min-height:36px;" onclick="viewEventOnDashboard('${ev.id}')">View</button>
          <button class="btn btn-secondary btn-sm" style="min-height:36px;" onclick="openEditEventModal('${ev.id}')">Edit</button>
          <select class="form-select" style="min-height:36px; width:auto; font-size:0.78rem; padding:0.2rem 0.45rem;" onchange="quickUpdateStatus('${ev.id}', this.value)" title="Change event status">
            <option value="DRAFT" ${ev.status === 'DRAFT' ? 'selected' : ''}>DRAFT</option>
            <option value="OPEN" ${ev.status === 'OPEN' ? 'selected' : ''}>OPEN</option>
            <option value="CLOSED" ${ev.status === 'CLOSED' ? 'selected' : ''}>CLOSED</option>
            <option value="ENDED" ${ev.status === 'ENDED' ? 'selected' : ''}>ENDED</option>
          </select>
          <button class="btn btn-secondary btn-sm" style="min-height:36px; color:#dc2626; border-color:#fecaca;" onclick="openDeleteEventModal('${ev.id}')">Delete</button>
        </div>
      </td>
    `;
    eventsTableBody.appendChild(tr);
  }
}

function viewEventOnDashboard(eventId) {
  currentEventId = eventId;
  if (dashboardEventSelect) dashboardEventSelect.value = eventId;
  if (reportsEventSelect) reportsEventSelect.value = eventId;
  loadEventDashboard(eventId);
  loadEventReports(eventId);

  // Switch to Live Monitor tab
  document.querySelectorAll('.tab-btn, .mobile-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'tab-dashboard');
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-dashboard');
  });
}

async function quickUpdateStatus(eventId, newStatus) {
  try {
    await apiRequest(`/api/events/${eventId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus })
    });
    showToast(`Event status updated to ${newStatus}`, 'success');
    refreshEventsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// LIVE MONITOR DASHBOARD
// ============================================================================
async function loadEventDashboard(eventId) {
  if (!eventId) return;

  try {
    const selectedEv = allEvents.find(e => e.id === eventId);
    if (selectedEv) {
      dashboardEventStatusBadge.textContent = selectedEv.status;
      dashboardEventStatusBadge.className = `badge ${selectedEv.status === 'OPEN' ? 'badge-open' : 'badge-closed'}`;
    }

    const liveData = await apiRequest(`/api/attendance/live?eventId=${eventId}`);
    updateDashboardKpis(liveData.stats);
    renderLiveFeed(liveData.recentCheckIns || []);
    renderAnalytics(liveData.stats);
  } catch (err) {
    console.error('[Dashboard] Error loading live dashboard:', err.message);
  }
}

function updateDashboardKpis(stats) {
  if (!stats) return;

  kpiRegistered.textContent = stats.registeredCount || 0;
  kpiCheckedIn.textContent = stats.checkedInCount || 0;
  kpiRate.textContent = `${stats.attendancePercentage || 0}%`;
  kpiRemaining.textContent = stats.remainingCapacity || 0;

  const cap = stats.capacity || 0;
  const occ = stats.registeredCount || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((occ / cap) * 100)) : 0;

  capacityProgressLabel.textContent = `${occ} / ${cap} Seats Filled (${pct}%)`;
  capacityProgressFill.style.width = `${pct}%`;

  if (pct >= 90) capacityProgressFill.style.background = '#ef4444';
  else if (pct >= 75) capacityProgressFill.style.background = '#f59e0b';
  else capacityProgressFill.style.background = '#10b981';
}

function renderLiveFeed(checkIns) {
  liveFeedList.innerHTML = '';
  feedCounterBadge.textContent = `${checkIns.length} recorded`;

  if (checkIns.length === 0) {
    liveFeedList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 2rem 1rem;">No check-in activity recorded yet for this event.</div>';
    return;
  }

  for (const item of checkIns) {
    appendLiveFeedItem(item, false);
  }
}

function appendLiveFeedItem(item, prepend = true) {
  const emptyNotice = liveFeedList.querySelector('div[style*="text-align: center"]');
  if (emptyNotice) emptyNotice.remove();

  const el = document.createElement('div');
  el.className = 'feed-item';

  const timeStr = item.scannedAt ? item.scannedAt.substring(11, 19) : (item.checkedInAt ? item.checkedInAt.substring(11, 19) : 'Just now');
  const syncLabel = item.wasOfflineSync
    ? `<span class="badge badge-sync">OFFLINE SYNC</span>`
    : `<span class="badge badge-realtime">LIVE</span>`;

  el.innerHTML = `
    <div class="feed-icon">&#10003;</div>
    <div class="feed-body">
      <div class="feed-title">
        ${escapeHtml(item.participant ? (item.participant.fullName || item.participant.full_name) : 'Participant')}
        ${syncLabel}
      </div>
      <div class="feed-meta">
        ${item.participant ? (item.participant.schoolId || item.participant.school_id) : ''} &bull; 
        ${item.participant ? (item.participant.departmentOrCourse || item.participant.department_or_course) : ''} &bull;
        Scanned by: <strong>${item.scannedByNode || 'Station'}</strong>
      </div>
    </div>
    <div class="feed-time">${timeStr}</div>
  `;

  if (prepend && liveFeedList.firstChild) {
    liveFeedList.insertBefore(el, liveFeedList.firstChild);
  } else {
    liveFeedList.appendChild(el);
  }
}

function renderAnalytics(stats) {
  if (!stats) return;

  // Department Breakdown Bars
  deptBarsContainer.innerHTML = '';
  if (!stats.byDepartment || stats.byDepartment.length === 0) {
    deptBarsContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No participant registrations yet.</p>';
  } else {
    for (const dept of stats.byDepartment) {
      const pct = stats.registeredCount > 0 ? Math.round((dept.registered_count / stats.registeredCount) * 100) : 0;
      const attPct = dept.registered_count > 0 ? Math.round((dept.checked_in_count / dept.registered_count) * 100) : 0;

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexDirection = 'column';
      row.style.gap = '0.2rem';

      row.innerHTML = `
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; font-weight: 600;">
          <span>${escapeHtml(dept.department)}</span>
          <span>${dept.checked_in_count}/${dept.registered_count} Present (${attPct}%)</span>
        </div>
        <div class="progress-track" style="height: 8px;">
          <div class="progress-fill" style="width: ${pct}%; background: #3b82f6;"></div>
        </div>
      `;
      deptBarsContainer.appendChild(row);
    }
  }

  // Hourly Timeline Bars
  hourlyTimelineContainer.innerHTML = '';
  if (!stats.checkInsByHour || stats.checkInsByHour.length === 0) {
    hourlyTimelineContainer.innerHTML = '<div style="width: 100%; text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 2rem 0;">No check-in timeline points recorded yet.</div>';
  } else {
    const maxVal = Math.max(...stats.checkInsByHour.map(h => h.check_in_count), 1);
    for (const slot of stats.checkInsByHour) {
      const heightPct = Math.round((slot.check_in_count / maxVal) * 80) + 20;

      const barWrap = document.createElement('div');
      barWrap.style.flex = '1';
      barWrap.style.display = 'flex';
      barWrap.style.flexDirection = 'column';
      barWrap.style.alignItems = 'center';
      barWrap.style.gap = '0.3rem';

      barWrap.innerHTML = `
        <span style="font-size: 0.7rem; font-weight: 700; color: #059669;">${slot.check_in_count}</span>
        <div style="width: 100%; max-width: 32px; height: ${heightPct}px; background: linear-gradient(180deg, #10b981, #059669); border-radius: 4px 4px 0 0;"></div>
        <span style="font-size: 0.68rem; color: var(--text-muted); font-family: monospace;">${slot.hour_slot}</span>
      `;
      hourlyTimelineContainer.appendChild(barWrap);
    }
  }
}

// ============================================================================
// CLUSTER HEALTH PANEL & MISSING-ROLES SUPERVISOR
// ============================================================================
async function refreshNodesList() {
  try {
    const summaryData = await apiRequest('/api/nodes/summary');
    allNodes = summaryData.nodes || [];
    renderNodesGrid(allNodes, summaryData.summary);
  } catch (err) {
    console.error('[Nodes] Failed to fetch nodes:', err.message);
  }
}

function renderNodesGrid(nodes, summary) {
  nodesContainer.innerHTML = '';
  const onlineCount = nodes.filter(n => n.status === 'ONLINE').length;
  nodesOnlineCount.textContent = onlineCount;

  // Handle Missing-Roles Banner
  if (summary && summary.missingRoles && summary.missingRoles.length > 0) {
    missingRoleBanner.style.display = 'flex';
    missingRolesList.textContent = summary.missingRoles.join(', ');
    if (clusterStatusBadge) {
      clusterStatusBadge.textContent = `${summary.missingRoles.length} Station(s) Offline`;
      clusterStatusBadge.className = 'badge badge-warning';
    }
  } else if (summary && summary.isClusterComplete) {
    missingRoleBanner.style.display = 'none';
    if (clusterStatusBadge) {
      clusterStatusBadge.textContent = 'All 4 Stations Synchronized';
      clusterStatusBadge.className = 'badge badge-open';
    }
  }

  const nodeRolesMap = {
    'node-1': { title: 'Node 1: Server & Database Host', desc: 'Central Single Source of Truth, Express REST API, Socket.IO hub, SQLite WAL host' },
    'node-2': { title: 'Node 2: Registration Station', desc: 'Online registration, capacity quota validation, signed QR code generation' },
    'node-3': { title: 'Node 3: Verification Station', desc: 'Webcam QR scanner, manual ID fallback, audio verification, offline queue sync' },
    'node-4': { title: 'Node 4: Organizer Console', desc: 'Live monitoring dashboard, node health supervisor, reports & CSV/PDF export' }
  };

  const deviceIcons = { phone: '📱', tablet: '📲', laptop: '💻' };

  for (const n of nodes) {
    const info = nodeRolesMap[n.node_id] || { title: n.device_name || n.node_id, desc: n.role };
    const isOnline = n.status === 'ONLINE';
    const card = document.createElement('div');
    card.className = `node-card ${isOnline ? 'online' : 'offline'}`;

    const pulseClass = isOnline ? 'online' : 'offline';
    const statusLabel = isOnline ? 'ONLINE' : 'OFFLINE';
    const devIcon = deviceIcons[n.device_type] || '💻';
    const devName = n.device_name || (n.node_id === 'node-1' ? 'Node 1 Laptop Server' : n.node_id);

    card.innerHTML = `
      <div class="node-card-header">
        <div class="node-card-title">
          <div style="display:flex; align-items:center; gap:0.4rem; margin-bottom:0.25rem;">
            <span style="font-size:1.15rem;">${devIcon}</span>
            <h3 style="margin:0;">${escapeHtml(devName)}</h3>
          </div>
          <p style="margin:0;">${info.desc}</p>
        </div>
        <span class="badge ${isOnline ? 'badge-open' : 'badge-absent'}">
          <span class="pulse-dot ${pulseClass}"></span>
          ${statusLabel}
        </span>
      </div>
      <div class="node-details-list">
        <div class="node-details-row">
          <span class="node-details-label">Assigned Role:</span>
          <span class="node-details-val"><strong>${n.role}</strong></span>
        </div>
        <div class="node-details-row">
          <span class="node-details-label">Device Type:</span>
          <span class="node-details-val" style="text-transform: capitalize;">${devIcon} ${n.device_type || 'laptop'}</span>
        </div>
        <div class="node-details-row">
          <span class="node-details-label">IP Address:</span>
          <span class="node-details-val">${n.ip_address || '127.0.0.1'}</span>
        </div>
        <div class="node-details-row">
          <span class="node-details-label">Last Heartbeat:</span>
          <span class="node-details-val">${n.last_seen || 'N/A'}</span>
        </div>
        <div class="node-details-row">
          <span class="node-details-label">Heartbeat Age:</span>
          <span class="node-details-val">${n.seconds_since_last_seen !== undefined ? `${n.seconds_since_last_seen}s ago` : 'Active'}</span>
        </div>
      </div>
    `;

    nodesContainer.appendChild(card);
  }
}

// ============================================================================
// ATTENDANCE REPORTS & ROSTER
// ============================================================================
async function loadEventReports(eventId) {
  if (!eventId) return;

  try {
    const reportData = await apiRequest(`/api/events/${eventId}/report?format=json`);
    currentReportAttendees = reportData.attendees || [];
    filterAndRenderReportsTable();
  } catch (err) {
    console.error('[Reports] Error loading reports:', err.message);
  }
}

function filterAndRenderReportsTable() {
  const searchTerm = (reportSearchInput.value || '').toLowerCase().trim();
  const statusFilter = reportStatusFilter.value;

  const filtered = currentReportAttendees.filter(item => {
    if (statusFilter !== 'ALL' && item.status !== statusFilter) {
      return false;
    }
    if (searchTerm) {
      const matchSchoolId = item.school_id.toLowerCase().includes(searchTerm);
      const matchName = item.full_name.toLowerCase().includes(searchTerm);
      const matchDept = item.department_or_course.toLowerCase().includes(searchTerm);
      return matchSchoolId || matchName || matchDept;
    }
    return true;
  });

  reportRowCountLabel.textContent = `${filtered.length} of ${currentReportAttendees.length} records`;
  renderReportsTable(filtered);
}

function renderReportsTable(attendees) {
  reportsTableBody.innerHTML = '';
  if (attendees.length === 0) {
    reportsTableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 2rem;">No matching participants found.</td></tr>';
    return;
  }

  for (const item of attendees) {
    const tr = document.createElement('tr');
    const isPresent = item.status === 'PRESENT';
    const statusBadge = isPresent
      ? `<span class="badge badge-present">PRESENT</span>`
      : `<span class="badge badge-absent">ABSENT</span>`;

    const syncMode = isPresent
      ? (item.was_offline_sync ? '<span class="badge badge-sync">OFFLINE SYNC</span>' : '<span class="badge badge-realtime">REAL-TIME</span>')
      : '<span style="color: var(--text-light);">-</span>';

    const checkInTime = item.checked_in_at ? item.checked_in_at.substring(11, 19) : '-';

    tr.innerHTML = `
      <td><strong>${escapeHtml(item.school_id)}</strong></td>
      <td>${escapeHtml(item.full_name)}<br><span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(item.email)}</span></td>
      <td>${escapeHtml(item.department_or_course)}</td>
      <td>${escapeHtml(item.year_level)} &bull; <strong>${escapeHtml(item.role)}</strong></td>
      <td>${statusBadge}</td>
      <td><span style="font-family: monospace;">${checkInTime}</span></td>
      <td>${item.scanned_by_node || '-'}</td>
      <td>${syncMode}</td>
    `;
    reportsTableBody.appendChild(tr);
  }
}

// ============================================================================
// MODALS & EVENT HANDLERS
// ============================================================================
function setupTabs() {
  const switchTab = (targetId) => {
    document.querySelectorAll('.tab-btn, .mobile-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === targetId);
    });
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === targetId);
    });

    if (targetId === 'tab-nodes') {
      refreshNodesList();
    } else if (targetId === 'tab-reports') {
      loadEventReports(reportsEventSelect.value);
    }
  };

  document.querySelectorAll('.tab-btn, .mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function setupModals() {
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
      const newName = (inputDeviceName.value || '').trim() || 'Organizer Console';
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

      if (socket && socket.connected) {
        socket.emit('node:identify', {
          nodeId: appConfig.deviceId,
          deviceId: appConfig.deviceId,
          role: 'ORGANIZER',
          deviceType: appConfig.deviceType,
          deviceName: appConfig.deviceName
        });
      }
    });
  }

  // Create / Edit Event Modal
  btnOpenCreateEventModal.addEventListener('click', () => {
    openCreateEventModal();
  });
  btnCloseEventModal.addEventListener('click', () => eventModal.classList.remove('open'));
  btnCancelEventModal.addEventListener('click', () => eventModal.classList.remove('open'));

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (eventFormError) {
      eventFormError.style.display = 'none';
      eventFormError.textContent = '';
    }

    const eventId = document.getElementById('formEventId').value;
    const existingEv = eventId ? allEvents.find(ev => ev.id === eventId) : null;

    const payload = {
      title: document.getElementById('formTitle').value.trim(),
      description: document.getElementById('formDescription').value.trim(),
      venue: document.getElementById('formVenue').value.trim(),
      event_date: document.getElementById('formDate').value,
      start_time: document.getElementById('formStartTime').value,
      end_time: document.getElementById('formEndTime').value,
      capacity: parseInt(document.getElementById('formCapacity').value, 10),
      status: document.getElementById('formStatus').value
    };

    // Client-side validation
    const showFormError = (msg) => {
      if (eventFormError) {
        eventFormError.textContent = msg;
        eventFormError.style.display = 'block';
      }
      showToast(msg, 'error');
    };

    if (!existingEv || existingEv.status !== 'ENDED') {
      if (!payload.title) return showFormError('Event title is required.');
      if (!payload.venue) return showFormError('Event venue is required.');
      if (!payload.event_date) return showFormError('Event date is required.');
      if (!payload.start_time || !payload.end_time) return showFormError('Start and end times are required.');
      if (payload.end_time <= payload.start_time) return showFormError('End time must be after start time.');
      if (!Number.isInteger(payload.capacity) || payload.capacity < 1) return showFormError('Capacity must be at least 1.');
      if (existingEv && payload.capacity < (existingEv.registered_count || 0)) {
        return showFormError(`Capacity (${payload.capacity}) cannot be lower than registered participants (${existingEv.registered_count}).`);
      }
    }

    try {
      if (eventId) {
        // For ENDED events, send only notes/description
        const updateBody = existingEv && existingEv.status === 'ENDED'
          ? { description: payload.description }
          : payload;

        await apiRequest(`/api/events/${eventId}`, {
          method: 'PUT',
          body: JSON.stringify(updateBody)
        });
        showToast('Event updated successfully', 'success');
      } else {
        await apiRequest('/api/events', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        showToast('Event created successfully', 'success');
      }
      eventModal.classList.remove('open');
      refreshEventsList();
    } catch (err) {
      showFormError(err.message);
    }
  });

  // Safe Delete / Archive Modal
  if (btnCloseDeleteModal) btnCloseDeleteModal.addEventListener('click', () => deleteEventModal.classList.remove('open'));
  if (btnCancelDeleteModal) btnCancelDeleteModal.addEventListener('click', () => deleteEventModal.classList.remove('open'));

  if (inputDeleteConfirmTitle) {
    inputDeleteConfirmTitle.addEventListener('input', () => {
      if (!deleteTargetEvent) return;
      const matches = inputDeleteConfirmTitle.value.trim() === deleteTargetEvent.title;
      btnConfirmForceDelete.disabled = !matches;
      btnConfirmForceDelete.style.opacity = matches ? '1' : '0.5';
    });
  }

  if (btnConfirmSimpleDelete) {
    btnConfirmSimpleDelete.addEventListener('click', async () => {
      if (!deleteTargetEvent) return;
      try {
        await apiRequest(`/api/events/${deleteTargetEvent.id}`, { method: 'DELETE' });
        showToast(`Event "${deleteTargetEvent.title}" deleted.`, 'success');
        deleteEventModal.classList.remove('open');
        refreshEventsList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  if (btnArchiveEvent) {
    btnArchiveEvent.addEventListener('click', async () => {
      if (!deleteTargetEvent) return;
      try {
        await apiRequest(`/api/events/${deleteTargetEvent.id}?archive=true`, { method: 'DELETE' });
        showToast(`Event "${deleteTargetEvent.title}" archived. Data preserved.`, 'success');
        deleteEventModal.classList.remove('open');
        refreshEventsList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  if (btnConfirmForceDelete) {
    btnConfirmForceDelete.addEventListener('click', async () => {
      if (!deleteTargetEvent) return;
      try {
        await apiRequest(`/api/events/${deleteTargetEvent.id}?force=true`, { method: 'DELETE' });
        showToast(`Event "${deleteTargetEvent.title}" and all its data permanently deleted.`, 'success');
        deleteEventModal.classList.remove('open');
        refreshEventsList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Config Modal
  connectionPill.addEventListener('click', () => configModal.classList.add('open'));
  btnCloseConfigModal.addEventListener('click', () => configModal.classList.remove('open'));
  btnCancelConfigModal.addEventListener('click', () => configModal.classList.remove('open'));

  btnApplyServerUrl.addEventListener('click', () => {
    const newUrl = inputServerUrl.value.trim();
    if (!newUrl) return;
    appConfig.serverUrl = newUrl;
    localStorage.setItem('eventsync_server_url', newUrl);
    serverUrlLabel.textContent = `(${newUrl.replace(/^https?:\/\//, '')})`;
    configModal.classList.remove('open');
    showToast(`Connecting to Node 1 at ${newUrl}...`, 'info');
    connectSocket();
    syncOnReconnect();
  });

  btnReconnectNow.addEventListener('click', () => {
    connectSocket();
    syncOnReconnect();
  });
}

function setEventFormDisabledForEnded(isEnded) {
  const fields = ['formTitle', 'formVenue', 'formDate', 'formStartTime', 'formEndTime', 'formCapacity', 'formStatus'];
  for (const id of fields) {
    const el = document.getElementById(id);
    if (el) el.disabled = isEnded;
  }
}

function openCreateEventModal() {
  eventModalTitle.textContent = 'Create University Event';
  document.getElementById('formEventId').value = '';
  eventForm.reset();
  setEventFormDisabledForEnded(false);
  if (eventFormError) {
    eventFormError.style.display = 'none';
    eventFormError.textContent = '';
  }

  const today = new Date().toISOString().substring(0, 10);
  document.getElementById('formDate').value = today;
  document.getElementById('formCapacity').value = '50';
  document.getElementById('formStartTime').value = '09:00';
  document.getElementById('formEndTime').value = '16:00';
  document.getElementById('formStatus').value = 'OPEN';

  eventModal.classList.add('open');
}

function openEditEventModal(id) {
  const ev = allEvents.find(e => e.id === id);
  if (!ev) return;

  eventModalTitle.textContent = 'Edit University Event';
  document.getElementById('formEventId').value = ev.id;
  document.getElementById('formTitle').value = ev.title;
  document.getElementById('formDescription').value = ev.description || '';
  document.getElementById('formVenue').value = ev.venue;
  document.getElementById('formDate').value = ev.event_date;
  document.getElementById('formStartTime').value = ev.start_time;
  document.getElementById('formEndTime').value = ev.end_time;
  document.getElementById('formCapacity').value = ev.capacity;
  document.getElementById('formStatus').value = ev.status;

  const isEnded = ev.status === 'ENDED';
  setEventFormDisabledForEnded(isEnded);
  if (eventFormError) {
    if (isEnded) {
      eventFormError.textContent = 'This event has ENDED. Only notes/description may be edited.';
      eventFormError.style.display = 'block';
    } else {
      eventFormError.style.display = 'none';
      eventFormError.textContent = '';
    }
  }

  eventModal.classList.add('open');
}

function openDeleteEventModal(id) {
  const ev = allEvents.find(e => e.id === id);
  if (!ev || !deleteEventModal) return;

  deleteTargetEvent = ev;
  const regCount = ev.registered_count || 0;
  const attCount = ev.checked_in_count || 0;

  deleteModalEventTitle.textContent = ev.title;
  deleteModalCounts.innerHTML = `
    <strong>Impact Summary:</strong> ${regCount} registration(s) &bull; ${attCount} check-in(s)
  `;

  if (regCount === 0 && attCount === 0) {
    deleteNoDataSection.style.display = 'block';
    deleteHasDataSection.style.display = 'none';
  } else {
    deleteNoDataSection.style.display = 'none';
    deleteHasDataSection.style.display = 'flex';
    if (inputDeleteConfirmTitle) inputDeleteConfirmTitle.value = '';
    if (btnConfirmForceDelete) {
      btnConfirmForceDelete.disabled = true;
      btnConfirmForceDelete.style.opacity = '0.5';
    }
  }

  deleteEventModal.classList.add('open');
}

function setupEventListeners() {
  dashboardEventSelect.addEventListener('change', (e) => {
    currentEventId = e.target.value;
    reportsEventSelect.value = currentEventId;
    loadEventDashboard(currentEventId);
    loadEventReports(currentEventId);
  });

  reportsEventSelect.addEventListener('change', (e) => {
    currentEventId = e.target.value;
    dashboardEventSelect.value = currentEventId;
    loadEventDashboard(currentEventId);
    loadEventReports(currentEventId);
  });

  btnRefreshDashboard.addEventListener('click', () => {
    if (currentEventId) loadEventDashboard(currentEventId);
  });

  if (toggleShowArchived) {
    toggleShowArchived.addEventListener('change', () => {
      refreshEventsList(false);
    });
  }

  btnRefreshNodes.addEventListener('click', () => {
    refreshNodesList();
  });

  reportSearchInput.addEventListener('input', () => {
    filterAndRenderReportsTable();
  });

  reportStatusFilter.addEventListener('change', () => {
    filterAndRenderReportsTable();
  });

  // Export CSV
  btnExportCsv.addEventListener('click', () => {
    if (!currentEventId) return;
    const downloadUrl = `${appConfig.serverUrl}/api/events/${currentEventId}/report?format=csv`;
    window.open(downloadUrl, '_blank');
  });

  // Export PDF
  btnExportPdf.addEventListener('click', () => {
    if (!currentEventId) return;
    const downloadUrl = `${appConfig.serverUrl}/api/events/${currentEventId}/report?format=pdf`;
    window.open(downloadUrl, '_blank');
  });
}

// ============================================================================
// TOAST NOTIFICATIONS & UTILITIES
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
  }, 4000);
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

window.viewEventOnDashboard = viewEventOnDashboard;
window.openEditEventModal = openEditEventModal;
window.openDeleteEventModal = openDeleteEventModal;
window.quickUpdateStatus = quickUpdateStatus;

document.addEventListener('DOMContentLoaded', initApp);
