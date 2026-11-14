const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { getLocalIpAddresses } = require('./network');

const pki = forge.pki;

const CERTS_DIR = path.resolve(__dirname, '../../../data/certs');

/**
 * Ensures certificates directory exists
 */
function ensureCertsDir() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }
}

/**
 * Generates a Root CA certificate and private key (valid 10 years)
 */
function generateRootCA() {
  console.log('[Cert] Generating new Local Root CA...');
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'EventSync Distributed Root CA' },
    { name: 'countryName', value: 'PH' },
    { name: 'organizationName', value: 'EventSync Distributed Systems' },
    { name: 'organizationalUnitName', value: 'Computer Science Department' }
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true,
      critical: true
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      critical: true
    },
    {
      name: 'subjectKeyIdentifier'
    }
  ]);

  // Self-sign root CA
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const caCertPem = pki.certificateToPem(cert);
  const caKeyPem = pki.privateKeyToPem(keys.privateKey);

  // Also create DER format for mobile devices
  const caCertDer = forge.asn1.toDer(pki.certificateToAsn1(cert)).getBytes();

  fs.writeFileSync(path.join(CERTS_DIR, 'rootCA.pem'), caCertPem);
  fs.writeFileSync(path.join(CERTS_DIR, 'rootCA.crt'), Buffer.from(caCertDer, 'binary'));
  fs.writeFileSync(path.join(CERTS_DIR, 'rootCA.key'), caKeyPem);

  console.log('[Cert] Root CA generated and saved to:', CERTS_DIR);
  return { cert, privateKey: keys.privateKey };
}

/**
 * Loads existing Root CA or generates one if missing
 */
function getOrCreateRootCA() {
  ensureCertsDir();
  const caCertPath = path.join(CERTS_DIR, 'rootCA.pem');
  const caKeyPath = path.join(CERTS_DIR, 'rootCA.key');

  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
    try {
      const caCertPem = fs.readFileSync(caCertPath, 'utf8');
      const caKeyPem = fs.readFileSync(caKeyPath, 'utf8');
      return {
        cert: pki.certificateFromPem(caCertPem),
        privateKey: pki.privateKeyFromPem(caKeyPem)
      };
    } catch (err) {
      console.warn('[Cert] Error reading existing CA, regenerating:', err.message);
      return generateRootCA();
    }
  }

  return generateRootCA();
}

/**
 * Check if existing server cert SAN includes all current LAN IPs
 */
function isServerCertValidForIps(currentIps) {
  const serverCertPath = path.join(CERTS_DIR, 'server.cert');
  const serverKeyPath = path.join(CERTS_DIR, 'server.key');

  if (!fs.existsSync(serverCertPath) || !fs.existsSync(serverKeyPath)) {
    return false;
  }

  try {
    const certPem = fs.readFileSync(serverCertPath, 'utf8');
    const cert = pki.certificateFromPem(certPem);

    // Check expiration (at least 30 days valid)
    const now = new Date();
    const expiryThreshold = new Date();
    expiryThreshold.setDate(now.getDate() + 30);
    if (cert.validity.notAfter < expiryThreshold) {
      return false;
    }

    // Inspect Subject Alternative Names (SAN)
    const sanExt = cert.getExtension('subjectAltName');
    if (!sanExt || !sanExt.altNames) return false;

    const coveredIps = new Set();
    let hasLocalhost = false;

    for (const alt of sanExt.altNames) {
      if (alt.type === 2 && alt.value === 'localhost') {
        hasLocalhost = true;
      }
      if (alt.type === 7) {
        coveredIps.add(alt.ip);
      }
    }

    if (!hasLocalhost || !coveredIps.has('127.0.0.1')) {
      return false;
    }

    for (const ip of currentIps) {
      if (!coveredIps.has(ip)) {
        console.log(`[Cert] SAN list missing current LAN IP: ${ip}. Certificate regeneration required.`);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn('[Cert] Certificate verification check failed:', err.message);
    return false;
  }
}

/**
 * Generates a server certificate signed by the Root CA with Subject Alternative Names (SAN)
 * covering localhost, 127.0.0.1, and all active LAN IP addresses.
 */
function generateServerCertificate(rootCA, lanIps) {
  console.log('[Cert] Generating new Server SSL certificate with SANs...');
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2); // 2 years

  const primaryIp = lanIps.length > 0 ? lanIps[0] : '127.0.0.1';

  cert.setSubject([
    { name: 'commonName', value: primaryIp },
    { name: 'countryName', value: 'PH' },
    { name: 'organizationName', value: 'EventSync Distributed Systems' }
  ]);

  cert.setIssuer(rootCA.cert.subject.attributes);

  // Build SAN list
  const altNames = [
    { type: 2, value: 'localhost' },      // DNS
    { type: 7, ip: '127.0.0.1' }           // IP
  ];

  for (const ip of lanIps) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, ip });
    }
  }

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false,
      critical: true
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    },
    {
      name: 'subjectAltName',
      altNames
    }
  ]);

  // Sign with Root CA's private key
  cert.sign(rootCA.privateKey, forge.md.sha256.create());

  const serverCertPem = pki.certificateToPem(cert);
  const serverKeyPem = pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(path.join(CERTS_DIR, 'server.cert'), serverCertPem);
  fs.writeFileSync(path.join(CERTS_DIR, 'server.key'), serverKeyPem);

  console.log('[Cert] Server certificate generated with SAN IPs:', ['127.0.0.1', ...lanIps].join(', '));
  return { key: serverKeyPem, cert: serverCertPem };
}

/**
 * Main certificate manager function:
 * Checks current LAN environment and returns { key, cert, rootCA } ready for https.createServer
 */
function getOrGenerateCertificates() {
  ensureCertsDir();
  const rootCA = getOrCreateRootCA();

  const detectedIps = getLocalIpAddresses().map(n => n.address);

  // If server.cert is valid and covers all detected LAN IPs, read and return
  if (isServerCertValidForIps(detectedIps)) {
    const key = fs.readFileSync(path.join(CERTS_DIR, 'server.key'), 'utf8');
    const cert = fs.readFileSync(path.join(CERTS_DIR, 'server.cert'), 'utf8');
    return { key, cert, certsDir: CERTS_DIR };
  }

  // Otherwise generate fresh server certificate
  const { key, cert } = generateServerCertificate(rootCA, detectedIps);
  return { key, cert, certsDir: CERTS_DIR };
}

module.exports = {
  getOrGenerateCertificates,
  getOrCreateRootCA,
  CERTS_DIR
};

