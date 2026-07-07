'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../config/database');
const { sendOtp, sendWelcome } = require('../services/email');
const { notify }     = require('../services/notifications');

const router = express.Router();

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode(name) {
  return (name.slice(0, 3) + Math.random().toString(36).slice(2, 7)).toUpperCase();
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const db = getDb();
    const existing = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [email] });
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered. Please login.' });

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

    // Store OTP temporarily in session
    req.session.pendingOtp   = { name, email, otp, expiresAt };
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
    const { otp } = req.body;
    const pending = req.session.pendingOtp;

    if (!pending) return res.status(400).json({ error: 'No OTP session found. Please restart.' });
    if (new Date() > new Date(pending.expiresAt)) return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    if (pending.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

    req.session.otpVerified = true;
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
    const {
      password, occupation, height, waist, thigh, arm, chest,
      age, gender, weight, address, phone, health_issues, allergies,
      food_preference, food_specific, prior_experience, date_of_birth,
      fitness_goal, package_id, queries, referred_by_code
    } = req.body;

    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const db = getDb();
    const hashedPassword = await bcrypt.hash(password, 12);
    const referralCode   = generateReferralCode(pending.name);

    // Resolve referral
    let referredById = null;
    if (referred_by_code) {
      const refUser = await db.execute({ sql: `SELECT id FROM users WHERE referral_code = ?`, args: [referred_by_code] });
      if (refUser.rows.length) referredById = refUser.rows[0].id;
    }

    // Create user
    const userResult = await db.execute({
      sql: `INSERT INTO users (name, email, phone, password, role, referral_code, referred_by)
            VALUES (?, ?, ?, ?, 'customer', ?, ?) RETURNING id`,
      args: [pending.name, pending.email, phone, hashedPassword, referralCode, referredById],
    });
    const userId = userResult.rows[0].id;

    // Create customer profile
    await db.execute({
      sql: `INSERT INTO customer_profiles
            (user_id, occupation, height, waist, thigh, arm, chest, age, gender, weight,
             address, health_issues, allergies, food_preference, food_specific,
             prior_experience, date_of_birth, fitness_goal, queries)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [userId, occupation, height, waist, thigh, arm, chest, age, gender, weight,
             address, health_issues, allergies, food_preference, food_specific,
             prior_experience, date_of_birth, fitness_goal, queries],
    });

    // Track referral
    if (referredById) {
      await db.execute({
        sql: `INSERT INTO referrals (referrer_id, referee_id, status) VALUES (?, ?, 'pending')`,
        args: [referredById, userId],
      });
    }

    // Clear session
    delete req.session.pendingOtp;
    delete req.session.otpVerified;

    await sendWelcome({ to: pending.email, name: pending.name });

    res.json({ success: true, message: 'Registration successful! Please login.' });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Master admin from .env — no DB entry required
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD &&
        email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      req.session.user = { id: 0, name: 'Admin', email, role: 'admin' };
      return res.json({ success: true, redirect: '/admin' });
    }

    const db = getDb();
    const result = await db.execute({ sql: `SELECT * FROM users WHERE email = ? AND is_active = 1`, args: [email] });
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const prevLogin = user.last_login_at || null;

    // Update last_login_at to now
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
    req.session.pendingOtp = { ...pending, otp, expiresAt };
    await sendOtp({ to: pending.email, name: pending.name, otp });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

module.exports = router;
