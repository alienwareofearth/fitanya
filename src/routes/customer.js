'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { upload, uploadBuffer } = require('../middleware/upload');

const router = express.Router();
router.use(requireAuth);

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const [user, profile, membership] = await Promise.all([
      db.execute({ sql: `SELECT id, name, email, phone, role, profile_picture, referral_code, reward_credits, created_at FROM users WHERE id = ?`, args: [userId] }),
      db.execute({ sql: `SELECT * FROM customer_profiles WHERE user_id = ?`, args: [userId] }),
      db.execute({
        sql: `SELECT m.*, p.name as package_name, p.sessions, u.name as coach_name
              FROM memberships m JOIN packages p ON p.id = m.package_id
              LEFT JOIN users u ON u.id = m.coach_id
              WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 1`,
        args: [userId],
      }),
    ]);
    res.json({ success: true, user: user.rows[0], profile: profile.rows[0], membership: membership.rows[0], prev_login: req.session.user.prev_login || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/profile', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const { name, phone, occupation, height, waist, thigh, arm, chest, age, weight, ideal_weight, address, health_issues, allergies, food_preference, food_specific, prior_experience, fitness_goal } = req.body;

    await db.execute({ sql: `UPDATE users SET name=?, phone=?, updated_at=datetime('now') WHERE id=?`, args: [name, phone, userId] });
    await db.execute({
      sql: `UPDATE customer_profiles SET occupation=?, height=?, waist=?, thigh=?, arm=?, chest=?, age=?, weight=?, ideal_weight=?, address=?, health_issues=?, allergies=?, food_preference=?, food_specific=?, prior_experience=?, fitness_goal=?, updated_at=datetime('now') WHERE user_id=?`,
      args: [occupation, height, waist, thigh, arm, chest, age, weight, ideal_weight, address, health_issues, allergies, food_preference, food_specific, prior_experience, fitness_goal, userId],
    });

    req.session.user.name = name;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/profile/picture', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { url } = await uploadBuffer(req.file.buffer, { folder: 'fitanya/avatars', transformation: [{ width: 400, height: 400, crop: 'fill' }] });
    const db = getDb();
    await db.execute({ sql: `UPDATE users SET profile_picture = ? WHERE id = ?`, args: [url, req.session.user.id] });
    req.session.user.profile_picture = url;
    res.json({ success: true, url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Membership ────────────────────────────────────────────────────────────────
router.get('/membership', async (req, res) => {
  try {
    const db = getDb();
    const memberships = await db.execute({
      sql: `SELECT m.*, p.name as package_name, p.sessions as total_sessions, u.name as coach_name
            FROM memberships m JOIN packages p ON p.id = m.package_id
            LEFT JOIN users u ON u.id = m.coach_id
            WHERE m.user_id = ? ORDER BY m.created_at DESC`,
      args: [req.session.user.id],
    });
    const payments = await db.execute({
      sql: `SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC`,
      args: [req.session.user.id],
    });
    res.json({ success: true, memberships: memberships.rows, payments: payments.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Progress Tracking ─────────────────────────────────────────────────────────
router.get('/progress', async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.execute({
      sql: `SELECT * FROM progress_logs WHERE user_id = ? ORDER BY year DESC, week_number DESC LIMIT 52`,
      args: [req.session.user.id],
    });
    res.json({ success: true, logs: logs.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/progress', async (req, res) => {
  try {
    const { weight, steps, waist, thigh, arm, chest, notes } = req.body;
    const db = getDb();
    const now = new Date();
    const weekNumber = getWeekNumber(now);
    const year = now.getFullYear();

    await db.execute({
      sql: `INSERT INTO progress_logs (user_id, week_number, year, log_date, weight, steps, waist, thigh, arm, chest, notes)
            VALUES (?, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, week_number, year) DO UPDATE SET
            weight=excluded.weight, steps=excluded.steps, waist=excluded.waist,
            thigh=excluded.thigh, arm=excluded.arm, chest=excluded.chest, notes=excluded.notes`,
      args: [req.session.user.id, weekNumber, year, weight, steps, waist, thigh, arm, chest, notes],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check if weight was logged in the last 7 days
router.get('/progress/weight-check', async (req, res) => {
  try {
    const db = getDb();
    const log = await db.execute({
      sql: `SELECT weight, log_date FROM progress_logs
            WHERE user_id = ? AND weight IS NOT NULL
            AND log_date >= date('now', '-7 days')
            ORDER BY log_date DESC LIMIT 1`,
      args: [req.session.user.id],
    });
    const lastLog = log.rows[0];
    res.json({
      logged: log.rows.length > 0,
      last_logged: lastLog?.log_date || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hydration ─────────────────────────────────────────────────────────────────
router.get('/hydration', async (req, res) => {
  try {
    const { date } = req.query;
    const db = getDb();
    const log = await db.execute({
      sql: `SELECT * FROM hydration_logs WHERE user_id = ? AND log_date = ?`,
      args: [req.session.user.id, date || new Date().toISOString().split('T')[0]],
    });
    res.json({ success: true, log: log.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hydration', async (req, res) => {
  try {
    const { glasses, goal_glasses, date } = req.body;
    const db = getDb();
    const logDate = date || new Date().toISOString().split('T')[0];
    await db.execute({
      sql: `INSERT INTO hydration_logs (user_id, log_date, glasses, goal_glasses) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, log_date) DO UPDATE SET glasses=excluded.glasses, goal_glasses=excluded.goal_glasses`,
      args: [req.session.user.id, logDate, glasses, goal_glasses || 8],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Diet ──────────────────────────────────────────────────────────────────────
router.get('/diet', async (req, res) => {
  try {
    const { date } = req.query;
    const db = getDb();
    const profile = await db.execute({ sql: `SELECT food_preference, fitness_goal FROM customer_profiles WHERE user_id = ?`, args: [req.session.user.id] });
    const pref = profile.rows[0];

    // Find matching diet plan
    const plan = await db.execute({
      sql: `SELECT * FROM diet_plans WHERE (food_preference = ? OR food_preference = 'all') AND (fitness_goal = ? OR fitness_goal IS NULL) AND is_active = 1 LIMIT 1`,
      args: [pref?.food_preference || 'Non-Veg', pref?.fitness_goal || 'Get Lean'],
    });

    if (!plan.rows.length) return res.json({ success: true, meals: [], plan: null });

    const targetDate = date || new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date(targetDate).toLocaleDateString('en-US', { weekday: 'long' });

    const meals = await db.execute({
      sql: `SELECT * FROM diet_meals WHERE diet_plan_id = ? AND day_of_week = ? ORDER BY meal_type`,
      args: [plan.rows[0].id, dayOfWeek],
    });

    res.json({ success: true, plan: plan.rows[0], meals: meals.rows, day: dayOfWeek });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stories ───────────────────────────────────────────────────────────────────
router.get('/stories', async (req, res) => {
  try {
    const db = getDb();
    const stories = await db.execute({
      sql: `SELECT * FROM stories WHERE user_id = ? ORDER BY created_at DESC`,
      args: [req.session.user.id],
    });
    res.json({ success: true, stories: stories.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/stories', upload.single('photo'), async (req, res) => {
  try {
    const { title, body } = req.body;
    const db = getDb();
    const userId = req.session.user.id;

    // Max 3 stories check
    const count = await db.execute({ sql: `SELECT COUNT(*) as count FROM stories WHERE user_id = ?`, args: [userId] });
    if (count.rows[0].count >= 3) return res.status(400).json({ error: 'Maximum 3 stories allowed' });

    let photoUrl = null;
    if (req.file) {
      const uploaded = await uploadBuffer(req.file.buffer, { folder: 'fitanya/stories' });
      photoUrl = uploaded.url;
    }

    await db.execute({
      sql: `INSERT INTO stories (user_id, title, body, photo_url) VALUES (?, ?, ?, ?)`,
      args: [userId, title, body, photoUrl],
    });
    res.json({ success: true, message: 'Story submitted for review' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Referrals ─────────────────────────────────────────────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const [user, referrals, config] = await Promise.all([
      db.execute({ sql: `SELECT referral_code, reward_credits FROM users WHERE id = ?`, args: [userId] }),
      db.execute({ sql: `SELECT r.*, u.name as referee_name, u.created_at as joined_at FROM referrals r JOIN users u ON u.id = r.referee_id WHERE r.referrer_id = ?`, args: [userId] }),
      db.execute(`SELECT * FROM referral_config LIMIT 1`),
    ]);
    res.json({ success: true, referral_code: user.rows[0]?.referral_code, credits: user.rows[0]?.reward_credits, referrals: referrals.rows, config: config.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    const { getUserNotifications, getUnreadCount, markRead } = require('../services/notifications');
    const notifications = await getUserNotifications(req.session.user.id);
    const unreadCount = await getUnreadCount(req.session.user.id);
    res.json({ success: true, notifications, unreadCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/read', async (req, res) => {
  try {
    const { markRead } = require('../services/notifications');
    await markRead(req.session.user.id, req.body.ids || []);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

module.exports = router;
