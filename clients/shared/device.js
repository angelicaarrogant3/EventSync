/**
 * EventSync: Shared Device Identity, Hardware & Mobile Lifecycle Utilities
 * Device-agnostic client engine running across phones, tablets, and laptops.
 */

class DeviceManager {
  constructor() {
    this.deviceIdKey = 'eventsync_device_id';
    this.deviceTypeKey = 'eventsync_device_type';
    this.deviceNameKey = 'eventsync_device_name';
    this.wakeLock = null;
  }

  /**
   * Get or initialize persistent Device UUID
   */
  getDeviceId() {
    let id = localStorage.getItem(this.deviceIdKey);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) 
        ? crypto.randomUUID() 
        : 'dev-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now();
      localStorage.setItem(this.deviceIdKey, id);
    }
    return id;
  }

  /**
   * Automatically detect device type based on user-agent, pointer, and screen width
   */
  detectDeviceType() {
    const saved = localStorage.getItem(this.deviceTypeKey);
    if (saved && ['phone', 'tablet', 'laptop'].includes(saved)) {
      return saved;
    }

    const ua = navigator.userAgent || '';
    const width = window.innerWidth;

    let type = 'laptop';
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
      type = 'tablet';
    } else if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated/i.test(ua)) {
      type = (width >= 600 && width <= 1024) ? 'tablet' : 'phone';
    } else if (width < 600) {
      type = 'phone';
    } else if (width <= 1024) {
      type = 'tablet';
    }

    localStorage.setItem(this.deviceTypeKey, type);
    return type;
  }

  /**
   * Get or prompt for friendly device name
   */
  getDeviceName(role = 'Node') {
    let name = localStorage.getItem(this.deviceNameKey);
    if (!name) {
      const type = this.detectDeviceType();
      const capitalizedType = type.charAt(0).toUpperCase() + type.slice(1);
      const shortId = this.getDeviceId().substring(0, 4);
      name = `${capitalizedType} (${role}-${shortId})`;
      localStorage.setItem(this.deviceNameKey, name);
    }
    return name;
  }

  setDeviceName(newName) {
    if (newName && newName.trim()) {
      localStorage.setItem(this.deviceNameKey, newName.trim());
    }
  }

  /**
   * Hardware: Screen Wake Lock API (keeps phone/tablet screen on during scanning)
   */
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('[Hardware] Screen Wake Lock active');
        this.wakeLock.addEventListener('release', () => {
          console.log('[Hardware] Screen Wake Lock released');
          this.wakeLock = null;
        });
      } catch (err) {
        console.warn('[Hardware] Wake Lock request failed:', err.message);
      }
    }
  }

  /**
   * Hardware: Haptic Vibration Feedback
   */
  vibrate(pattern = [100]) {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        // Ignore vibration errors
      }
    }
  }

  /**
   * Web Share API with automatic download fallback
   */
  async shareOrDownload({ title, text, url, dataUrl, filename }) {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: url || window.location.href });
        return true;
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('[Share] Web Share error, falling back to download:', e);
        }
      }
    }

    // Fallback: direct download
    if (dataUrl) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename || 'download.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    }

    if (url) {
      window.open(url, '_blank');
      return true;
    }

    return false;
  }

  /**
   * Mobile Lifecycle: Setup listener for visibilitychange & online events
   */
  setupLifecycleListeners(onWakeCallback) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[Lifecycle] App became visible (waking up). Refreshing state...');
        if (this.wakeLock === null) {
          this.requestWakeLock();
        }
        if (typeof onWakeCallback === 'function') {
          onWakeCallback('visibilitychange');
        }
      }
    });

    window.addEventListener('online', () => {
      console.log('[Lifecycle] Network online event detected.');
      if (typeof onWakeCallback === 'function') {
        onWakeCallback('online');
      }
    });
  }
}

window.deviceManager = new DeviceManager();
