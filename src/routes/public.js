'use strict';

const express = require('express');
const { getDb } = require('../config/database');

const router = express.Router();

// GET /api/public/workout-styles
router.get('/workout-styles', async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(`SELECT * FROM workout_styles WHERE is_active = 1 ORDER BY sort_order`);
    res.json({ success: true, styles: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/public/packages
router.get('/packages', async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(`SELECT * FROM packages WHERE is_active = 1 ORDER BY sort_order`);
    res.json({ success: true, packages: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/public/stories (approved only, latest 3 per user — max 9 total)
router.get('/stories', async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(`
      SELECT s.*, u.name as user_name, u.profile_picture
      FROM stories s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'approved'
      ORDER BY s.reviewed_at DESC LIMIT 9`);
    res.json({ success: true, stories: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
