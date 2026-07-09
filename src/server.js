'use strict';

require('dotenv').config();

// ── Startup guards ────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const required = ['SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[startup] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
  if (process.env.SESSION_SECRET === 'fitanya-dev-secret-change-in-prod') {
    console.error('[startup] SESSION_SECRET is set to the dev placeholder — change it!');
    process.exit(1);
  }
}

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const session     = require('express-session');
const path        = require('path');

const { initDb }         = require('./config/database');
const TursoSessionStore  = require('./config/sessionStore');
const { attachUser }     = require('./middleware/auth');

// Routes
const authRoutes     = require('./routes/auth');
const publicRoutes   = require('./routes/public');
const customerRoutes = require('./routes/customer');
const coachRoutes    = require('./routes/coach');
const adminRoutes    = require('./routes/admin');
const paymentRoutes  = require('./routes/payments');
const bookingRoutes  = require('./routes/bookings');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Render/proxy X-Forwarded-For headers
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     [
        "'self'", "'unsafe-inline'",
        'cdn.jsdelivr.net', 'npmcdn.com', 'unpkg.com',
        'checkout.razorpay.com', 'cdnjs.cloudflare.com',
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.jsdelivr.net', 'unpkg.com'],
      fontSrc:       ["'self'", 'fonts.gstatic.com'],
      imgSrc:        ["'self'", 'data:', 'res.cloudinary.com', '*.cloudinary.com'],
      connectSrc:    [
        "'self'",
        'api.razorpay.com', 'lumberjack.razorpay.com',
        'res.cloudinary.com',
      ],
      frameSrc:      ["'none'"],
      objectSrc:     ["'none'"],
    },
  },
}));

app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000', credentials: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '200'),
  message:  { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const isDev = (process.env.NODE_ENV || 'development') === 'development';

// Strict limiter for auth endpoints — skip entirely in dev, 20 attempts per 15 min in prod
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  skip:     () => isDev,
  message:  { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Payment limiter — skip in dev, 8 per 10 min in prod
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max:      8,
  skip:     () => isDev,
  message:  { error: 'Too many payment attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

app.use('/api/',               globalLimiter);
app.use('/api/auth/login',     authLimiter);
app.use('/api/auth/send-otp',  authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/auth/register',  authLimiter);
app.use('/api/payments/initiate',       paymentLimiter);
app.use('/api/payments/upi/submit',     paymentLimiter);
app.use('/api/payments/razorpay/verify', paymentLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Skip JSON parsing for raw webhook routes
  if (req.path === '/api/payments/razorpay/webhook') return next();
  if (req.path === '/api/payments/phonepe/callback') return next();
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  store: new TursoSessionStore({ ttl: 7 * 24 * 3600 }),
  secret: process.env.SESSION_SECRET || 'fitanya-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  name: 'fid',  // don't expose default 'connect.sid' name
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge:   7 * 24 * 3600 * 1000,
  },
}));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Template locals ───────────────────────────────────────────────────────────
app.use(attachUser);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/public',    publicRoutes);
app.use('/api/customer',  customerRoutes);
app.use('/api/coach',     coachRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/bookings',  bookingRoutes);

// ── Page Routes ───────────────────────────────────────────────────────────────
const pages = path.join(__dirname, '../public');

app.get('/',               (req, res) => res.sendFile(path.join(pages, 'index.html')));
app.get('/login',          (req, res) => res.sendFile(path.join(pages, 'login.html')));
app.get('/register',       (req, res) => res.sendFile(path.join(pages, 'register.html')));
app.get('/payment/success',(req, res) => res.sendFile(path.join(pages, 'payment-success.html')));

app.get('/dashboard',           (req, res) => res.sendFile(path.join(pages, 'dashboard.html')));
app.get('/dashboard/schedule',  (req, res) => res.sendFile(path.join(pages, 'schedule.html')));
app.get('/dashboard/membership',(req, res) => res.sendFile(path.join(pages, 'membership.html')));
app.get('/dashboard/profile',   (req, res) => res.sendFile(path.join(pages, 'profile.html')));
app.get('/dashboard/payment',   (req, res) => res.sendFile(path.join(pages, 'payment.html')));
app.get('/dashboard/progress',  (req, res) => res.sendFile(path.join(pages, 'progress.html')));
app.get('/dashboard/diet',      (req, res) => res.sendFile(path.join(pages, 'diet.html')));
app.get('/dashboard/stories',   (req, res) => res.sendFile(path.join(pages, 'stories.html')));
app.get('/dashboard/referral',  (req, res) => res.sendFile(path.join(pages, 'referral.html')));

app.get('/coach',               (req, res) => res.sendFile(path.join(pages, 'coach-dashboard.html')));
app.get('/coach/schedule',      (req, res) => res.sendFile(path.join(pages, 'coach-schedule.html')));
app.get('/coach/customers',     (req, res) => res.sendFile(path.join(pages, 'coach-customers.html')));
app.get('/coach/sessions',      (req, res) => res.sendFile(path.join(pages, 'coach-sessions.html')));
app.get('/coach/profile',       (req, res) => res.sendFile(path.join(pages, 'coach-profile.html')));

app.get('/admin',               (req, res) => res.sendFile(path.join(pages, 'admin-dashboard.html')));
app.get('/admin/packages',      (req, res) => res.sendFile(path.join(pages, 'admin-packages.html')));
app.get('/admin/coaches',       (req, res) => res.sendFile(path.join(pages, 'admin-coaches.html')));
app.get('/admin/members',       (req, res) => res.sendFile(path.join(pages, 'admin-members.html')));
app.get('/admin/stories',       (req, res) => res.sendFile(path.join(pages, 'admin-stories.html')));
app.get('/admin/discounts',     (req, res) => res.sendFile(path.join(pages, 'admin-discounts.html')));
app.get('/admin/diet',          (req, res) => res.sendFile(path.join(pages, 'admin-diet.html')));
app.get('/admin/settings',      (req, res) => res.sendFile(path.join(pages, 'admin-settings.html')));
app.get('/admin/schedule',      (req, res) => res.sendFile(path.join(pages, 'admin-schedule.html')));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(pages, '404.html'));
});

// ── Error handler — never leak stack traces to client ─────────────────────────
app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';
  console.error('[error]', isProd ? err.message : err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  res.status(500).sendFile(path.join(pages, '404.html'));
});

// ── Account deletion cleanup ───────────────────────────────────────────────────
async function runDeletionCleanup() {
  try {
    const { getDb } = require('./config/database');
    const db = getDb();
    // Find accounts past the 7-day grace window
    const expired = await db.execute({
      sql: `SELECT id FROM users WHERE deleted_at IS NOT NULL AND deletion_scheduled_at <= datetime('now')`,
      args: [],
    });
    if (!expired.rows.length) return;
    const ids = expired.rows.map(r => r.id);

    for (const id of ids) {
      // Wipe personal data from customer_profiles
      await db.execute({
        sql: `UPDATE customer_profiles SET
                occupation=NULL, height=NULL, waist=NULL, thigh=NULL,
                arm=NULL, chest=NULL, age=NULL, weight=NULL, ideal_weight=NULL,
                address=NULL, health_issues=NULL, allergies=NULL,
                food_specific=NULL, prior_experience=NULL,
                updated_at=datetime('now')
              WHERE user_id=?`,
        args: [id],
      });
      // Anonymize the user row — keep id so foreign keys (bookings/payments) stay valid
      await db.execute({
        sql: `UPDATE users SET
                name='Deleted User',
                email='deleted-' || CAST(id AS TEXT) || '@fitanya.local',
                phone=NULL, profile_picture=NULL,
                password='DELETED',
                deleted_at=NULL, deletion_scheduled_at=NULL,
                updated_at=datetime('now')
              WHERE id=?`,
        args: [id],
      });
    }
    console.log(`[cleanup] Anonymized ${ids.length} expired account(s)`);
  } catch (err) {
    console.error('[cleanup] account deletion error:', err.message);
  }
}

// ── Membership renewal reminder (3 days before expiry) ────────────────────────
async function runRenewalReminders() {
  try {
    const { getDb } = require('./config/database');
    const { notify } = require('./services/notifications');
    const { sendRenewalReminder } = require('./services/email');
    const db = getDb();

    // Find active memberships expiring in exactly 3 days (within a 25-hour window to survive daily drift)
    const expiring = await db.execute({
      sql: `SELECT m.id, m.user_id, m.end_date, p.name as package_name,
                   u.name as user_name, u.email
            FROM memberships m
            JOIN packages p ON p.id = m.package_id
            JOIN users u ON u.id = m.user_id
            WHERE m.status = 'active'
              AND u.deleted_at IS NULL
              AND m.end_date BETWEEN date('now', '+2 days') AND date('now', '+3 days')`,
      args: [],
    });

    for (const row of expiring.rows) {
      const daysLeft = Math.ceil((new Date(row.end_date) - Date.now()) / 86400000);
      const expiryDate = new Date(row.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

      // In-app notification
      await notify.membershipExpiring(row.user_id, daysLeft).catch(() => {});

      // Email reminder (fire-and-forget)
      sendRenewalReminder({
        to: row.email, name: row.user_name,
        packageName: row.package_name, daysLeft, expiryDate,
        renewUrl: `${process.env.APP_URL || 'http://localhost:3000'}/dashboard/membership`,
      }).catch(() => {});
    }

    if (expiring.rows.length) {
      console.log(`[reminders] Sent renewal reminders to ${expiring.rows.length} member(s)`);
    }
  } catch (err) {
    console.error('[reminders] renewal reminder error:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initDb();
  // Run cleanup immediately on startup then every 24 hours
  runDeletionCleanup();
  setInterval(runDeletionCleanup, 24 * 60 * 60 * 1000);
  // Send renewal reminders daily (run on startup + every 24h)
  runRenewalReminders();
  setInterval(runRenewalReminders, 24 * 60 * 60 * 1000);
  app.listen(PORT, () => {
    console.log(`\n🔥 FITANYA running on http://localhost:${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });

module.exports = app;
