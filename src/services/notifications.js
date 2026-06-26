'use strict';

const { getDb } = require('../config/database');

/**
 * Create an in-app notification
 */
async function createNotification({ userId, type, title, body, link = null }) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)`,
    args: [userId, type, title, body, link],
  });
}

/**
 * Get unread count for a user
 */
async function getUnreadCount(userId) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0`,
    args: [userId],
  });
  return result.rows[0].count;
}

/**
 * Get all notifications for a user (paginated)
 */
async function getUserNotifications(userId, limit = 20, offset = 0) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    args: [userId, limit, offset],
  });
  return result.rows;
}

/**
 * Mark notifications as read
 */
async function markRead(userId, notificationIds = []) {
  const db = getDb();
  if (notificationIds.length) {
    const placeholders = notificationIds.map(() => '?').join(',');
    await db.execute({
      sql: `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`,
      args: [userId, ...notificationIds],
    });
  } else {
    await db.execute({
      sql: `UPDATE notifications SET is_read = 1 WHERE user_id = ?`,
      args: [userId],
    });
  }
}

// Shorthand helpers
const notify = {
  sessionBooked: (userId, date, time) =>
    createNotification({ userId, type: 'session', title: 'Session Confirmed 🎉',
      body: `Your session on ${date} at ${time} is confirmed!`, link: '/dashboard/schedule' }),

  sessionReminder: (userId, date, time) =>
    createNotification({ userId, type: 'reminder', title: 'Session Tomorrow ⏰',
      body: `Don't forget your session on ${date} at ${time}`, link: '/dashboard/schedule' }),

  paymentReceived: (userId, amount) =>
    createNotification({ userId, type: 'payment', title: 'Payment Confirmed ✅',
      body: `Payment of ₹${amount} received successfully.`, link: '/dashboard/membership' }),

  membershipExpiring: (userId, days) =>
    createNotification({ userId, type: 'membership', title: 'Membership Expiring Soon ⚠️',
      body: `Your membership expires in ${days} days. Renew now!`, link: '/dashboard/membership' }),

  coachAssigned: (userId, coachName) =>
    createNotification({ userId, type: 'coach', title: 'Coach Assigned 💪',
      body: `${coachName} has been assigned as your personal coach.`, link: '/dashboard/schedule' }),

  referralReward: (userId, amount) =>
    createNotification({ userId, type: 'reward', title: 'Referral Reward Earned 🎁',
      body: `₹${amount} credit added to your account!`, link: '/dashboard/membership' }),

  storyApproved: (userId) =>
    createNotification({ userId, type: 'story', title: 'Story Approved ✨',
      body: 'Your story/testimonial has been approved and is now live!', link: '/dashboard/stories' }),

  storyRejected: (userId, reason) =>
    createNotification({ userId, type: 'story', title: 'Story Not Approved',
      body: reason || 'Your story was not approved. Please review and resubmit.', link: '/dashboard/stories' }),

  newCustomer: (coachId, customerName) =>
    createNotification({ userId: coachId, type: 'customer', title: 'New Customer Assigned 👤',
      body: `${customerName} has been assigned to you.`, link: '/coach/customers' }),

  sessionNoteReminder: (coachId, customerName) =>
    createNotification({ userId: coachId, type: 'notes', title: 'Add Session Notes 📝',
      body: `Please add notes for your session with ${customerName}`, link: '/coach/sessions' }),
};

module.exports = { createNotification, getUnreadCount, getUserNotifications, markRead, notify };
