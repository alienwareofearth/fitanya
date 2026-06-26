'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireCoach } = require('../middleware/auth');

const router = express.Router();
router.use(requireCoach);

// GET /api/coach/my-customers
router.get('/my-customers', async (req, res) => {
  try {
    const db = getDb();
    const customers = await db.execute({
      sql: `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.profile_picture,
            cp.fitness_goal, cp.food_preference, m.sessions_used, m.sessions_total, m.status as membership_status
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            LEFT JOIN customer_profiles cp ON cp.user_id = u.id
            WHERE m.coach_id = ?
            ORDER BY u.name`,
      args: [req.session.user.id],
    });
    res.json({ success: true, customers: customers.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/coach/my-schedule
router.get('/my-schedule', async (req, res) => {
  try {
    const db = getDb();
    const slots = await db.execute({
      sql: `SELECT ss.*, b.id as booking_id, u.name as customer_name,
            sn.id as notes_id
            FROM schedule_slots ss
            LEFT JOIN bookings b ON b.slot_id = ss.id AND b.status != 'cancelled'
            LEFT JOIN users u ON u.id = b.customer_id
            LEFT JOIN session_notes sn ON sn.booking_id = b.id
            WHERE ss.coach_id = ? AND ss.date >= date('now')
            ORDER BY ss.date, ss.start_time`,
      args: [req.session.user.id],
    });
    res.json({ success: true, slots: slots.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/coach/slots  (coach opens their own slots)
router.post('/slots', async (req, res) => {
  try {
    const { date, start_time, end_time } = req.body;
    const db = getDb();
    await db.execute({
      sql: `INSERT INTO schedule_slots (coach_id, date, start_time, end_time) VALUES (?, ?, ?, ?)`,
      args: [req.session.user.id, date, start_time, end_time],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/slots/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.execute({
      sql: `DELETE FROM schedule_slots WHERE id = ? AND coach_id = ? AND is_booked = 0`,
      args: [req.params.id, req.session.user.id],
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/coach/customer/:id/progress
router.get('/customer/:id/progress', async (req, res) => {
  try {
    const db = getDb();
    // Verify this customer belongs to this coach
    const check = await db.execute({
      sql: `SELECT id FROM memberships WHERE user_id = ? AND coach_id = ?`,
      args: [req.params.id, req.session.user.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Access denied' });

    const [profile, progress, bookings] = await Promise.all([
      db.execute({ sql: `SELECT u.name, u.email, cp.* FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = ?`, args: [req.params.id] }),
      db.execute({ sql: `SELECT * FROM progress_logs WHERE user_id = ? ORDER BY year DESC, week_number DESC LIMIT 20`, args: [req.params.id] }),
      db.execute({ sql: `SELECT b.*, ss.date, ss.start_time, sn.notes FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id LEFT JOIN session_notes sn ON sn.booking_id = b.id WHERE b.customer_id = ? AND b.coach_id = ? ORDER BY ss.date DESC`, args: [req.params.id, req.session.user.id] }),
    ]);
    res.json({ success: true, profile: profile.rows[0], progress: progress.rows, bookings: bookings.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/coach/sessions (sessions needing notes)
router.get('/sessions', async (req, res) => {
  try {
    const db = getDb();
    const sessions = await db.execute({
      sql: `SELECT b.*, ss.date, ss.start_time, u.name as customer_name, sn.id as has_notes
            FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id
            JOIN users u ON u.id = b.customer_id
            LEFT JOIN session_notes sn ON sn.booking_id = b.id
            WHERE b.coach_id = ? ORDER BY ss.date DESC`,
      args: [req.session.user.id],
    });
    res.json({ success: true, sessions: sessions.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
