const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const router = express.Router();
const config = require('../config');
const { buildStartupLinks, getFirewallHint } = require('../utils/network');
const { CERTS_DIR } = require('../utils/cert');
const { success, error } = require('../utils/response');

// Certificate download routes (only meaningful when HTTPS is enabled)
router.get('/cert/rootCA.pem', (req, res) => {
  const certPath = path.join(CERTS_DIR, 'rootCA.pem');
  if (fs.existsSync(certPath)) {
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="EventSync-RootCA.pem"');
    return fs.createReadStream(certPath).pipe(res);
  }
  return error(res, 'CERT_NOT_FOUND', 'Root CA certificate has not been generated yet', 404);
});

router.get('/cert/rootCA.crt', (req, res) => {
  const certPath = path.join(CERTS_DIR, 'rootCA.crt');
  if (fs.existsSync(certPath)) {
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="EventSync-RootCA.crt"');
    return fs.createReadStream(certPath).pipe(res);
  }
  return error(res, 'CERT_NOT_FOUND', 'Root CA certificate has not been generated yet', 404);
});

// JSON API endpoint providing URLs and QR codes for /connect landing page
router.get('/api/connect-info', async (req, res, next) => {
  try {
    const protocol = config.useHttps ? 'https' : 'http';
    const links = buildStartupLinks({
      protocol,
      port: config.port,
      serverHost: config.serverHost
    });
    const baseUrl = links.networkUrl;

    const makeQr = async (text) => {
      return await QRCode.toDataURL(text, {
        margin: 2,
        scale: 6,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
    };

    const roles = {
      registration: {
        name: 'Registration Station (Admin)',
        badge: 'Admin Station',
        description: 'Assisted participant registration, capacity checks, and printable QR passes.',
        path: '/registration',
        url: `${baseUrl}/registration`,
        qr: await makeQr(`${baseUrl}/registration`)
      },
      scanner: {
        name: 'Attendance Scanner (Admin)',
        badge: 'Admin Station',
        description: 'Camera QR verification, audio feedback, and offline scan queue.',
        path: '/scanner',
        url: `${baseUrl}/scanner`,
        qr: await makeQr(`${baseUrl}/scanner`)
      },
      organizer: {
        name: 'Organizer Console (Admin)',
        badge: 'Admin Station',
        description: 'Event CRUD, live attendance feed, cluster health, and reports.',
        path: '/organizer',
        url: `${baseUrl}/organizer`,
        qr: await makeQr(`${baseUrl}/organizer`)
      }
    };

    const [connectQr, loginQr, signupQr] = await Promise.all([
      makeQr(links.connectUrl),
      makeQr(links.loginUrl),
      makeQr(links.signupUrl)
    ]);

    return success(res, {
      serverHost: links.primaryIp,
      port: config.port,
      protocol,
      baseUrl,
      localUrl: links.localUrl,
      networkUrl: links.networkUrl,
      hotspotUrl: links.hotspotUrl,
      connectUrl: links.connectUrl,
      loginUrl: links.loginUrl,
      signupUrl: links.signupUrl,
      connectQr,
      loginQr,
      signupQr,
      isHttps: config.useHttps,
      lanAddresses: links.interfaces,
      firewallHint: getFirewallHint(config.port),
      certDownload: config.useHttps
        ? {
            pemUrl: `${baseUrl}/cert/rootCA.pem`,
            crtUrl: `${baseUrl}/cert/rootCA.crt`
          }
        : null,
      roles
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
