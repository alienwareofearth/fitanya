'use strict';

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (db) return db;
  const isDev = (process.env.NODE_ENV || 'development') === 'development';
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (!isDev && tursoUrl && tursoToken) {
    db = createClient({ url: tursoUrl, authToken: tursoToken });
    console.log('[db] Connected to Turso cloud database');
  } else {
    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'dev_db.json');
    db = createClient({ url: `file:${dbPath}` });
    console.log(`[db] Using local dev database at ${dbPath}`);
  }
  return db;
}

async function initDb() {
  const client = getDb();

  // Users
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    profile_picture TEXT,
    referral_code TEXT UNIQUE,
    referred_by INTEGER REFERENCES users(id),
    reward_credits REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    otp TEXT,
    otp_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Customer profiles (extended data from registration form)
  await client.execute(`CREATE TABLE IF NOT EXISTS customer_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    occupation TEXT,
    height REAL,
    waist REAL,
    thigh REAL,
    arm REAL,
    chest REAL,
    age INTEGER,
    gender TEXT,
    weight REAL,
    address TEXT,
    health_issues TEXT,
    allergies TEXT,
    food_preference TEXT,
    food_specific TEXT,
    prior_experience TEXT,
    date_of_birth TEXT,
    fitness_goal TEXT,
    ideal_weight REAL,
    queries TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migrate: add ideal_weight if it doesn't exist (for existing databases)
  try {
    await client.execute(`ALTER TABLE customer_profiles ADD COLUMN ideal_weight REAL`);
  } catch (_) { /* column already exists */ }

  // Migrate: add last_login_at to users
  try {
    await client.execute(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
  } catch (_) { /* column already exists */ }

  // Migrate: add is_trial flag to memberships
  try {
    await client.execute(`ALTER TABLE memberships ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0`);
  } catch (_) { /* column already exists */ }

  // Migrate: add assigned_coach_id to users so coach assignment works without a membership
  try {
    await client.execute(`ALTER TABLE users ADD COLUMN assigned_coach_id INTEGER REFERENCES users(id)`);
  } catch (_) { /* column already exists */ }

  // Migrate: add is_trial flag to packages
  try {
    await client.execute(`ALTER TABLE packages ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0`);
    // Mark the Free Trial package as trial
    await client.execute(`UPDATE packages SET is_trial = 1 WHERE name = 'Free Trial'`);
  } catch (_) { /* column already exists */ }

  // Coach profiles
  await client.execute(`CREATE TABLE IF NOT EXISTS coach_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bio TEXT,
    specializations TEXT,
    certifications TEXT,
    profile_picture TEXT,
    is_available INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Workout styles (admin managed)
  await client.execute(`CREATE TABLE IF NOT EXISTS workout_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    image_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Packages (admin managed)
  await client.execute(`CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sessions INTEGER NOT NULL,
    days INTEGER NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    features TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Discount codes
  await client.execute(`CREATE TABLE IF NOT EXISTS discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'percentage',
    value REAL NOT NULL,
    min_amount REAL DEFAULT 0,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    applies_to TEXT DEFAULT 'all',
    package_id INTEGER REFERENCES packages(id),
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Memberships
  await client.execute(`CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    package_id INTEGER NOT NULL REFERENCES packages(id),
    coach_id INTEGER REFERENCES users(id),
    sessions_total INTEGER NOT NULL,
    sessions_used INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Payments
  await client.execute(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    membership_id INTEGER REFERENCES memberships(id),
    amount REAL NOT NULL,
    discount_amount REAL NOT NULL DEFAULT 0,
    credits_used REAL NOT NULL DEFAULT 0,
    final_amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'phonepe',
    status TEXT NOT NULL DEFAULT 'pending',
    transaction_id TEXT,
    phonepe_response TEXT,
    discount_code_id INTEGER REFERENCES discount_codes(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Coach schedules (slots admin/coach opens)
  await client.execute(`CREATE TABLE IF NOT EXISTS schedule_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    is_booked INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Bookings
  await client.execute(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    membership_id INTEGER NOT NULL REFERENCES memberships(id),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    coach_id INTEGER NOT NULL REFERENCES users(id),
    slot_id INTEGER NOT NULL REFERENCES schedule_slots(id),
    status TEXT NOT NULL DEFAULT 'confirmed',
    meet_link TEXT,
    google_event_id TEXT,
    is_trial INTEGER NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0,
    cancelled_at TEXT,
    cancel_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Session notes (coach adds after session)
  await client.execute(`CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
    coach_id INTEGER NOT NULL REFERENCES users(id),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    notes TEXT NOT NULL,
    workout_done TEXT,
    next_session_plan TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Progress tracking
  await client.execute(`CREATE TABLE IF NOT EXISTS progress_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    week_number INTEGER NOT NULL,
    year INTEGER NOT NULL,
    log_date TEXT NOT NULL,
    weight REAL,
    steps INTEGER,
    waist REAL,
    thigh REAL,
    arm REAL,
    chest REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, week_number, year)
  )`);

  // Water hydration logs
  await client.execute(`CREATE TABLE IF NOT EXISTS hydration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    log_date TEXT NOT NULL,
    glasses INTEGER NOT NULL DEFAULT 0,
    goal_glasses INTEGER NOT NULL DEFAULT 8,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, log_date)
  )`);

  // Diet plans (admin managed base templates)
  await client.execute(`CREATE TABLE IF NOT EXISTS diet_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    food_preference TEXT NOT NULL,
    fitness_goal TEXT,
    calories_per_day REAL,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Diet meals (daily meals per plan)
  await client.execute(`CREATE TABLE IF NOT EXISTS diet_meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    diet_plan_id INTEGER NOT NULL REFERENCES diet_plans(id) ON DELETE CASCADE,
    day_of_week TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    calories REAL,
    recipe TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Stories / testimonials
  await client.execute(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT,
    body TEXT NOT NULL,
    photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Notifications
  await client.execute(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    link TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Referral rewards config (admin managed)
  await client.execute(`CREATE TABLE IF NOT EXISTS referral_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_type TEXT NOT NULL DEFAULT 'credit',
    reward_value REAL NOT NULL DEFAULT 500,
    min_purchase REAL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Referrals tracking
  await client.execute(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL REFERENCES users(id),
    referee_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    reward_credited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Sessions table for express-session
  await client.execute(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired_at TEXT NOT NULL
  )`);

  // Seed default data
  await seedDefaults(client);

  console.log('[db] Schema initialised ✅');
}

async function seedDefaults(client) {
  // Default workout styles
  const styles = await client.execute(`SELECT COUNT(*) as count FROM workout_styles`);
  if (styles.rows[0].count === 0) {
    await client.executeMultiple(`
      INSERT INTO workout_styles (name, description, icon, sort_order) VALUES ('Get Lean', 'Burn fat and reveal a lean, defined physique through targeted cardio and strength training.', '🔥', 1);
      INSERT INTO workout_styles (name, description, icon, sort_order) VALUES ('Build Muscle', 'Gain mass and strength with progressive overload and structured hypertrophy training.', '💪', 2);
      INSERT INTO workout_styles (name, description, icon, sort_order) VALUES ('Tone & Sculpt', 'Shape and define your body with a perfect blend of resistance and cardio training.', '⚡', 3);
      INSERT INTO workout_styles (name, description, icon, sort_order) VALUES ('Improve Fitness', 'Boost your overall endurance, flexibility, and cardiovascular health.', '🏃', 4);
    `);
  }

  // Default packages
  const pkgs = await client.execute(`SELECT COUNT(*) as count FROM packages`);
  if (pkgs.rows[0].count === 0) {
    await client.executeMultiple(`
      INSERT INTO packages (name, sessions, days, price, description, sort_order) VALUES ('Free Trial', 1, 30, 0, '1 free session to experience Fitanya', 0);
      INSERT INTO packages (name, sessions, days, price, description, sort_order) VALUES ('Starter', 12, 15, 5000, '12 personal training sessions over 15 days', 1);
      INSERT INTO packages (name, sessions, days, price, description, sort_order) VALUES ('Growth', 16, 24, 6000, '16 personal training sessions over 24 days', 2);
      INSERT INTO packages (name, sessions, days, price, description, sort_order) VALUES ('Elite', 24, 40, 8000, '24 personal training sessions over 40 days', 3);
    `);
  }

  // Ensure Free Trial package always exists (for existing DBs)
  const trialPkg = await client.execute(`SELECT id FROM packages WHERE name = 'Free Trial' LIMIT 1`);
  if (trialPkg.rows.length === 0) {
    await client.execute(`INSERT INTO packages (name, sessions, days, price, description, sort_order) VALUES ('Free Trial', 1, 30, 0, '1 free session to experience Fitanya', 0)`);
  }

  // Default referral config
  const ref = await client.execute(`SELECT COUNT(*) as count FROM referral_config`);
  if (ref.rows[0].count === 0) {
    await client.execute(`INSERT INTO referral_config (reward_type, reward_value, is_active) VALUES ('credit', 500, 1)`);
  }
}

module.exports = { getDb, initDb };
