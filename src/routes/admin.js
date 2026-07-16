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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.delete('/workout-styles/:id', async (req, res) => {
  const db = getDb();
  await db.execute({ sql: `DELETE FROM workout_styles WHERE id = ?`, args: [req.params.id] });
  res.json({ success: true });
});

// ── Packages ─────────────────────────────────────────────────────────────────
router.get('/packages', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`SELECT * FROM packages WHERE is_trial = 0 ORDER BY sort_order`);
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
    WHERE u.role = 'coach' ORDER BY u.is_active DESC, u.created_at DESC`);
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

    res.json({ success: true, message: `Coach created. Login credentials sent to ${email}.` });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Admin remove coach
// Hard delete — removes coach + ALL their data (bookings, slots, notes)
router.delete('/coaches/:id', async (req, res) => {
  try {
    const db = getDb();
    const coachId = parseInt(req.params.id);
    await db.execute({ sql: `DELETE FROM session_notes WHERE coach_id = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM bookings WHERE coach_id = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM schedule_slots WHERE coach_id = ?`, args: [coachId] });
    await db.execute({ sql: `UPDATE memberships SET coach_id = NULL WHERE coach_id = ?`, args: [coachId] });
    await db.execute({ sql: `UPDATE users SET assigned_coach_id = NULL WHERE assigned_coach_id = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM notifications WHERE user_id = ?`, args: [coachId] });
    await db.execute({ sql: `UPDATE stories SET reviewed_by = NULL WHERE reviewed_by = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM stories WHERE user_id = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM referrals WHERE referrer_id = ? OR referee_id = ?`, args: [coachId, coachId] });
    await db.execute({ sql: `DELETE FROM coach_profiles WHERE user_id = ?`, args: [coachId] });
    await db.execute({ sql: `DELETE FROM users WHERE id = ? AND role = 'coach'`, args: [coachId] });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Soft deactivate — keeps all data, just blocks login
router.post('/coaches/:id/deactivate', async (req, res) => {
  try {
    const db = getDb();
    const coachId = parseInt(req.params.id);
    await db.execute({ sql: `UPDATE users SET is_active = 0 WHERE id = ? AND role = 'coach'`, args: [coachId] });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Reactivate
router.post('/coaches/:id/reactivate', async (req, res) => {
  try {
    const db = getDb();
    const coachId = parseInt(req.params.id);
    await db.execute({ sql: `UPDATE users SET is_active = 1 WHERE id = ? AND role = 'coach'`, args: [coachId] });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// ── Members ───────────────────────────────────────────────────────────────────
router.get('/members', async (req, res) => {
  const db = getDb();
  const result = await db.execute(`
    SELECT u.id, u.name, u.email, u.phone, u.timezone, u.created_at, u.is_active,
           cp.fitness_goal, cp.food_preference,
           m.status as membership_status, m.sessions_total, m.sessions_used,
           COALESCE(m.coach_id, u.assigned_coach_id) as coach_id,
           p.name as package_name,
           COALESCE(coach_m.name, coach_u.name) as coach_name
    FROM users u
    LEFT JOIN customer_profiles cp ON cp.user_id = u.id
    LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
    LEFT JOIN packages p ON p.id = m.package_id
    LEFT JOIN users coach_m ON coach_m.id = m.coach_id
    LEFT JOIN users coach_u ON coach_u.id = u.assigned_coach_id
    WHERE u.role = 'customer'
    ORDER BY u.created_at DESC`);
  res.json({ success: true, members: result.rows });
});

router.get('/members/:id', async (req, res) => {
  const db = getDb();
  const [user, profile, bookings] = await Promise.all([
    db.execute({ sql: `SELECT u.*, cp.* FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = ?`, args: [req.params.id] }),
    db.execute({ sql: `SELECT * FROM progress_logs WHERE user_id = ? ORDER BY year DESC, week_number DESC LIMIT 12`, args: [req.params.id] }),
    db.execute({ sql: `SELECT b.*, ss.date, ss.start_time, COALESCE(u.name, 'Coach Removed') as coach_name FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id LEFT JOIN users u ON u.id = b.coach_id AND u.is_active = 1 WHERE b.customer_id = ? ORDER BY ss.date DESC LIMIT 10`, args: [req.params.id] }),
  ]);
  res.json({ success: true, member: user.rows[0], progress: profile.rows, bookings: bookings.rows });
});

// Admin assign free trial to a member
router.post('/members/:id/assign-trial', async (req, res) => {
  try {
    const db = getDb();
    const memberId = parseInt(req.params.id);

    const existing = await db.execute({
      sql: `SELECT id FROM memberships WHERE user_id = ? AND is_trial = 1`,
      args: [memberId],
    });
    if (existing.rows.length) return res.status(400).json({ error: 'Member already has a trial membership' });

    const trialPkg = await db.execute(`SELECT id FROM packages WHERE name = 'Free Trial' LIMIT 1`);
    if (!trialPkg.rows.length) return res.status(500).json({ error: 'Free Trial package not found' });

    await db.execute({
      sql: `INSERT INTO memberships (user_id, package_id, sessions_total, sessions_used, start_date, end_date, status, is_trial)
            VALUES (?, ?, 1, 0, date('now'), date('now', '+30 days'), 'active', 1)`,
      args: [memberId, trialPkg.rows[0].id],
    });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Admin assign any package to a member
router.post('/members/:id/assign-package', async (req, res) => {
  try {
    const { package_id, start_date } = req.body;
    const memberId = parseInt(req.params.id);
    const db = getDb();

    const pkg = await db.execute({ sql: `SELECT * FROM packages WHERE id = ? AND is_active = 1`, args: [parseInt(package_id)] });
    if (!pkg.rows.length) return res.status(400).json({ error: 'Package not found' });
    const p = pkg.rows[0];

    const startD = start_date || new Date().toISOString().split('T')[0];
    const endD = new Date(new Date(startD).getTime() + p.days * 86400000).toISOString().split('T')[0];

    // Expire any existing active membership first
    await db.execute({
      sql: `UPDATE memberships SET status = 'expired' WHERE user_id = ? AND status = 'active'`,
      args: [memberId],
    });

    await db.execute({
      sql: `INSERT INTO memberships (user_id, package_id, sessions_total, sessions_used, start_date, end_date, status, is_trial)
            VALUES (?, ?, ?, 0, ?, ?, 'active', 0)`,
      args: [memberId, p.id, p.sessions, startD, endD],
    });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Admin edit membership sessions
router.post('/members/:id/add-sessions', async (req, res) => {
  try {
    const { sessions_to_add } = req.body;
    const add = parseInt(sessions_to_add);
    if (!add || add < 1) return res.status(400).json({ error: 'Enter a valid number of sessions to add' });
    const db = getDb();
    const result = await db.execute({
      sql: `UPDATE memberships SET sessions_total = sessions_total + ?, updated_at = datetime('now')
            WHERE user_id = ? AND status = 'active'`,
      args: [add, parseInt(req.params.id)],
    });
    if (result.rowsAffected === 0) return res.status(400).json({ error: 'No active membership found for this member' });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Admin: regenerate Meet links for bookings that have broken/placeholder links
router.post('/fix-meet-links', async (_req, res) => {
  try {
    const { createMeetSession } = require('../services/googleMeet');
    const db = getDb();
    // Find bookings with placeholder or jitsi links that are not yet completed/cancelled
    const broken = await db.execute(`
      SELECT b.id, b.customer_id, b.coach_id, ss.date, ss.start_time, ss.end_time,
             cu.name as customer_name, cu.email as customer_email,
             co.name as coach_name, co.email as coach_email
      FROM bookings b
      JOIN schedule_slots ss ON ss.id = b.slot_id
      JOIN users cu ON cu.id = b.customer_id
      JOIN users co ON co.id = b.coach_id
      WHERE b.is_completed = 0 AND b.status != 'cancelled'
        AND (b.meet_link IS NULL OR b.meet_link LIKE '%placeholder%' OR b.meet_link = '')
    `);
    let fixed = 0;
    for (const b of broken.rows) {
      try {
        const { meetLink, eventId } = await createMeetSession({
          summary: `Fitanya Session — ${b.customer_name} with ${b.coach_name}`,
          description: 'Personal training session via Fitanya',
          date: b.date, startTime: b.start_time, endTime: b.end_time,
          attendeeEmails: [b.customer_email, b.coach_email],
        });
        await db.execute({
          sql: `UPDATE bookings SET meet_link = ?, google_event_id = ? WHERE id = ?`,
          args: [meetLink, eventId, b.id],
        });
        fixed++;
      } catch (e) {
        console.error(`[fix-meet] booking ${b.id}:`, e.message);
      }
    }
    res.json({ success: true, total: broken.rows.length, fixed });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// Admin reassign coach
router.post('/members/:id/reassign-coach', async (req, res) => {
  try {
    const { coach_id } = req.body;
    const db = getDb();
    const coachId = parseInt(coach_id);
    const memberId = parseInt(req.params.id);

    // Always store on users table (works even without a membership)
    await db.execute({
      sql: `UPDATE users SET assigned_coach_id = ? WHERE id = ?`,
      args: [coachId, memberId],
    });

    // Also update active membership if one exists
    await db.execute({
      sql: `UPDATE memberships SET coach_id = ? WHERE user_id = ? AND status = 'active'`,
      args: [coachId, memberId],
    });

    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// PUT /api/admin/members/:id/timezone
router.put('/members/:id/timezone', async (req, res) => {
  try {
    const VALID_TZ = [
      'Asia/Kolkata', 'America/New_York', 'America/Chicago',
      'America/Los_Angeles', 'Europe/London', 'Asia/Dubai',
      'Asia/Singapore', 'Australia/Sydney',
    ];
    const { timezone } = req.body;
    if (!VALID_TZ.includes(timezone)) return res.status(400).json({ error: 'Invalid timezone' });
    const db = getDb();
    await db.execute({
      sql: `UPDATE users SET timezone = ?, updated_at = datetime('now') WHERE id = ? AND role = 'customer'`,
      args: [timezone, parseInt(req.params.id)],
    });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// ── Bookings ──────────────────────────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(`
      SELECT b.id, b.status, b.is_completed, b.meet_link,
             ss.date, ss.start_time, ss.end_time, ss.id as slot_id,
             cu.name as customer_name, cu.email as customer_email,
             COALESCE(co.name, 'Coach Removed') as coach_name
      FROM bookings b
      JOIN schedule_slots ss ON ss.id = b.slot_id
      JOIN users cu ON cu.id = b.customer_id
      LEFT JOIN users co ON co.id = b.coach_id AND co.is_active = 1
      WHERE b.status != 'cancelled'
      ORDER BY ss.date DESC, ss.start_time DESC`);
    res.json({ success: true, bookings: result.rows });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.delete('/bookings/:id', async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    // Get booking details first
    const b = await db.execute({ sql: `SELECT * FROM bookings WHERE id = ?`, args: [id] });
    if (!b.rows.length) return res.status(404).json({ error: 'Booking not found' });
    const booking = b.rows[0];
    // Delete session notes first (FK references bookings)
    await db.execute({ sql: `DELETE FROM session_notes WHERE booking_id = ?`, args: [id] });
    // Hard delete the booking — member will see nothing
    await db.execute({ sql: `DELETE FROM bookings WHERE id = ?`, args: [id] });
    // Free the slot back into the pool
    await db.execute({ sql: `UPDATE schedule_slots SET is_booked = 0 WHERE id = ?`, args: [booking.slot_id] });
    // Refund the session back to membership
    await db.execute({ sql: `UPDATE memberships SET sessions_used = MAX(0, sessions_used - 1) WHERE id = ?`, args: [booking.membership_id] });
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Pending UPI payments (personal mode — admin manually confirms)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/payments/pending', async (req, res) => {
  try {
    const db = getDb();
    const payments = await db.execute({
      sql: `SELECT p.id, p.user_id, p.amount, p.discount_amount, p.credits_used, p.final_amount,
                   p.method, p.status, p.transaction_id, p.created_at,
                   u.name as member_name, u.email as member_email, u.phone as member_phone,
                   pkg.name as package_name
            FROM payments p
            LEFT JOIN users u ON u.id = p.user_id
            LEFT JOIN memberships m ON m.user_id = p.user_id AND m.status = 'pending'
            LEFT JOIN packages pkg ON pkg.id = m.package_id
            WHERE p.status = 'pending_verification'
            ORDER BY p.created_at DESC`,
      args: [],
    });
    res.json({ success: true, payments: payments.rows });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.post('/payments/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const payment = await db.execute({
      sql: `SELECT * FROM payments WHERE id = ? AND status = 'pending_verification'`,
      args: [id],
    });
    if (!payment.rows.length) return res.status(404).json({ error: 'Payment not found or already processed' });
    const p = payment.rows[0];

    await db.execute({
      sql: `UPDATE payments SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
      args: [id],
    });

    // Expire all currently active memberships for this user
    await db.execute({
      sql: `UPDATE memberships SET status = 'expired', updated_at = datetime('now') WHERE user_id = ? AND status = 'active'`,
      args: [p.user_id],
    });

    // Cancel all pending memberships except the most recent one
    await db.execute({
      sql: `UPDATE memberships SET status = 'cancelled', updated_at = datetime('now')
            WHERE user_id = ? AND status = 'pending'
            AND id != (SELECT id FROM memberships WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1)`,
      args: [p.user_id, p.user_id],
    });

    // Activate only the most recent pending membership
    await db.execute({
      sql: `UPDATE memberships SET status = 'active', updated_at = datetime('now')
            WHERE user_id = ? AND status = 'pending'`,
      args: [p.user_id],
    });

    if (p.credits_used > 0) {
      await db.execute({
        sql: `UPDATE users SET reward_credits = reward_credits - ? WHERE id = ?`,
        args: [p.credits_used, p.user_id],
      });
    }

    const { notify } = require('../services/notifications');
    if (p.user_id) await notify.paymentReceived(p.user_id, p.final_amount).catch(() => {});

    res.json({ success: true, message: 'Payment confirmed and membership activated' });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.post('/payments/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();
    await db.execute({
      sql: `UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`,
      args: [id],
    });
    const payment = await db.execute({ sql: `SELECT user_id FROM payments WHERE id = ?`, args: [id] });
    if (payment.rows[0]?.user_id) {
      await db.execute({
        sql: `UPDATE memberships SET status = 'cancelled', updated_at = datetime('now')
              WHERE user_id = ? AND status = 'pending'`,
        args: [payment.rows[0].user_id],
      });
    }
    res.json({ success: true });
  } catch (err) { console.error('[admin]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

module.exports = router;
