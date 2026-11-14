const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const { attachSession, requireRole } = require('./middleware/auth.middleware');

// Route handlers
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const eventsRoutes = require('./routes/events.routes');
const registrationsRoutes = require('./routes/registrations.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const reportsRoutes = require('./routes/reports.routes');
const nodesRoutes = require('./routes/nodes.routes');
const connectRoutes = require('./routes/connect.routes');
const participantRoutes = require('./routes/participant.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.set('trust proxy', true);

app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-node-id', 'x-node-role', 'x-device-id', 'x-device-type']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Attach server-side SQLite session (sets req.user & req.participant if authenticated)
app.use(attachSession);

// Public certificate download & connect-info API
app.use('/', connectRoutes);

// Inline SVG favicon so browsers never log 404 for /favicon.ico
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563eb"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#ffffff">ES</text></svg>';
app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml').status(200).send(FAVICON_SVG);
});

// Public non-secret client configuration (used by station pages)
app.get('/config', (req, res) => {
  const host = req.get('host') || `localhost:${config.port}`;
  res.json({
    node1Url: `${req.protocol}://${host}`,
    protocol: req.protocol,
    port: config.port
  });
});

// Mount API routes
app.use('/api', healthRoutes);
app.use('/api', authRoutes);
app.use('/api', eventsRoutes);
app.use('/api', registrationsRoutes);
app.use('/api', attendanceRoutes);
app.use('/api', reportsRoutes);
app.use('/api', nodesRoutes);
app.use('/api', participantRoutes);
app.use('/api', adminRoutes);

// Static & Role-Protected Pages
const sharedVendorDir = path.resolve(__dirname, '../../clients/shared/vendor');
const registrationPublic = path.resolve(__dirname, '../../clients/registration/public');
const scannerPublic = path.resolve(__dirname, '../../clients/scanner/public');
const organizerPublic = path.resolve(__dirname, '../../clients/organizer/public');
const connectPublic = path.resolve(__dirname, '../public/connect');
const authPublic = path.resolve(__dirname, '../public/auth');
const appPublic = path.resolve(__dirname, '../public/app');
const adminPublic = path.resolve(__dirname, '../public/admin');

app.use('/vendor', express.static(sharedVendorDir));
app.use('/connect', express.static(connectPublic));

// Public Auth Pages
app.get('/login', (req, res) => {
  res.sendFile(path.join(authPublic, 'login.html'));
});
app.get('/signup', (req, res) => {
  res.sendFile(path.join(authPublic, 'signup.html'));
});

// Participant Portal Pages (Protected: participant only)
const participantPages = ['/app', '/app/events', '/app/events/:id', '/app/my-events', '/app/my-qr', '/app/my-attendance', '/app/profile'];
app.get(participantPages, requireRole('participant'), (req, res) => {
  res.sendFile(path.join(appPublic, 'index.html'));
});

// Administrator Portal Pages (Protected: administrator only)
const adminPages = ['/admin', '/admin/participants', '/admin/accounts', '/admin/records', '/admin/reports', '/admin/activity'];
app.get(adminPages, requireRole('administrator'), (req, res) => {
  res.sendFile(path.join(adminPublic, 'index.html'));
});

// Existing Administrator Station Pages: protect HTML entry, keep static assets (manifest, CSS, JS, sw.js) public
function mountStation(prefix, dir) {
  app.get([prefix, `${prefix}/`, `${prefix}/index.html`], requireRole('administrator'), (req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
  app.use(prefix, express.static(dir, { index: false }));
}

mountStation('/registration', registrationPublic);
mountStation('/scanner', scannerPublic);
mountStation('/organizer', organizerPublic);

// Home route: redirect by session role or to /login
app.get('/', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  return res.redirect(req.user.role === 'administrator' ? '/admin' : '/app');
});

app.use(errorHandler);

module.exports = app;
