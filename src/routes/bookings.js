'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireAuth, requireCoach } = require('../middleware/auth');
const { createMeetSession, deleteMeetSession } = require('../services/googleMeet');
const { sendBookingConfirmation } = require('../services/email');
const { notify } = require('../services/notifications');

const router = express.Router();

const TZ_LABELS = { 'Asia/Kolkata': 'IST', 'America/New_York': 'EST', 'America/Chicago': 'CST', 'America/Los_Angeles': 'PST', 'Europe/London': 'GMT', 'Asia/Dubai': 'GST' };

function formatForTz(dateStr, timeStr, tz) {
  const timezone = tz || 'Asia/Kolkata';
  const dt = new Date(`${dateStr}T${timeStr}:00+05:30`);
  const time = dt.toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: true });
  const date = dt.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const label = TZ_LABELS[timezone] || timezone;
  return { time, date, label };
}

// GET /api/bookings/slots?coach_id=&date=
router.get('/slots', requireAuth, async (req, res) => {
  try {
    const { coach_id, date } = req.query;
    const db = getDb();
    const userId = req.session.user.id;

    // Determine coach filter: after 1st completed session, lock to assigned coach
    let coachFilter = '';
    let filteredCoachId = null;

    const completedSessions = await db.execute({
      sql: `SELECT COUNT(*) as count FROM bookings WHERE customer_id = ? AND is_completed = 1`,
      args: [userId],
    });

    if (completedSessions.rows[0].count > 0) {
      const membership = await db.execute({
        sql: `SELECT m.coach_id FROM memberships m
              JOIN users u ON u.id = m.user_id
              WHERE m.user_id = ? AND m.status = 'active'
              ORDER BY m.created_at DESC LIMIT 1`,
        args: [userId],
      });
      filteredCoachId = membership.rows[0]?.coach_id || null;
      if (!filteredCoachId) {
        // Fall back to users.assigned_coach_id
        const user = await db.execute({ sql: `SELECT assigned_coach_id FROM users WHERE id = ?`, args: [userId] });
        filteredCoachId = user.rows[0]?.assigned_coach_id || null;
      }
    } else if (coach_id) {
      filteredCoachId = parseInt(coach_id);
    } else {
      // No coach specified and no completed sessions — check if user has an assigned coach
      const user = await db.execute({ sql: `SELECT assigned_coach_id FROM users WHERE id = ?`, args: [userId] });
      filteredCoachId = user.rows[0]?.assigned_coach_id || null;
    }

    // Build fully-parameterized query — no string interpolation for user data
    const whereClauses = [
      `ss.is_booked = 0`,
      `ss.is_active = 1`,
      `(ss.date > date('now', '+05:30') OR (ss.date = date('now', '+05:30') AND ss.start_time > time('now', '+05:30')))`,
      `ss.id NOT IN (SELECT slot_id FROM bookings WHERE customer_id = ? AND status != 'cancelled')`,
    ];
    const args = [userId];

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      whereClauses.push(`ss.date = ?`);
      args.push(date);
    }

    if (filteredCoachId) {
      whereClauses.push(`ss.coach_id = ?`);
      args.push(parseInt(filteredCoachId, 10));
    }

    const slots = await db.execute({
      sql: `SELECT ss.*, u.name as coach_name
            FROM schedule_slots ss
            JOIN users u ON u.id = ss.coach_id
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY ss.date, ss.start_time`,
      args,
    });

    res.json({ success: true, slots: slots.rows });
  } catch (err) {
    console.error('[bookings] slots error:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// POST /api/bookings/book
router.post('/book', requireAuth, async (req, res) => {
  try {
    const { slot_id, membership_id, is_trial = 0 } = req.body;
    const userId = req.session.user.id;
    const db = getDb();

    // Validate slot
    const slot = await db.execute({ sql: `SELECT * FROM schedule_slots WHERE id = ? AND is_booked = 0 AND is_active = 1`, args: [slot_id] });
    if (!slot.rows.length) return res.status(400).json({ error: 'Slot not available' });

    const slotData = slot.rows[0];

    // Validate membership has sessions remaining
    const membership = await db.execute({
      sql: `SELECT * FROM memberships WHERE id = ? AND user_id = ? AND status = 'active'`,
      args: [membership_id, userId],
    });
    if (!membership.rows.length) return res.status(400).json({ error: 'No active membership' });

    const mem = membership.rows[0];
    if (mem.sessions_used >= mem.sessions_total) return res.status(400).json({ error: 'No sessions remaining' });

    // Get user and coach details for Meet
    const customer = await db.execute({ sql: `SELECT name, email, timezone FROM users WHERE id = ?`, args: [userId] });
    const coach    = await db.execute({ sql: `SELECT name, email FROM users WHERE id = ?`, args: [slotData.coach_id] });

    const customerData = customer.rows[0];
    const coachData    = coach.rows[0];

    // Create Google Meet
    const { meetLink, eventId } = await createMeetSession({
      summary: `Fitanya Session — ${customerData.name} with ${coachData.name}`,
      description: `Personal training session via Fitanya`,
      date: slotData.date,
      startTime: slotData.start_time,
      endTime: slotData.end_time,
      attendeeEmails: [customerData.email, coachData.email],
    });

    // Create booking
    const booking = await db.execute({
      sql: `INSERT INTO bookings (membership_id, customer_id, coach_id, slot_id, meet_link, google_event_id, is_trial)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [membership_id, userId, slotData.coach_id, slot_id, meetLink, eventId, is_trial ? 1 : 0],
    });

    // Mark slot as booked
    await db.execute({ sql: `UPDATE schedule_slots SET is_booked = 1 WHERE id = ?`, args: [slot_id] });

    // Increment sessions used
    await db.execute({
      sql: `UPDATE memberships SET sessions_used = sessions_used + 1 WHERE id = ?`,
      args: [membership_id],
    });

    // Assign coach to membership if not assigned
    if (!mem.coach_id) {
      await db.execute({
        sql: `UPDATE memberships SET coach_id = ? WHERE id = ?`,
        args: [slotData.coach_id, membership_id],
      });
      await notify.coachAssigned(userId, coachData.name);
      await notify.newCustomer(slotData.coach_id, customerData.name);
    }

    const tz = customerData.timezone || 'Asia/Kolkata';
    const startFmt = formatForTz(slotData.date, slotData.start_time, tz);
    const endFmt   = formatForTz(slotData.date, slotData.end_time, tz);
    const bookingInfo = {
      date: startFmt.date,
      start_time: `${startFmt.time} ${startFmt.label}`,
      end_time: `${endFmt.time} ${endFmt.label}`,
      coach_name: coachData.name,
    };

    // Respond immediately — email/notifications must not block or fail the booking
    res.json({ success: true, booking_id: booking.rows[0].id, meetLink });

    // Fire-and-forget: email + notifications after response is sent
    // booking confirmation email disabled
    notify.sessionBooked(userId, slotData.date, slotData.start_time).catch(() => {});
    notify.newBookingForCoach(slotData.coach_id, customerData.name, slotData.date, slotData.start_time).catch(() => {});
  } catch (err) {
    console.error('[bookings] book error:', err);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

// POST /api/bookings/cancel/:id
router.post('/cancel/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const db = getDb();

    const booking = await db.execute({
      sql: `SELECT b.*, ss.date, ss.start_time FROM bookings b JOIN schedule_slots ss ON ss.id = b.slot_id WHERE b.id = ? AND b.customer_id = ?`,
      args: [id, req.session.user.id],
    });
    if (!booking.rows.length) return res.status(404).json({ error: 'Booking not found' });

    const b = booking.rows[0];
    if (b.is_completed) return res.status(400).json({ error: 'Cannot cancel a completed session' });

    // Check 24h cancellation policy
    const sessionDate = new Date(`${b.date}T${b.start_time}:00+05:30`);
    const hoursUntil = (sessionDate - Date.now()) / 3600000;
    if (hoursUntil < 24) return res.status(400).json({ error: 'Cancellation requires 24 hours notice' });

    await db.execute({
      sql: `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?`,
      args: [reason, id],
    });

    // Free the slot
    await db.execute({ sql: `UPDATE schedule_slots SET is_booked = 0 WHERE id = ?`, args: [b.slot_id] });

    // Refund session
    await db.execute({
      sql: `UPDATE memberships SET sessions_used = sessions_used - 1 WHERE id = ?`,
      args: [b.membership_id],
    });

    // Delete Google Meet event
    if (b.google_event_id) await deleteMeetSession(b.google_event_id);

    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) {
    console.error('[bookings] cancel error:', err);
    res.status(500).json({ error: 'Cancellation failed. Please try again.' });
  }
});

// GET /api/bookings/my
router.get('/my', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const bookings = await db.execute({
      sql: `SELECT b.*, ss.date, ss.start_time, ss.end_time,
            COALESCE(u.name, 'Coach Removed') as coach_name,
            sn.notes as session_notes, sn.workout_done, sn.next_session_plan
            FROM bookings b
            JOIN schedule_slots ss ON ss.id = b.slot_id
            LEFT JOIN users u ON u.id = b.coach_id AND u.is_active = 1
            LEFT JOIN session_notes sn ON sn.booking_id = b.id
            WHERE b.customer_id = ?
            ORDER BY ss.date DESC, ss.start_time DESC`,
      args: [req.session.user.id],
    });
    res.json({ success: true, bookings: bookings.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// POST /api/bookings/notes/:bookingId  (coach adds notes)
router.post('/notes/:bookingId', requireCoach, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { notes, workout_done, next_session_plan } = req.body;
    const coachId = req.session.user.id;
    const db = getDb();

    const booking = await db.execute({
      sql: `SELECT * FROM bookings WHERE id = ? AND coach_id = ?`,
      args: [bookingId, coachId],
    });
    if (!booking.rows.length) return res.status(404).json({ error: 'Booking not found' });

    await db.execute({
      sql: `INSERT INTO session_notes (booking_id, coach_id, customer_id, notes, workout_done, next_session_plan)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(booking_id) DO UPDATE SET notes=excluded.notes,
            workout_done=excluded.workout_done, next_session_plan=excluded.next_session_plan`,
      args: [bookingId, coachId, booking.rows[0].customer_id, notes, workout_done, next_session_plan],
    });

    // Mark booking as completed
    await db.execute({ sql: `UPDATE bookings SET is_completed = 1 WHERE id = ?`, args: [bookingId] });

    // Check if this was their first completed session — lock coach
    const completedCount = await db.execute({
      sql: `SELECT COUNT(*) as count FROM bookings WHERE customer_id = ? AND is_completed = 1`,
      args: [booking.rows[0].customer_id],
    });

    res.json({ success: true, message: 'Session notes saved' });
  } catch (err) {
    console.error('[bookings] notes error:', err);
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

module.exports = router;
