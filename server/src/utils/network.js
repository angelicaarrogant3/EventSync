const os = require('os');

/**
 * Classify an IPv4 address into a priority bucket and human-readable label.
 * Priority (lower is better):
 *  1: Standard LAN/Wi-Fi (192.168.x.x, excluding Windows Mobile Hotspot 192.168.137.1)
 *  2: Private 10.x.x.x
 *  3: Private 172.16.x.x - 172.31.x.x
 *  4: Windows Mobile Hotspot (192.168.137.1)
 *  5: Other non-internal IPv4
 */
function classifyIpAddress(ip) {
  if (!ip) return { priority: 99, label: 'Unknown', isHotspot: false };

  if (ip === '192.168.137.1') {
    return { priority: 4, label: 'Hotspot network', isHotspot: true };
  }
  if (ip.startsWith('192.168.')) {
    return { priority: 1, label: 'Wi-Fi / LAN', isHotspot: false };
  }
  if (ip.startsWith('10.')) {
    return { priority: 2, label: 'Private LAN (10.x)', isHotspot: false };
  }
  const parts = ip.split('.').map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return { priority: 3, label: 'Private LAN (172.16-31.x)', isHotspot: false };
  }
  return { priority: 5, label: 'Network', isHotspot: false };
}

/**
 * Check if an IPv4 address is link-local (169.254.x.x)
 */
function isLinkLocal(ip) {
  return typeof ip === 'string' && ip.startsWith('169.254.');
}

/**
 * Returns a sorted list of local IPv4 network addresses (excluding loopback and 169.254.x.x link-local)
 * with interface name, label, priority, and isHotspot flag.
 */
function getLocalIpAddresses(networkInterfacesOverride = null) {
  const interfaces = networkInterfacesOverride || os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (family && !net.internal && !isLinkLocal(net.address)) {
        const meta = classifyIpAddress(net.address);
        addresses.push({
          interface: name,
          address: net.address,
          label: meta.label,
          priority: meta.priority,
          isHotspot: meta.isHotspot
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
    ? { address: serverHost, interface: 'SERVER_HOST', label: 'Configured Host', isHotspot: serverHost === '192.168.137.1' }
    : (detected.find(a => !a.isHotspot) || detected[0] || null);

  const primaryIp = primaryEntry ? primaryEntry.address : 'localhost';
  const hotspotEntry = detected.find(a => a.isHotspot) || null;

  const localUrl = `${protocol}://localhost:${port}`;
  const networkUrl = `${protocol}://${primaryIp}:${port}`;
  const hotspotUrl = hotspotEntry ? `${protocol}://${hotspotEntry.address}:${port}` : null;

  return {
    protocol,
    port,
    primaryIp,
    localUrl,
    networkUrl,
    hotspotUrl,
    connectUrl: `${networkUrl}/connect`,
    loginUrl: `${networkUrl}/login`,
    signupUrl: `${networkUrl}/signup`,
    interfaces: detected
  };
}

/**
 * Windows Firewall command hint for allowing inbound TCP traffic on the configured port.
 */
function getFirewallHint(port = 3000) {
  return `netsh advfirewall firewall add rule name="EventSync (${port})" dir=in action=allow protocol=TCP localport=${port} profile=any`;
}

module.exports = {
  classifyIpAddress,
  isLinkLocal,
  getLocalIpAddresses,
  buildStartupLinks,
  getFirewallHint
};
