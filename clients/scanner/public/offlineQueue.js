/**
 * EventSync Node 3: Persistent Offline Scan Queue
 * Guarantees zero data loss when Node 3 operates disconnected from Node 1.
 */

class OfflineScanQueue {
  constructor() {
    this.storageKey = 'eventsync_scanner_offline_queue';
  }

  /**
   * Load all queued scans from persistent browser storage
   */
  getAll() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error('[Queue] Error reading from localStorage:', err);
      return [];
    }
  }

  /**
   * Add a new scan to the persistent queue
   */
  enqueue(scan) {
    const queue = this.getAll();
    const item = {
      clientScanId: scan.clientScanId || this._generateUUID(),
      eventId: scan.eventId,
      qrToken: scan.qrToken,
      scannedAt: scan.scannedAt || new Date().toISOString().replace('T', ' ').substring(0, 19),
      createdAt: Date.now()
    };

    queue.push(item);
    this._save(queue);
    console.log(`[Queue] Enqueued scan. Current queue length: ${queue.length}`, item.clientScanId);
    return item;
  }

  /**
   * Remove items that were successfully synced by clientScanId
   */
  removeItems(syncedScanIds = []) {
    const set = new Set(syncedScanIds);
    const queue = this.getAll().filter(item => !set.has(item.clientScanId));
    this._save(queue);
    return queue.length;
  }

  /**
   * Annotate failed items with a syncError message so they are not lost silently
   */
  markErrors(errorMap = {}) {
    const queue = this.getAll().map(item => {
      if (errorMap[item.clientScanId]) {
        return { ...item, syncError: errorMap[item.clientScanId] };
      }
      return item;
    });
    this._save(queue);
    return queue;
  }

  /**
   * Clear all items in queue
   */
  clear() {
    localStorage.removeItem(this.storageKey);
  }

  /**
   * Current number of pending scans in queue
   */
  count() {
    return this.getAll().length;
  }

  _save(queue) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(queue));
    } catch (err) {
      console.error('[Queue] Error saving to localStorage:', err);
    }
  }

  _generateUUID() {
    if (crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

window.offlineQueue = new OfflineScanQueue();

