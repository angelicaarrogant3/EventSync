const os = require('os');
const { spawnSync } = require('child_process');

const VIRTUAL_ADAPTER_RE = /(vethernet|vmware|virtualbox|vbox|wsl|hyper-v|docker|tailscale|zerotier|hamachi|virtual|loopback|tap|tun)/i;

function isVirtualAdapter(interfaceName = '') {
  return VIRTUAL_ADAPTER_RE.test(String(interfaceName));
}

/**
 * Classify an IPv4 address into a priority bucket and human-readable label.
 * Priority (lower is better):
 *  1: Standard LAN/Wi-Fi (192.168.x.x, excluding Windows Mobile Hotspot 192.168.137.1)
 *  2: Private 10.x.x.x
 *  3: Private 172.16.x.x - 172.31.x.x
 *  4: Other non-internal IPv4
 *  10: Windows Mobile Hotspot (192.168.137.1)
 *  +20 penalty for virtual adapters (VMware, VirtualBox, vEthernet, WSL, etc.)
 */
function classifyIpAddress(ip, interfaceName = '') {
  if (!ip) return { priority: 99, label: 'Unknown', isHotspot: false, isVirtual: false };

  const isVirtual = isVirtualAdapter(interfaceName);
  const virtualPenalty = isVirtual ? 20 : 0;

  if (ip === '192.168.137.1') {
    return { priority: 10 + virtualPenalty, label: 'Hotspot network', isHotspot: true, isVirtual };
  }
  if (ip.startsWith('192.168.')) {
    return { priority: 1 + virtualPenalty, label: isVirtual ? 'Virtual LAN' : 'Wi-Fi / LAN', isHotspot: false, isVirtual };
  }
  if (ip.startsWith('10.')) {
    return { priority: 2 + virtualPenalty, label: isVirtual ? 'Virtual LAN (10.x)' : 'Private LAN (10.x)', isHotspot: false, isVirtual };
  }
  const parts = ip.split('.').map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return { priority: 3 + virtualPenalty, label: isVirtual ? 'Virtual LAN (172.x)' : 'Private LAN (172.16-31.x)', isHotspot: false, isVirtual };
  }
  return { priority: 4 + virtualPenalty, label: isVirtual ? 'Virtual Network' : 'Network', isHotspot: false, isVirtual };
}

/**
 * Check if an IPv4 address is link-local (169.254.x.x)
 */
function isLinkLocal(ip) {
  return typeof ip === 'string' && ip.startsWith('169.254.');
}

/**
 * Returns a sorted list of local IPv4 network addresses (excluding loopback and 169.254.x.x link-local)
 * with interface name, label, priority, isHotspot, and isVirtual flags.
 */
function getLocalIpAddresses(networkInterfacesOverride = null) {
  const interfaces = networkInterfacesOverride || os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (family && !net.internal && !isLinkLocal(net.address)) {
        const meta = classifyIpAddress(net.address, name);
        addresses.push({
          interface: name,
          address: net.address,
          label: meta.label,
          priority: meta.priority,
          isHotspot: meta.isHotspot,
          isVirtual: meta.isVirtual
        });
      }
    }
  }

  addresses.sort((a, b) => a.priority - b.priority);
  return addresses;
}

/**
 * Build structured startup links for terminal banner, /connect page, and tests.
 */
function buildStartupLinks({ protocol = 'http', port = 3000, serverHost = null, lanAddresses = null } = {}) {
  const detected = Array.isArray(lanAddresses) ? lanAddresses : getLocalIpAddresses();
  const primaryEntry = serverHost
    ? { address: serverHost, interface: 'SERVER_HOST', label: 'Configured Host', isHotspot: serverHost === '192.168.137.1', isVirtual: false }
    : (detected.find(a => !a.isHotspot && !a.isVirtual) || detected.find(a => !a.isVirtual) || detected[0] || null);

  const hasNetwork = Boolean(primaryEntry);
  const primaryIp = primaryEntry ? primaryEntry.address : 'localhost';
  const hotspotEntry = detected.find(a => a.isHotspot) || null;

  const localUrl = `${protocol}://localhost:${port}`;
  const networkUrl = hasNetwork ? `${protocol}://${primaryIp}:${port}` : null;
  const hotspotUrl = hotspotEntry ? `${protocol}://${hotspotEntry.address}:${port}` : null;
  const shareBase = networkUrl || localUrl;

  return {
    protocol,
    port,
    hasNetwork,
    primaryIp,
    localUrl,
    networkUrl,
    hotspotUrl,
    connectUrl: `${shareBase}/connect`,
    loginUrl: `${shareBase}/login`,
    signupUrl: `${shareBase}/signup`,
    interfaces: detected
  };
}

/**
 * Format the clean serve-style startup banner.
 */
function formatStartupBanner({ links, copied = false, hasAdmin = true, ascii = false } = {}) {
  const lines = [
    '',
    'EventSync is running!',
    '',
    `- Local:    ${links.localUrl}`,
    links.hasNetwork && links.networkUrl
      ? `- Network:  ${links.networkUrl}`
      : 'No network detected. Connect to Wi-Fi to use other devices.'
  ];

  if (copied) {
    lines.push('', 'Copied local address to clipboard!');
  }

  if (links.protocol === 'https') {
    lines.push('', 'HTTPS mode: phones must trust the certificate (see /connect).');
  }

  lines.push('');

  const contentWidth = Math.max(42, ...lines.map((l) => l.length));
  const tl = ascii ? '+' : '┌';
  const tr = ascii ? '+' : '┐';
  const bl = ascii ? '+' : '└';
  const br = ascii ? '+' : '┘';
  const h = ascii ? '-' : '─';
  const v = ascii ? '|' : '│';

  const border = h.repeat(contentWidth + 4);
  const boxed = [
    `   ${tl}${border}${tr}`,
    ...lines.map((line) => `   ${v}   ${line.padEnd(contentWidth)} ${v}`),
    `   ${bl}${border}${br}`
  ];

  if (!hasAdmin) {
    boxed.push('', '   No administrator yet. Run: npm run create-admin');
  }

  return boxed.join('\n');
}

/**
 * Silently copy text to the OS clipboard when supported. Returns true on success.
 */
function copyToClipboard(text) {
  if (!text || process.env.NODE_ENV === 'test' || process.env.EVENTSYNC_NO_CLIPBOARD === '1') {
    return false;
  }

  const attempts = process.platform === 'win32'
    ? [['clip', []]]
    : process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];

  for (const [cmd, args] of attempts) {
    try {
      const res = spawnSync(cmd, args, {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 1500
      });
      if (res.status === 0 && !res.error) {
        return true;
      }
    } catch {
      // Ignore missing clipboard utilities
    }
  }

  return false;
}

/**
 * Windows Firewall command hint for allowing inbound TCP traffic on the configured port.
 */
function getFirewallHint(port = 3000) {
  return `netsh advfirewall firewall add rule name="EventSync (${port})" dir=in action=allow protocol=TCP localport=${port} profile=any`;
}

module.exports = {
  isVirtualAdapter,
  classifyIpAddress,
  isLinkLocal,
  getLocalIpAddresses,
  buildStartupLinks,
  formatStartupBanner,
  copyToClipboard,
  getFirewallHint
};
