'use strict';
/**
 * One-time cleanup: fix users who ended up with multiple active/pending memberships.
 *
 * Run against production:
 *   NODE_ENV=production node scripts/fix-duplicate-memberships.js
 *
 * Run against local dev SQLite:
 *   node scripts/fix-duplicate-memberships.js
 */

require('dotenv').config();
const { getDb } = require('../src/config/database');

async function main() {
  const db = getDb();
  console.log('\n🔍 Scanning for duplicate memberships...\n');

  // Find all users with more than 1 active or pending membership
  const dupes = await db.execute(`
    SELECT user_id, COUNT(*) as cnt,
           GROUP_CONCAT(id || ':' || status || ':' || created_at, ' | ') as details
    FROM memberships
    WHERE status IN ('active', 'pending')
    GROUP BY user_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  if (!dupes.rows.length) {
    console.log('✅ No duplicate active/pending memberships found. All clean!\n');
    process.exit(0);
  }

  console.log(`Found ${dupes.rows.length} user(s) with duplicate memberships:\n`);

  for (const row of dupes.rows) {
    const { user_id, cnt, details } = row;

    // Get user info for display
    const userRow = await db.execute({
      sql: `SELECT name, email FROM users WHERE id = ?`,
      args: [user_id],
    });
    const user = userRow.rows[0];
    console.log(`User: ${user?.name} <${user?.email}> (id=${user_id}) — ${cnt} memberships`);
    console.log(`  ${details}`);

    // Keep the newest active membership; expire the rest
    // If no active, keep newest pending; cancel the rest
    await db.execute({
      sql: `UPDATE memberships
            SET status = CASE
              WHEN status = 'active' THEN 'expired'
              ELSE 'cancelled'
            END,
            updated_at = datetime('now')
            WHERE user_id = ?
              AND status IN ('active', 'pending')
              AND id != (
                SELECT id FROM memberships
                WHERE user_id = ? AND status IN ('active', 'pending')
                ORDER BY
                  CASE status WHEN 'active' THEN 0 ELSE 1 END,
                  created_at DESC
                LIMIT 1
              )`,
      args: [user_id, user_id],
    });

    // Show what we kept
    const kept = await db.execute({
      sql: `SELECT id, status, package_id, sessions_total, start_date, end_date FROM memberships
            WHERE user_id = ? AND status IN ('active', 'pending')`,
      args: [user_id],
    });
    console.log(`  ✅ Kept: id=${kept.rows[0]?.id} status=${kept.rows[0]?.status} sessions=${kept.rows[0]?.sessions_total} ends=${kept.rows[0]?.end_date}`);
    console.log('');
  }

  console.log('✅ Cleanup complete.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
