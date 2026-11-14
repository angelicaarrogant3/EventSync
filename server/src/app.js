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

// Existing Administrator Station Pages (Protected: administrator only)
app.use('/registration', requireRole('administrator'), express.static(registrationPublic));
app.use('/scanner', requireRole('administrator'), express.static(scannerPublic));
app.use('/organizer', requireRole('administrator'), express.static(organizerPublic));

// Home route: redirect by session role or to /login
app.get('/', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  return res.redirect(req.user.role === 'administrator' ? '/admin' : '/app');
});

app.use(errorHandler);

module.exports = app;
