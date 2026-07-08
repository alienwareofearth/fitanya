'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireCoach } = require('../middleware/auth');

const router = express.Router();
router.use(requireCoach);

// Block deactivated coaches — catches any removal mid-session
router.use(async (req, res, next) => {
  const userId = req.session?.user?.id;
  if (!userId || userId === 0) return next(); // admin pass-through
  try {
    const db = getDb();
    const r = await db.execute({ sql: `SELECT is_active FROM users WHERE id = ?`, args: [userId] });
    if (!r.rows.length || !r.rows[0].is_active) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'Account deactivated' });
    }
    next();
  } catch { next(); }
});

// GET /api/coach/profile
router.get('/profile', async (req, res) => {
  try {
    const db = getDb();
    const user = await db.execute({
      sql: `SELECT u.id, u.name, u.email, u.phone, u.timezone, u.profile_picture,
                   cp.bio, cp.specializations, cp.certifications
            FROM users u LEFT JOIN coach_profiles cp ON cp.user_id = u.id
            WHERE u.id = ?`,
      args: [req.session.user.id],
    });
    res.json({ success: true, coach: user.rows[0] });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// PUT /api/coach/profile
router.put('/profile', async (req, res) => {
  try {
    const { name, phone, timezone, bio, specializations } = req.body;
    const VALID_TZ = ['Asia/Kolkata', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Asia/Dubai'];
    const tz = VALID_TZ.includes(timezone) ? timezone : 'Asia/Kolkata';
    const db = getDb();
    await db.execute({
      sql: `UPDATE users SET name=?, phone=?, timezone=?, updated_at=datetime('now') WHERE id=?`,
      args: [name, phone, tz, req.session.user.id],
    });
    await db.execute({
      sql: `UPDATE coach_profiles SET bio=?, specializations=?, updated_at=datetime('now') WHERE user_id=?`,
      args: [bio, specializations, req.session.user.id],
    });
    req.session.user.name = name;
    res.json({ success: true });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/coach/my-customers
router.get('/my-customers', async (req, res) => {
  try {
    const db = getDb();
    const customers = await db.execute({
      sql: `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.profile_picture,
            cp.fitness_goal, cp.food_preference,
            m.sessions_used, m.sessions_total, m.status as membership_status
            FROM users u
            LEFT JOIN customer_profiles cp ON cp.user_id = u.id
            LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            WHERE u.role = 'customer'
              AND (m.coach_id = ? OR u.assigned_coach_id = ?)
            ORDER BY u.name`,
      args: [req.session.user.id, req.session.user.id],
    });
    res.json({ success: true, customers: customers.rows });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/coach/my-schedule
router.get('/my-schedule', async (req, res) => {
  try {
    const db = getDb();
    const slots = await db.execute({
      sql: `SELECT ss.*, b.id as booking_id, b.meet_link, b.is_completed, u.name as customer_name,
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
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.delete('/slots/:id', async (req, res) => {
  try {
    const db = getDb();
    await db.execute({
      sql: `DELETE FROM schedule_slots WHERE id = ? AND coach_id = ? AND is_booked = 0`,
      args: [req.params.id, req.session.user.id],
    });
    res.json({ success: true });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/coach/customer/:id/progress
router.get('/customer/:id/progress', async (req, res) => {
  try {
    const db = getDb();
    const coachId = req.session.user.id;
    // Verify this client is assigned to this coach (via membership or direct assignment)
    const check = await db.execute({
      sql: `SELECT u.id FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            WHERE u.id = ? AND (m.coach_id = ? OR u.assigned_coach_id = ?)
            LIMIT 1`,
      args: [req.params.id, coachId, coachId],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Access denied' });

    const [profile, progress, bookings] = await Promise.all([
      db.execute({
        sql: `SELECT u.id, u.name, u.email, u.phone, cp.* FROM users u
              LEFT JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = ?`,
        args: [req.params.id],
      }),
      db.execute({ sql: `SELECT * FROM progress_logs WHERE user_id = ? ORDER BY year DESC, week_number DESC LIMIT 20`, args: [req.params.id] }),
      db.execute({ sql: `SELECT b.*, ss.date, ss.start_time, sn.notes FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id LEFT JOIN session_notes sn ON sn.booking_id = b.id WHERE b.customer_id = ? AND b.coach_id = ? ORDER BY ss.date DESC`, args: [req.params.id, coachId] }),
    ]);
    res.json({ success: true, profile: profile.rows[0], progress: progress.rows, bookings: bookings.rows });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/coach/all-slots — all slots including past (for calendar display)
router.get('/all-slots', async (req, res) => {
  try {
    const db = getDb();
    const slots = await db.execute({
      sql: `SELECT ss.*, b.id as booking_id, b.meet_link, u.name as customer_name
            FROM schedule_slots ss
            LEFT JOIN bookings b ON b.slot_id = ss.id AND b.status != 'cancelled'
            LEFT JOIN users u ON u.id = b.customer_id
            WHERE ss.coach_id = ? AND ss.date >= date('now', '-60 days')
            ORDER BY ss.date, ss.start_time`,
      args: [req.session.user.id],
    });
    res.json({ success: true, slots: slots.rows });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/coach/init — combined profile + sessions in one query to reduce DB round-trips
router.get('/init', async (req, res) => {
  try {
    const db = getDb();
    const coachId = req.session.user.id;
    const [profile, sessions, customers] = await Promise.all([
      db.execute({
        sql: `SELECT u.id, u.name, u.email, u.phone, u.timezone, u.profile_picture,
                     cp.bio, cp.specializations
              FROM users u LEFT JOIN coach_profiles cp ON cp.user_id = u.id WHERE u.id = ?`,
        args: [coachId],
      }),
      db.execute({
        sql: `SELECT b.id, b.is_completed, b.meet_link, b.status,
                     ss.date, ss.start_time, ss.end_time,
                     u.name as customer_name, sn.id as has_notes
              FROM bookings b
              JOIN schedule_slots ss ON ss.id = b.slot_id
              JOIN users u ON u.id = b.customer_id
              LEFT JOIN session_notes sn ON sn.booking_id = b.id
              WHERE b.coach_id = ? ORDER BY ss.date DESC`,
        args: [coachId],
      }),
      db.execute({
        sql: `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.profile_picture,
                     cp.fitness_goal, cp.food_preference,
                     m.sessions_used, m.sessions_total, m.status as membership_status
              FROM users u
              LEFT JOIN customer_profiles cp ON cp.user_id = u.id
              LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
              WHERE u.role = 'customer' AND (m.coach_id = ? OR u.assigned_coach_id = ?)
              ORDER BY u.name`,
        args: [coachId, coachId],
      }),
    ]);
    res.json({
      success: true,
      coach: profile.rows[0],
      sessions: sessions.rows,
      customers: customers.rows,
    });
  } catch (err) { console.error('[coach]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// POST /api/coach/book — coach books a session on behalf of a customer
router.post('/book', async (req, res) => {
  try {
    const { customer_id, slot_id } = req.body;
    const coachId = req.session.user.id;
    const db = getDb();
    const { createMeetSession } = require('../services/googleMeet');
    const { sendBookingConfirmation } = require('../services/email');
    const { notify } = require('../services/notifications');

    const slot = await db.execute({
      sql: `SELECT * FROM schedule_slots WHERE id = ? AND coach_id = ? AND is_booked = 0 AND is_active = 1`,
      args: [slot_id, coachId],
    });
    if (!slot.rows.length) return res.status(400).json({ error: 'Slot not available' });
    const slotData = slot.rows[0];

    const membership = await db.execute({
      sql: `SELECT * FROM memberships WHERE user_id = ? AND status = 'active' AND (coach_id = ? OR coach_id IS NULL) ORDER BY created_at DESC LIMIT 1`,
      args: [customer_id, coachId],
    });
    if (!membership.rows.length) return res.status(400).json({ error: 'Customer has no active membership' });
    const mem = membership.rows[0];
    if (mem.sessions_used >= mem.sessions_total) return res.status(400).json({ error: 'No sessions remaining for this customer' });

    const [customerRow, coachRow] = await Promise.all([
      db.execute({ sql: `SELECT name, email, timezone FROM users WHERE id = ?`, args: [customer_id] }),
      db.execute({ sql: `SELECT name, email FROM users WHERE id = ?`, args: [coachId] }),
    ]);
    const customerData = customerRow.rows[0];
    const coachData = coachRow.rows[0];

    const { meetLink, eventId } = await createMeetSession({
      summary: `Fitanya Session — ${customerData.name} with ${coachData.name}`,
      description: 'Personal training session via Fitanya',
      date: slotData.date,
      startTime: slotData.start_time,
      endTime: slotData.end_time,
      attendeeEmails: [customerData.email, coachData.email],
    });

    await db.execute({
      sql: `INSERT INTO bookings (membership_id, customer_id, coach_id, slot_id, meet_link, google_event_id) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [mem.id, customer_id, coachId, slot_id, meetLink, eventId],
    });
    await db.execute({ sql: `UPDATE schedule_slots SET is_booked = 1 WHERE id = ?`, args: [slot_id] });
    await db.execute({ sql: `UPDATE memberships SET sessions_used = sessions_used + 1 WHERE id = ?`, args: [mem.id] });
    if (!mem.coach_id) {
      await db.execute({ sql: `UPDATE memberships SET coach_id = ? WHERE id = ?`, args: [coachId, mem.id] });
    }

    const TZ_LABELS = { 'Asia/Kolkata': 'IST', 'America/New_York': 'EST', 'America/Chicago': 'CST', 'America/Los_Angeles': 'PST', 'Europe/London': 'GMT', 'Asia/Dubai': 'GST' };
    const tz = customerData.timezone || 'Asia/Kolkata';
    const fmtTime = (t) => { const dt = new Date(`${slotData.date}T${t}:00+05:30`); return dt.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }); };
    const fmtDate = () => { const dt = new Date(`${slotData.date}T${slotData.start_time}:00+05:30`); return dt.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
    const tzLabel = TZ_LABELS[tz] || tz;
    const bookingInfo = { date: fmtDate(), start_time: `${fmtTime(slotData.start_time)} ${tzLabel}`, end_time: `${fmtTime(slotData.end_time)} ${tzLabel}`, coach_name: coachData.name };
    res.json({ success: true, meetLink });

    // booking confirmation email disabled
    notify.sessionBooked(parseInt(customer_id), slotData.date, slotData.start_time).catch(() => {});
  } catch (err) {
    console.error('[coach] book error:', err);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

module.exports = router;
