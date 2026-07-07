'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const { upload, uploadBuffer } = require('../middleware/upload');

const router = express.Router();
router.use(requireAdmin);

// ── Dashboard Stats ─────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const [customers, coaches, bookings, revenue, pending] = await Promise.all([
      db.execute(`SELECT COUNT(*) as count FROM users WHERE role = 'customer'`),
      db.execute(`SELECT COUNT(*) as count FROM users WHERE role = 'coach'`),
      db.execute(`SELECT COUNT(*) as count FROM bookings WHERE status = 'confirmed'`),
      db.execute(`SELECT COALESCE(SUM(final_amount), 0) as total FROM payments WHERE status = 'completed'`),
      db.execute(`SELECT COUNT(*) as count FROM stories WHERE status = 'pending'`),
    ]);
    res.json({
      success: true,
      stats: {
        customers: customers.rows[0].count,
        coaches: coaches.rows[0].count,
        bookings: bookings.rows[0].count,
        revenue: revenue.rows[0].total,
        pendingStories: pending.rows[0].count,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Workout Styles ───────────────────────────────────────────────────────────
router.get('/workout-styles', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`SELECT * FROM workout_styles ORDER BY sort_order`);
  res.json({ success: true, styles: result.rows });
});

router.post('/workout-styles', async (req, res) => {
  try {
    const { name, description, icon, sort_order } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO workout_styles (name, description, icon, sort_order) VALUES (?, ?, ?, ?)`,
      args: [name, description, icon, sort_order || 0],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/workout-styles/:id', async (req, res) => {
  try {
    const { name, description, icon, sort_order, is_active } = req.body;
    const db = getDb();
    await db.execute({
      sql: `UPDATE workout_styles SET name=?, description=?, icon=?, sort_order=?, is_active=? WHERE id=?`,
      args: [name, description, icon, sort_order, is_active, req.params.id],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/workout-styles/:id', async (req, res) => {
  const db = getDb();
  await db.execute({ sql: `DELETE FROM workout_styles WHERE id = ?`, args: [req.params.id] });
  res.json({ success: true });
});

// ── Packages ─────────────────────────────────────────────────────────────────
router.get('/packages', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`SELECT * FROM packages ORDER BY sort_order`);
  res.json({ success: true, packages: result.rows });
});

router.post('/packages', async (req, res) => {
  try {
    const { name, sessions, days, price, description, features } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO packages (name, sessions, days, price, description, features) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [name, sessions, days, price, description, features],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/packages/:id', async (req, res) => {
  try {
    const { name, sessions, days, price, description, features, is_active } = req.body;
    const db = getDb();
    await db.execute({
      sql: `UPDATE packages SET name=?, sessions=?, days=?, price=?, description=?, features=?, is_active=?, updated_at=datetime('now') WHERE id=?`,
      args: [name, parseInt(sessions), parseInt(days), parseFloat(price), description, features || null, parseInt(is_active), req.params.id],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Discount Codes ────────────────────────────────────────────────────────────
router.get('/discounts', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`SELECT * FROM discount_codes ORDER BY created_at DESC`);
  res.json({ success: true, discounts: result.rows });
});

router.post('/discounts', async (req, res) => {
  try {
    const { code, type, value, min_amount, max_uses, expires_at, applies_to, package_id } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO discount_codes (code, type, value, min_amount, max_uses, expires_at, applies_to, package_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [code.toUpperCase(), type, parseFloat(value), parseFloat(min_amount) || 0, max_uses || null, expires_at || null, applies_to || 'all', package_id || null],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/discounts/:id/toggle', async (req, res) => {
  const db = getDb();
  await db.execute({ sql: `UPDATE discount_codes SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?`, args: [req.params.id] });
  res.json({ success: true });
});

// ── Coaches ───────────────────────────────────────────────────────────────────
router.get('/coaches', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`
    SELECT u.id, u.name, u.email, u.phone, u.is_active, u.created_at, cp.bio, cp.specializations
    FROM users u LEFT JOIN coach_profiles cp ON cp.user_id = u.id
    WHERE u.role = 'coach' ORDER BY u.created_at DESC`);
  res.json({ success: true, coaches: result.rows });
});

router.post('/coaches', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { sendCoachInvite } = require('../services/email');
    const { name, email, phone, bio, specializations, certifications } = req.body;
    const db = getDb();

    // Generate a readable temp password
    const tempPassword = 'Fit@' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const referralCode = (name.slice(0, 3) + Math.random().toString(36).slice(2, 5)).toUpperCase();

    const user = await db.execute({
      sql: `INSERT INTO users (name, email, phone, password, role, referral_code) VALUES (?, ?, ?, ?, 'coach', ?) RETURNING id`,
      args: [name, email, phone, hashedPassword, referralCode],
    });
    const userId = user.rows[0].id;
    await db.execute({
      sql: `INSERT INTO coach_profiles (user_id, bio, specializations, certifications) VALUES (?, ?, ?, ?)`,
      args: [userId, bio, specializations, certifications],
    });

    // Send invite email with credentials
    await sendCoachInvite({ to: email, name, tempPassword });

    res.json({ success: true, tempPassword, message: `Coach created and invite sent to ${email}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Members ───────────────────────────────────────────────────────────────────
router.get('/members', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`
    SELECT u.id, u.name, u.email, u.phone, u.created_at, u.is_active,
           cp.fitness_goal, cp.food_preference,
           m.status as membership_status, m.sessions_total, m.sessions_used,
           p.name as package_name, coach.name as coach_name
    FROM users u
    LEFT JOIN customer_profiles cp ON cp.user_id = u.id
    LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
    LEFT JOIN packages p ON p.id = m.package_id
    LEFT JOIN users coach ON coach.id = m.coach_id
    WHERE u.role = 'customer'
    ORDER BY u.created_at DESC`);
  res.json({ success: true, members: result.rows });
});

router.get('/members/:id', async (req, res) => {
  const db = getDb();
  const [user, profile, bookings] = await Promise.all([
    db.execute({ sql: `SELECT u.*, cp.* FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = ?`, args: [req.params.id] }),
    db.execute({ sql: `SELECT * FROM progress_logs WHERE user_id = ? ORDER BY year DESC, week_number DESC LIMIT 12`, args: [req.params.id] }),
    db.execute({ sql: `SELECT b.*, ss.date, ss.start_time, u.name as coach_name FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id JOIN users u ON u.id = b.coach_id WHERE b.customer_id = ? ORDER BY ss.date DESC LIMIT 10`, args: [req.params.id] }),
  ]);
  res.json({ success: true, member: user.rows[0], progress: profile.rows, bookings: bookings.rows });
});

// Admin reassign coach
router.post('/members/:id/reassign-coach', async (req, res) => {
  try {
    const { coach_id } = req.body;
    const db = getDb();
    await db.execute({
      sql: `UPDATE memberships SET coach_id = ? WHERE user_id = ? AND status = 'active'`,
      args: [coach_id, req.params.id],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Schedule Slots ────────────────────────────────────────────────────────────
router.get('/slots', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`
    SELECT ss.*, u.name as coach_name FROM schedule_slots ss
    JOIN users u ON u.id = ss.coach_id
    WHERE ss.date >= date('now') ORDER BY ss.date, ss.start_time`);
  res.json({ success: true, slots: result.rows });
});

router.post('/slots', async (req, res) => {
  try {
    const { coach_id, date, start_time, end_time } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO schedule_slots (coach_id, date, start_time, end_time) VALUES (?, ?, ?, ?)`,
      args: [coach_id, date, start_time, end_time],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/slots/:id', async (req, res) => {
  const db = getDb();
  await db.execute({ sql: `DELETE FROM schedule_slots WHERE id = ? AND is_booked = 0`, args: [req.params.id] });
  res.json({ success: true });
});

// ── Stories Approval ──────────────────────────────────────────────────────────
router.get('/stories', async (req, res) => {
  const { status = 'pending' } = req.query;
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT s.*, u.name as user_name FROM stories s JOIN users u ON u.id = s.user_id WHERE s.status = ? ORDER BY s.created_at DESC`,
    args: [status],
  });
  res.json({ success: true, stories: result.rows });
});

router.post('/stories/:id/review', async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    const db = getDb();
    const story = await db.execute({ sql: `SELECT user_id FROM stories WHERE id = ?`, args: [req.params.id] });
    await db.execute({
      sql: `UPDATE stories SET status=?, admin_note=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`,
      args: [status, admin_note, req.session.user.id, req.params.id],
    });
    const userId = story.rows[0]?.user_id;
    if (userId) {
      const { notify } = require('../services/notifications');
      if (status === 'approved') await notify.storyApproved(userId);
      else await notify.storyRejected(userId, admin_note);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Referral Config ───────────────────────────────────────────────────────────
router.get('/referral-config', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`SELECT * FROM referral_config LIMIT 1`);
  res.json({ success: true, config: result.rows[0] });
});

router.put('/referral-config', async (req, res) => {
  try {
    const { reward_type, reward_value, min_purchase, is_active } = req.body;
    const db = getDb();
    await db.execute({
      sql: `UPDATE referral_config SET reward_type=?, reward_value=?, min_purchase=?, is_active=?, updated_at=datetime('now')`,
      args: [reward_type, reward_value, min_purchase, is_active],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Diet Plans ────────────────────────────────────────────────────────────────
router.get('/diet-plans', async (req, res) => {
  const db = getDb();
  const plans = await db.execute(`SELECT * FROM diet_plans ORDER BY created_at DESC`);
  res.json({ success: true, plans: plans.rows });
});

router.post('/diet-plans', async (req, res) => {
  try {
    const { name, food_preference, fitness_goal, calories_per_day, description } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO diet_plans (name, food_preference, fitness_goal, calories_per_day, description) VALUES (?, ?, ?, ?, ?)`,
      args: [name, food_preference, fitness_goal, calories_per_day, description],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
