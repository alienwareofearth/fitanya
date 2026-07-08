'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { getDb }      = require('../config/database');
const { sendOtp, sendWelcome, sendPasswordReset } = require('../services/email');
const { notify }     = require('../services/notifications');

const router = express.Router();

// ── Input validation helpers ──────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s\-().]{6,19}$/;

function validEmail(e) { return EMAIL_RE.test((e || '').trim()); }
function validPhone(p) { return !p || PHONE_RE.test((p || '').trim()); }
function sanitizeStr(s, max = 255) { return typeof s === 'string' ? s.trim().slice(0, max) : ''; }

function generateOtp() {
  // Cryptographically random 6-digit OTP
  return (crypto.randomInt(100000, 999999)).toString();
}

function generateReferralCode(name) {
  const safe = (name || '').replace(/[^a-zA-Z]/g, '') || 'FIT';
  return (safe.slice(0, 3) + crypto.randomBytes(3).toString('hex')).toUpperCase();
}

// Timing-safe string comparison (prevents timing attacks on admin password)
function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    // still do a comparison to avoid timing leak on length
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ── OTP brute-force protection ────────────────────────────────────────────────
// Track OTP attempts in session (max 5, then require resend)
const MAX_OTP_ATTEMPTS = 5;

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const name  = sanitizeStr(req.body.name, 100);
    const email = sanitizeStr(req.body.email, 254).toLowerCase();

    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (name.length < 2)    return res.status(400).json({ error: 'Name must be at least 2 characters' });

    const db = getDb();
    const existing = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [email] });
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered. Please login.' });

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

    req.session.pendingOtp = { name, email, otp, expiresAt, attempts: 0 };
    await sendOtp({ to: email, name, otp });

    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error('[auth] send-otp error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const otp     = sanitizeStr(req.body.otp, 6);
    const pending = req.session.pendingOtp;

    if (!pending) return res.status(400).json({ error: 'No OTP session found. Please restart.' });

    // Increment attempt counter
    pending.attempts = (pending.attempts || 0) + 1;
    if (pending.attempts > MAX_OTP_ATTEMPTS) {
      delete req.session.pendingOtp;
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    if (new Date() > new Date(pending.expiresAt)) return res.status(400).json({ error: 'OTP expired. Please request a new one.' });

    // Timing-safe OTP comparison
    if (!timingSafeEqual(pending.otp, otp)) return res.status(400).json({ error: 'Invalid OTP' });

    req.session.otpVerified = true;
    req.session.pendingOtp.attempts = 0; // reset on success
    res.json({ success: true, message: 'OTP verified' });
  } catch (err) {
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    if (!req.session.otpVerified) return res.status(400).json({ error: 'Please verify OTP first' });

    const pending = req.session.pendingOtp;
    if (!pending) return res.status(400).json({ error: 'Session expired. Please restart registration.' });

    const {
      password, occupation, height, waist, thigh, arm, chest,
      age, gender, weight, address, phone, health_issues, allergies,
      food_preference, food_specific, prior_experience, date_of_birth,
      fitness_goal, package_id, queries, referred_by_code
    } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'Password too long' });
    }
    if (!validPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Sanitize all text inputs
    const safePhone    = sanitizeStr(phone, 20);
    const safeOccup    = sanitizeStr(occupation, 100);
    const safeAddress  = sanitizeStr(address, 500);
    const safeHealth   = sanitizeStr(health_issues, 1000);
    const safeAllerg   = sanitizeStr(allergies, 500);
    const safeFoodSpec = sanitizeStr(food_specific, 500);
    const safeExper    = sanitizeStr(prior_experience, 1000);
    const safeFitGoal  = sanitizeStr(fitness_goal, 200);
    const safeQueries  = sanitizeStr(queries, 1000);
    const safeRefCode  = sanitizeStr(referred_by_code, 20).toUpperCase();
    const safeGender   = ['male','female','other','prefer_not_to_say'].includes(gender) ? gender : null;
    const safeFoodPref = ['veg','non-veg','vegan','eggetarian'].includes(food_preference) ? food_preference : null;

    const db = getDb();
    const hashedPassword = await bcrypt.hash(password, 12);
    const referralCode   = generateReferralCode(pending.name);

    let referredById = null;
    if (safeRefCode) {
      const refUser = await db.execute({ sql: `SELECT id FROM users WHERE referral_code = ?`, args: [safeRefCode] });
      if (refUser.rows.length) referredById = refUser.rows[0].id;
    }

    const userResult = await db.execute({
      sql: `INSERT INTO users (name, email, phone, password, role, referral_code, referred_by)
            VALUES (?, ?, ?, ?, 'customer', ?, ?) RETURNING id`,
      args: [pending.name, pending.email, safePhone, hashedPassword, referralCode, referredById],
    });
    const userId = userResult.rows[0].id;

    await db.execute({
      sql: `INSERT INTO customer_profiles
            (user_id, occupation, height, waist, thigh, arm, chest, age, gender, weight,
             address, health_issues, allergies, food_preference, food_specific,
             prior_experience, date_of_birth, fitness_goal, queries)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [userId, safeOccup,
             parseFloat(height) || null, parseFloat(waist) || null,
             parseFloat(thigh) || null,  parseFloat(arm) || null,
             parseFloat(chest) || null,  parseInt(age) || null,
             safeGender, parseFloat(weight) || null,
             safeAddress, safeHealth, safeAllerg, safeFoodPref, safeFoodSpec,
             safeExper, date_of_birth || null, safeFitGoal, safeQueries],
    });

    if (referredById) {
      await db.execute({
        sql: `INSERT INTO referrals (referrer_id, referee_id, status) VALUES (?, ?, 'pending')`,
        args: [referredById, userId],
      });
    }

    try {
      const trialPkg = await db.execute(`SELECT id FROM packages WHERE name = 'Free Trial' LIMIT 1`);
      if (trialPkg.rows.length) {
        await db.execute({
          sql: `INSERT INTO memberships (user_id, package_id, sessions_total, sessions_used, start_date, end_date, status, is_trial)
                VALUES (?, ?, 1, 0, date('now'), date('now', '+30 days'), 'active', 1)`,
          args: [userId, trialPkg.rows[0].id],
        });
      }
    } catch (e) {
      console.warn('[auth] trial membership creation failed:', e.message);
    }

    delete req.session.pendingOtp;
    delete req.session.otpVerified;

    sendWelcome({ to: pending.email, name: pending.name }).catch(() => {});
    res.json({ success: true, message: 'Registration successful! Please login.' });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const email    = sanitizeStr(req.body.email, 254).toLowerCase();
    const password = req.body.password;

    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!validEmail(email))   return res.status(400).json({ error: 'Invalid email format' });
    if (password.length > 128) return res.status(400).json({ error: 'Invalid credentials' });

    // Master admin — timing-safe comparison
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD &&
        timingSafeEqual(email, process.env.ADMIN_EMAIL.toLowerCase()) &&
        timingSafeEqual(password, process.env.ADMIN_PASSWORD)) {
      req.session.user = { id: 0, name: 'Admin', email, role: 'admin' };
      return res.json({ success: true, redirect: '/admin' });
    }

    const db = getDb();
    const result = await db.execute({ sql: `SELECT * FROM users WHERE email = ? AND is_active = 1`, args: [email] });
    // Always hash-compare even if not found — prevents timing-based user enumeration
    const dummy  = '$2a$12$invalidhashfortimingnormalization000000000000000000000000';
    const valid  = result.rows.length
      ? await bcrypt.compare(password, result.rows[0].password)
      : await bcrypt.compare(password, dummy).then(() => false);

    if (!result.rows.length || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const prevLogin = user.last_login_at || null;

    await db.execute({
      sql: `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`,
      args: [user.id],
    });

    req.session.user = {
      id: user.id, name: user.name, email: user.email,
      role: user.role, profile_picture: user.profile_picture,
      prev_login: prevLogin,
    };
    const redirectMap = { admin: '/admin', coach: '/coach', customer: '/dashboard' };
    res.json({ success: true, redirect: redirectMap[user.role] || '/dashboard' });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const email = sanitizeStr(req.body.email, 254).toLowerCase();
    if (!email || !validEmail(email)) {
      // Always return success — don't confirm whether email exists
      return res.json({ success: true });
    }

    const db = getDb();
    const result = await db.execute({ sql: `SELECT id, name FROM users WHERE email = ? AND is_active = 1`, args: [email] });
    // Always return success to prevent email enumeration
    if (!result.rows.length) return res.json({ success: true });

    const user = result.rows[0];
    const words = ['Fit', 'Run', 'Burn', 'Push', 'Jump', 'Flex', 'Lift', 'Core'];
    const word1 = words[crypto.randomInt(words.length)];
    const word2 = words[crypto.randomInt(words.length)];
    const digits = crypto.randomInt(1000, 9999);
    const newPassword = `${word1}${word2}${digits}`;

    const hashed = await bcrypt.hash(newPassword, 12);
    await db.execute({ sql: `UPDATE users SET password = ? WHERE id = ?`, args: [hashed, user.id] });
    sendPasswordReset({ to: email, name: user.name, newPassword }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('[auth] forgot-password error:', err);
    res.json({ success: true }); // always return success
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/login' }));
});

// POST /api/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
  try {
    const pending = req.session.pendingOtp;
    if (!pending) return res.status(400).json({ error: 'No pending registration' });
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    req.session.pendingOtp = { ...pending, otp, expiresAt, attempts: 0 };
    await sendOtp({ to: pending.email, name: pending.name, otp });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

module.exports = router;
