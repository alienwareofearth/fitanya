'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { upload, uploadBuffer } = require('../middleware/upload');

const router = express.Router();
const crypto = require('crypto');

// ── Health Sync — BEFORE requireAuth (accepts session OR personal token) ──────
// POST /api/customer/health/sync
// Called by iOS Shortcuts with ?token=<health_token> or X-Health-Token header
router.post('/health/sync', async (req, res) => {
  try {
    const db = getDb();
    let userId = req.session?.user?.id;

    if (!userId) {
      const token = req.headers['x-health-token'] || req.query.token || req.body?.token;
      if (!token) return res.status(401).json({ error: 'Auth token required' });
      const u = await db.execute({
        sql: `SELECT id FROM users WHERE health_token = ? AND is_active = 1 AND deleted_at IS NULL`,
        args: [token],
      });
      if (!u.rows.length) return res.status(401).json({ error: 'Invalid token' });
      userId = u.rows[0].id;
    }

    // Accept values from body OR query string (Shortcuts flexibility)
    const src = { ...req.query, ...req.body };
    const date = (src.date || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date required in YYYY-MM-DD format' });
    }

    // iOS may format decimals with comma in Indian locale ("6,2" instead of "6.2")
    const toNum  = v => parseFloat(String(v || 0).replace(',', '.')) || 0;
    const steps          = Math.max(0, Math.round(toNum(src.steps)));
    const calories       = Math.max(0, Math.round(toNum(src.calories)));
    const active_minutes = Math.max(0, Math.round(toNum(src.active_minutes)));
    const distance_km    = Math.max(0, Math.round(toNum(src.distance_km) * 100) / 100);

    await db.execute({
      sql: `INSERT INTO health_logs (user_id, date, steps, calories, active_minutes, distance_km, source, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, 'shortcut', datetime('now'))
            ON CONFLICT(user_id, date) DO UPDATE SET
              steps = excluded.steps,
              calories = excluded.calories,
              active_minutes = excluded.active_minutes,
              distance_km = excluded.distance_km,
              synced_at = datetime('now')`,
      args: [userId, date, steps, calories, active_minutes, distance_km],
    });

    res.json({ success: true, synced: { date, steps, calories, active_minutes, distance_km } });
  } catch (err) {
    console.error('[health] sync error:', err.message);
    res.status(500).json({ error: 'Sync failed. Please try again.' });
  }
});

// GET /api/customer/health/shortcut?token=<health_token>
// Returns a personalised .shortcut plist that iOS installs directly in the Shortcuts app
router.get('/health/shortcut', async (req, res) => {
  try {
    const db = getDb();
    let userId = req.session?.user?.id;
    let token  = req.query.token;

    if (!userId) {
      if (!token) return res.status(401).json({ error: 'Auth token required' });
      const u = await db.execute({
        sql: `SELECT id, health_token FROM users WHERE health_token = ? AND is_active = 1 AND deleted_at IS NULL`,
        args: [token],
      });
      if (!u.rows.length) return res.status(401).json({ error: 'Invalid token' });
      userId = u.rows[0].id;
    } else {
      // Session auth — look up or create token
      const u = await db.execute({ sql: `SELECT health_token FROM users WHERE id = ?`, args: [userId] });
      token = u.rows[0]?.health_token;
      if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        await db.execute({ sql: `UPDATE users SET health_token = ? WHERE id = ?`, args: [token, userId] });
      }
    }

    const appUrl  = process.env.APP_URL || 'http://localhost:3000';
    const syncUrl = `${appUrl}/api/customer/health/sync?token=${token}`;
    const plist   = buildShortcutPlist(syncUrl);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="Fitanya-Health-Sync.shortcut"');
    res.send(plist);
  } catch (err) {
    console.error('[health] shortcut error:', err.message);
    res.status(500).json({ error: 'Could not generate shortcut.' });
  }
});

function buildShortcutPlist(syncUrl) {
  // Use U+FFFC (Object Replacement Character) as variable placeholder
  const OBJ = '￼';

  // ── Helpers ───────────────────────────────────────────────────────────
  const setVar = name => `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.setvariable</string>
      <key>WFWorkflowActionParameters</key><dict><key>WFVariableName</key><string>${name}</string></dict>
    </dict>`;

  // Single-variable reference (for action inputs like WFInput)
  const varAttach = name => `<dict>
      <key>Value</key><dict><key>Type</key><string>Variable</string><key>VariableName</key><string>${name}</string></dict>
      <key>WFSerializationType</key><string>WFTextTokenAttachment</string>
    </dict>`;

  // XML-escape helper — & inside plist <string> tags must be &amp;
  const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Build a Text action with variable tokens at computed positions.
  // raw template (with OBJ chars) is used for position maths;
  // the plist <string> gets the XML-escaped version.
  const textActionWithVars = (template, varNames, outputName) => {
    const entries = [];
    let idx = 0;
    for (let i = 0; i < template.length; i++) {
      if (template[i] === OBJ) {
        entries.push(`<key>{${i}, 1}</key><dict><key>Type</key><string>Variable</string><key>VariableName</key><string>${varNames[idx++]}</string></dict>`);
      }
    }
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.text</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFTextActionText</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>attachmentsByRange</key><dict>${entries.join('')}</dict>
            <key>string</key><string>${xmlEsc(template)}</string>
          </dict>
          <key>WFSerializationType</key><string>WFTextTokenString</string>
        </dict>
        <key>CustomOutputName</key><string>${outputName}</string>
      </dict>
    </dict>
    ${setVar(outputName)}`;
  };

  // Health sample action — fetches today's cumulative total for an HK type
  const healthAction = (hkType, varName) => `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.gethealthsample</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFHealthCategoryKey</key><string>${hkType}</string>
        <key>WFHealthStartDate</key><dict><key>WFDateType</key><string>Start of Day</string></dict>
        <key>WFHealthEndDate</key><dict><key>WFDateType</key><string>Now</string></dict>
        <key>WFHealthQuantityAggregationStyle</key><integer>1</integer>
        <key>CustomOutputName</key><string>${varName}</string>
      </dict>
    </dict>
    ${setVar(varName)}`;

  // ── URL template (query params — no JSON body needed) ─────────────────
  // syncUrl already contains ?token=TOKEN; OBJ placeholders stay literal (U+FFFC is safe in XML)
  const urlTemplate = `${syncUrl}&date=${OBJ}&steps=${OBJ}&calories=${OBJ}&distance_km=${OBJ}&active_minutes=${OBJ}`;
  const urlVarNames = ['Today', 'Steps', 'Calories', 'Distance', 'ActiveMin'];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>

    <!-- 1. Get today's date and format it as yyyy-MM-dd -->
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.date</string>
      <key>WFWorkflowActionParameters</key><dict><key>CustomOutputName</key><string>NowDate</string></dict>
    </dict>
    ${setVar('NowDate')}
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.getformatteddate</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFDateFormatStyle</key><string>Custom</string>
        <key>WFDateFormat</key><string>yyyy-MM-dd</string>
        <key>WFInput</key>${varAttach('NowDate')}
        <key>CustomOutputName</key><string>Today</string>
      </dict>
    </dict>
    ${setVar('Today')}

    <!-- 2-5. Health samples -->
    ${healthAction('HKQuantityTypeIdentifierStepCount',               'Steps')}
    ${healthAction('HKQuantityTypeIdentifierActiveEnergyBurned',      'Calories')}
    ${healthAction('HKQuantityTypeIdentifierDistanceWalkingRunning',   'Distance')}
    ${healthAction('HKQuantityTypeIdentifierAppleExerciseTime',        'ActiveMin')}

    <!-- 6. Build sync URL with all params as query string (avoids JSON body complexity) -->
    ${textActionWithVars(urlTemplate, urlVarNames, 'SyncURL')}

    <!-- 7. POST to Fitanya (params already in URL, no body required) -->
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFHTTPMethod</key><string>POST</string>
        <key>WFURL</key>${varAttach('SyncURL')}
      </dict>
    </dict>

  </array>
  <key>WFWorkflowClientVersion</key><string>1282</string>
  <key>WFWorkflowHasShortcutInputVariables</key><false/>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>4282601983</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59511</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowInputContentItemClasses</key><array/>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowOutputContentItemClasses</key><array/>
  <key>WFWorkflowTypes</key><array/>
</dict>
</plist>`;
}

router.use(requireAuth);

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const [user, profile, membership] = await Promise.all([
      db.execute({ sql: `SELECT id, name, email, phone, role, timezone, profile_picture, referral_code, reward_credits, created_at, deleted_at, deletion_scheduled_at FROM users WHERE id = ?`, args: [userId] }),
      db.execute({ sql: `SELECT * FROM customer_profiles WHERE user_id = ?`, args: [userId] }),
      db.execute({
        sql: `SELECT m.*, p.name as package_name, p.sessions, u.name as coach_name
              FROM memberships m JOIN packages p ON p.id = m.package_id
              LEFT JOIN users u ON u.id = m.coach_id
              WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 1`,
        args: [userId],
      }),
    ]);
    const u = user.rows[0];
    const pendingDeletion = !!u.deleted_at && new Date(u.deletion_scheduled_at) > new Date();
    const daysRemaining = pendingDeletion
      ? Math.ceil((new Date(u.deletion_scheduled_at) - Date.now()) / 86400000)
      : null;
    res.json({ success: true, user: { ...u, pendingDeletion, daysRemaining }, profile: profile.rows[0], membership: membership.rows[0], prev_login: req.session.user.prev_login || null });
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.put('/profile', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const { name, phone, timezone, occupation, height, waist, thigh, arm, chest, age, weight, ideal_weight, address, health_issues, allergies, food_preference, food_specific, prior_experience, fitness_goal } = req.body;

    const VALID_TZ = ['Asia/Kolkata', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Asia/Dubai'];
    const tz = VALID_TZ.includes(timezone) ? timezone : 'Asia/Kolkata';
    const n = v => (v === undefined || v === '') ? null : v;

    await db.execute({ sql: `UPDATE users SET name=?, phone=?, timezone=?, updated_at=datetime('now') WHERE id=?`, args: [n(name), n(phone), tz, userId] });
    await db.execute({
      sql: `UPDATE customer_profiles SET occupation=?, height=?, waist=?, thigh=?, arm=?, chest=?, age=?, weight=?, ideal_weight=?, address=?, health_issues=?, allergies=?, food_preference=?, food_specific=?, prior_experience=?, fitness_goal=?, updated_at=datetime('now') WHERE user_id=?`,
      args: [n(occupation), n(height), n(waist), n(thigh), n(arm), n(chest), n(age), n(weight), n(ideal_weight), n(address), n(health_issues), n(allergies), n(food_preference), n(food_specific), n(prior_experience), n(fitness_goal), userId],
    });

    req.session.user.name = name || req.session.user.name;
    res.json({ success: true });
  } catch (err) { console.error('[customer] profile update error:', err.message); res.status(500).json({ error: 'Failed to save profile. Please try again.' }); }
});

// GET /api/customer/preferred-slot
router.get('/preferred-slot', async (req, res) => {
  try {
    const db = getDb();
    const row = await db.execute({ sql: `SELECT preferred_time FROM customer_profiles WHERE user_id = ?`, args: [req.session.user.id] });
    res.json({ success: true, preferred_time: row.rows[0]?.preferred_time || null });
  } catch (err) {
    console.error('[customer] preferred-slot GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch preferred slot' });
  }
});

// PUT /api/customer/preferred-slot
router.put('/preferred-slot', async (req, res) => {
  try {
    const db = getDb();
    const { preferred_time } = req.body;
    const time = (preferred_time && /^\d{2}:\d{2}$/.test(preferred_time)) ? preferred_time : null;
    await db.execute({ sql: `UPDATE customer_profiles SET preferred_time = ?, updated_at = datetime('now') WHERE user_id = ?`, args: [time, req.session.user.id] });
    res.json({ success: true, preferred_time: time });
  } catch (err) {
    console.error('[customer] preferred-slot PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save preferred slot' });
  }
});

router.post('/profile/picture', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { url } = await uploadBuffer(req.file.buffer, { folder: 'fitanya/avatars', transformation: [{ width: 400, height: 400, crop: 'fill' }] });
    const db = getDb();
    await db.execute({ sql: `UPDATE users SET profile_picture = ? WHERE id = ?`, args: [url, req.session.user.id] });
    req.session.user.profile_picture = url;
    res.json({ success: true, url });
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/customer/membership/switch-preview?package_id=X
router.get('/membership/switch-preview', async (req, res) => {
  try {
    const packageId = parseInt(req.query.package_id, 10);
    if (!packageId) return res.status(400).json({ error: 'package_id required' });
    const db = getDb();
    const userId = req.session.user.id;

    const pkg = await db.execute({
      sql: `SELECT * FROM packages WHERE id = ? AND is_active = 1`,
      args: [packageId],
    });
    if (!pkg.rows.length) return res.status(404).json({ error: 'Package not found' });

    const mem = await db.execute({
      sql: `SELECT m.id, m.sessions_total, m.sessions_used, p.price as original_price
            FROM memberships m JOIN packages p ON p.id = m.package_id
            WHERE m.user_id = ? AND m.status = 'active'
            ORDER BY m.created_at DESC LIMIT 1`,
      args: [userId],
    });

    let carryCredit = 0;
    let remainingSessions = 0;
    if (mem.rows.length) {
      const m = mem.rows[0];
      remainingSessions = Math.max(0, m.sessions_total - m.sessions_used);
      const pricePerSession = m.sessions_total > 0 ? m.original_price / m.sessions_total : 0;
      carryCredit = Math.floor(remainingSessions * pricePerSession);
    }

    const p = pkg.rows[0];
    res.json({
      success: true,
      package: p,
      carryCredit,
      remainingSessions,
      finalPrice: Math.max(0, p.price - carryCredit),
    });
  } catch (err) { console.error('[customer] switch-preview error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.post('/progress', async (req, res) => {
  try {
    const { weight, steps, waist, thigh, arm, chest, notes } = req.body;
    const db = getDb();
    const now = new Date();
    const weekNumber = getWeekNumber(now);
    const year = now.getFullYear();

    // Convert empty strings to null so numeric columns never receive ''
    const n = v => (v === '' || v === undefined) ? null : v;

    await db.execute({
      sql: `INSERT INTO progress_logs (user_id, week_number, year, log_date, weight, steps, waist, thigh, arm, chest, notes)
            VALUES (?, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, week_number, year) DO UPDATE SET
            weight=excluded.weight, steps=excluded.steps, waist=excluded.waist,
            thigh=excluded.thigh, arm=excluded.arm, chest=excluded.chest, notes=excluded.notes,
            log_date=date('now')`,
      args: [req.session.user.id, weekNumber, year, n(weight), n(steps), n(waist), n(thigh), n(arm), n(chest), n(notes)],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[customer] POST /progress error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to save progress. Please try again.' });
  }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
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
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    const { getUserNotifications, getUnreadCount, markRead } = require('../services/notifications');
    const notifications = await getUserNotifications(req.session.user.id);
    const unreadCount = await getUnreadCount(req.session.user.id);
    res.json({ success: true, notifications, unreadCount });
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

router.post('/notifications/read', async (req, res) => {
  try {
    const { markRead } = require('../services/notifications');
    await markRead(req.session.user.id, req.body.ids || []);
    res.json({ success: true });
  } catch (err) { console.error('[customer]', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── Health Logs & Token (after requireAuth) ───────────────────────────────────

// GET /api/customer/health/logs?days=30
router.get('/health/logs', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || 30, 10), 90);
    const db = getDb();
    const logs = await db.execute({
      sql: `SELECT * FROM health_logs WHERE user_id = ? ORDER BY date DESC LIMIT ?`,
      args: [req.session.user.id, days],
    });
    res.json({ success: true, logs: logs.rows });
  } catch (err) { console.error('[health] logs error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/customer/health/token — get or auto-generate token
router.get('/health/token', async (req, res) => {
  try {
    const db = getDb();
    const u = await db.execute({ sql: `SELECT health_token FROM users WHERE id = ?`, args: [req.session.user.id] });
    let token = u.rows[0]?.health_token;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await db.execute({ sql: `UPDATE users SET health_token = ? WHERE id = ?`, args: [token, req.session.user.id] });
    }
    res.json({ success: true, token });
  } catch (err) { console.error('[health] token error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// POST /api/customer/health/token/regenerate
router.post('/health/token/regenerate', async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const db = getDb();
    await db.execute({ sql: `UPDATE users SET health_token = ? WHERE id = ?`, args: [token, req.session.user.id] });
    res.json({ success: true, token });
  } catch (err) { console.error('[health] regenerate error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// ── Account Deletion ──────────────────────────────────────────────────────────

// POST /api/customer/account/request-deletion
router.post('/account/request-deletion', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    if (userId === 0) return res.status(403).json({ error: 'Admin account cannot be deleted' });

    await db.execute({
      sql: `UPDATE users SET deleted_at = datetime('now'), deletion_scheduled_at = datetime('now', '+7 days') WHERE id = ?`,
      args: [userId],
    });
    res.json({ success: true, message: 'Account deletion scheduled. You have 7 days to recover it.' });
  } catch (err) { console.error('[customer] request-deletion error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// POST /api/customer/account/cancel-deletion
router.post('/account/cancel-deletion', async (req, res) => {
  try {
    const db = getDb();
    await db.execute({
      sql: `UPDATE users SET deleted_at = NULL, deletion_scheduled_at = NULL WHERE id = ?`,
      args: [req.session.user.id],
    });
    res.json({ success: true, message: 'Account deletion cancelled. Your account is fully restored.' });
  } catch (err) { console.error('[customer] cancel-deletion error:', err.message); res.status(500).json({ error: 'Request failed. Please try again.' }); }
});

// GET /api/customer/monthly-games
router.get('/monthly-games', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;

    // Get active game (or most recent one so members can see results)
    const gameRes = await db.execute(`
      SELECT * FROM monthly_games
      WHERE is_active=1 OR end_date >= date('now','-30 days')
      ORDER BY is_active DESC, created_at DESC LIMIT 1
    `);
    const game = gameRes.rows[0] || null;
    if (!game) return res.json({ success: true, game: null, progress: null });

    // Rule: 1 session per day for every day of the challenge.
    // All date comparisons use the member's own timezone so their local calendar is respected.
    const profileRes = await db.execute({
      sql: `SELECT timezone FROM users WHERE id = ?`,
      args: [userId],
    });
    const userTz = profileRes.rows[0]?.timezone || 'Asia/Kolkata';

    // "today" in the member's local timezone (YYYY-MM-DD)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: userTz }).format(new Date());

    const msPerDay = 86400000;
    const startDt  = new Date(game.start_date + 'T00:00:00');
    const endDt    = new Date(game.end_date   + 'T00:00:00');
    const todayDt  = new Date(today           + 'T00:00:00');
    const totalDays = Math.round((endDt - startDt) / msPerDay) + 1;

    // Strictly-past days inside the challenge (yesterday and before in the member's TZ).
    // Today is excluded — they still have time to complete today's session.
    let strictPastDays = 0;
    if (todayDt > startDt) {
      strictPastDays = Math.min(Math.round((todayDt - startDt) / msPerDay), totalDays);
    }

    // Distinct days within the challenge where the member had a non-cancelled session.
    // We count any attended/booked (non-cancelled) session whose date has passed —
    // not just is_completed=1 (which only gets set when coach saves notes).
    const upperBound = today <= game.end_date ? today : game.end_date;
    const completedDatesRes = await db.execute({
      sql: `SELECT DISTINCT s.date FROM bookings b
            JOIN schedule_slots s ON b.slot_id = s.id
            WHERE b.customer_id=? AND b.status != 'cancelled'
              AND s.date >= ? AND s.date <= ?
            ORDER BY s.date`,
      args: [userId, game.start_date, upperBound],
    });
    const completedDates = completedDatesRes.rows.map(r => r.date);
    const completedDays  = completedDates.length;
    // Only past days (before today in the member's TZ) with no completed session are "missed"
    const missedDays = Math.max(0, strictPastDays - completedDates.filter(d => d < today).length);

    const ended   = today > game.end_date;
    const started = today >= game.start_date;

    let status = 'upcoming';
    if (started && !ended) {
      status = missedDays > 0 ? 'failed' : 'in_progress';
    } else if (ended) {
      status = completedDays === totalDays ? 'won' : (missedDays > 0 ? 'failed' : 'ended');
    }

    // Check if admin has already marked them a winner
    const winnerRow = await db.execute({
      sql: `SELECT is_winner FROM monthly_game_participants WHERE game_id=? AND user_id=?`,
      args: [game.id, userId],
    });
    const officialWinner = winnerRow.rows[0]?.is_winner === 1;

    res.json({
      success: true,
      game: game.is_active ? game : null,
      progress: {
        totalDays, completedDays, missedDays,
        daysElapsed: strictPastDays,
        completedDates, status, officialWinner,
        game_id: game.id, start_date: game.start_date, end_date: game.end_date,
        today, userTz,
      },
      recentGame: game,
    });
  } catch (err) { console.error('[customer] monthly-games:', err.message); res.status(500).json({ error: 'Failed to load.' }); }
});

module.exports = router;
