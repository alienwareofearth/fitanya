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
  } catch (err) { console.error('[public] workout-styles:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/public/packages
router.get('/packages', async (req, res) => {
  try {
    const db = getDb();
    const result = await db.execute(`SELECT * FROM packages WHERE is_active = 1 ORDER BY sort_order`);
    res.json({ success: true, packages: result.rows });
  } catch (err) { console.error('[public] packages:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[public] stories:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/public/winners — first names of winners from the most recent completed game
// Only returned if winners were declared within the last 5 days
router.get('/winners', async (req, res) => {
  try {
    const db = getDb();
    // Get the most recent game that has winners declared
    const gameRes = await db.execute(`
      SELECT id, winners_declared_at FROM monthly_games
      WHERE winners_declared_at IS NOT NULL
      ORDER BY winners_declared_at DESC LIMIT 1`);
    if (!gameRes.rows.length) return res.json({ success: true, winners: [] });

    const game = gameRes.rows[0];
    // Only show banner/popup within 5 days of publishing winners
    const declaredAt = new Date(game.winners_declared_at.replace(' ', 'T') + 'Z');
    const daysSince = (Date.now() - declaredAt.getTime()) / 86400000;
    if (daysSince > 5) return res.json({ success: true, winners: [], expired: true });

    const result = await db.execute({
      sql: `SELECT u.name FROM monthly_game_participants mgp
            JOIN users u ON u.id = mgp.user_id
            WHERE mgp.is_winner = 1 AND mgp.game_id = ?
            ORDER BY u.name`,
      args: [game.id],
    });
    const names = result.rows.map(r => r.name?.split(' ')[0] || r.name).filter(Boolean);
    res.json({ success: true, winners: names, gameId: game.id, declaredAt: game.winners_declared_at });
  } catch (err) { console.error('[public] winners:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

module.exports = router;
