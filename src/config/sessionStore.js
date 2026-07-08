'use strict';

const { Store } = require('express-session');
const { getDb } = require('./database');

class TursoSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.ttl = options.ttl || 86400;
    // Clean expired sessions every hour
    setInterval(() => this.clearExpired(), 3600000);
  }

  async get(sid, cb) {
    try {
      const db = getDb();
      const result = await db.execute({
        sql: `SELECT sess FROM sessions WHERE sid = ? AND expired_at > datetime('now')`,
        args: [sid],
      });
      if (!result.rows.length) return cb(null, null);
      cb(null, JSON.parse(result.rows[0].sess));
    } catch (err) { cb(err); }
  }

  async set(sid, session, cb) {
    try {
      const db = getDb();
      const expiredAt = new Date(Date.now() + this.ttl * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)
              ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired_at = excluded.expired_at`,
        args: [sid, JSON.stringify(session), expiredAt],
      });
      cb(null);
    } catch (err) { cb(err); }
  }

  async destroy(sid, cb) {
    try {
      const db = getDb();
      await db.execute({ sql: `DELETE FROM sessions WHERE sid = ?`, args: [sid] });
      cb(null);
    } catch (err) { cb(err); }
  }

  // regenerate: destroy current session and create a new empty one
  regenerate(req, cb) {
    const oldSid = req.sessionID;
    this.destroy(oldSid, (err) => {
      if (err) return cb(err);
      // express-session will generate a new sid and call set() automatically
      req.session = req.sessionStore.generate(req);
      cb(null);
    });
  }

  async clearExpired() {
    try {
      const db = getDb();
      await db.execute(`DELETE FROM sessions WHERE expired_at <= datetime('now')`);
    } catch (err) {
      console.error('[session-store] clearExpired error:', err);
    }
  }
}

module.exports = TursoSessionStore;
