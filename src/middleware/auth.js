'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    if (req.headers['content-type']?.includes('application/json') || req.xhr) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  return requireRole('admin')(req, res, next);
}

function requireCoach(req, res, next) {
  return requireRole('admin', 'coach')(req, res, next);
}

function attachUser(req, res, next) {
  res.locals.user = req.session?.user || null;
  next();
}

module.exports = { requireAuth, requireRole, requireAdmin, requireCoach, attachUser };
