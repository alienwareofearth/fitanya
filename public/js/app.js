// ── FITANYA GLOBAL JS ────────────────────────────────────────────────────

// ── 24-hour page cache (localStorage) ────────────────────────────────────
const pageCache = {
  TTL: 24 * 60 * 60 * 1000,
  _key: k => 'fc_' + k,
  get(key) {
    try {
      const raw = localStorage.getItem(this._key(key));
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > this.TTL) { localStorage.removeItem(this._key(key)); return null; }
      return data;
    } catch { return null; }
  },
  set(key, data) {
    try { localStorage.setItem(this._key(key), JSON.stringify({ data, ts: Date.now() })); } catch {}
  },
  bust(key) { try { localStorage.removeItem(this._key(key)); } catch {} },
  // Returns human-readable age string like "2h ago" or "just now"
  ageLabel(key) {
    try {
      const raw = localStorage.getItem(this._key(key));
      if (!raw) return null;
      const ms = Date.now() - JSON.parse(raw).ts;
      if (ms < 60000)   return 'just now';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
      return Math.floor(ms / 3600000) + 'h ago';
    } catch { return null; }
  },
};

// ── API Helper ────────────────────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (r.status === 401) { window.location.href = '/login'; return; }
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (r.status === 401) { window.location.href = '/login'; return; }
    return r.json();
  },
  async put(url, data) {
    const r = await fetch(url, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE', credentials: 'include' });
    return r.json();
  },
  async upload(url, formData) {
    const r = await fetch(url, { method: 'POST', credentials: 'include', body: formData });
    return r.json();
  },
};

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✅', error: '❌', info: '🔥', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  // Use textContent for message to prevent XSS from API error strings
  const icon = document.createElement('span');
  icon.textContent = icons[type] || '💬';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(icon);
  el.appendChild(text);
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── Greeting ──────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

const QUOTES = [
  'Every rep counts. Every session matters.',
  'Your only competition is yesterday\'s you.',
  'Strong body, stronger mind.',
  'Consistency beats perfection every time.',
  'Pain is temporary. Fitness is forever.',
  'Champions train. Losers complain.',
  'One session at a time. One step at a time.',
  'Discipline is the bridge between goals and achievement.',
];

function getDailyQuote() {
  const idx = Math.floor(Date.now() / 86400000) % QUOTES.length;
  return QUOTES[idx];
}

// ── Sidebar Profile Pill ──────────────────────────────────────────────────
function _renderSidebarProfile(user) {
  const el = document.getElementById('sidebar-profile');
  if (!el || !user) return;
  const initial = (user.name || 'U').charAt(0).toUpperCase();
  const roleLabel = user.role === 'coach' ? 'Coach' : 'Member';
  el.innerHTML = `
    <div class="user-profile-pill">
      <div class="user-avatar">${initial}</div>
      <div class="user-info">
        <div class="user-display-name">${user.name || ''}</div>
        <span class="user-role-badge">${roleLabel}</span>
      </div>
    </div>
  `;
}

// ── Deletion warning banner ───────────────────────────────────────────────
function _showDeletionBanner(user) {
  if (!user?.pendingDeletion) return;
  const days = user.daysRemaining ?? 7;
  const existing = document.getElementById('deletion-banner');
  if (existing) return;
  const bar = document.createElement('div');
  bar.id = 'deletion-banner';
  bar.className = 'deletion-banner';
  const msg = document.createElement('span');
  msg.textContent = `⚠️ Your account is scheduled for deletion in ${days} day${days !== 1 ? 's' : ''}. All profile data will be erased. Bookings and payment records are kept.`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.style.cssText = 'background:#fff;color:#b91c1c;font-weight:700;flex-shrink:0';
  btn.textContent = 'Cancel Deletion';
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Cancelling…';
    const data = await api.post('/api/customer/account/cancel-deletion', {});
    if (data?.success) { bar.remove(); toast('Account deletion cancelled. Welcome back! 🎉', 'success'); }
    else { btn.disabled = false; btn.textContent = 'Cancel Deletion'; toast(data?.error || 'Failed', 'error'); }
  };
  bar.appendChild(msg);
  bar.appendChild(btn);
  // Insert before main-content or at top of body
  const main = document.querySelector('.main-content');
  if (main) main.prepend(bar);
  else document.body.prepend(bar);
}

// ── Topbar profile cache (30-min TTL) ────────────────────────────────────
const _TOPBAR_CACHE_KEY = 'ft_topbar_user';
const _TOPBAR_CACHE_TTL = 30 * 60 * 1000;

function _getTopbarCache() {
  try {
    const raw = localStorage.getItem(_TOPBAR_CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > _TOPBAR_CACHE_TTL) { localStorage.removeItem(_TOPBAR_CACHE_KEY); return null; }
    return data;
  } catch { return null; }
}

function _setTopbarCache(user) {
  try {
    localStorage.setItem(_TOPBAR_CACHE_KEY, JSON.stringify({
      data: { name: user.name, profile_picture: user.profile_picture, timezone: user.timezone },
      ts: Date.now(),
    }));
  } catch {}
}

function _clearTopbarCache() {
  try { localStorage.removeItem(_TOPBAR_CACHE_KEY); } catch {}
}

// ── Auth Guard ────────────────────────────────────────────────────────────
async function requireAuth(expectedRole = null) {
  const data = await api.get('/api/customer/profile');
  if (!data || !data.success) {
    window.location.href = '/login';
    return null;
  }
  if (data.user?.timezone) window.__userTz = data.user.timezone;
  _renderSidebarProfile(data.user);
  // Update topbar + cache (re-render in case name/avatar changed since cache)
  _setTopbarCache(data.user);
  _renderMobileTopbar(data.user);
  _showDeletionBanner(data.user);
  loadNotifCount();
  return data;
}

// ── Mobile top bar (global, all member pages) ─────────────────────────────
function _renderMobileTopbar(user) {
  if (!user) return;
  const firstName = user.name?.split(' ')[0] || 'there';

  // Greeting line — same style as dashboard: display font, orange name
  const greetEl = document.getElementById('mobile-topbar-greeting');
  if (greetEl) greetEl.innerHTML = `${getGreeting()}, <span class="tb-name">${firstName}!</span>`;

  // Quote line below the greeting
  const textEl = document.getElementById('mobile-topbar-text') || document.getElementById('mobile-topbar-mid');
  if (textEl && !document.getElementById('mobile-topbar-quote')) {
    const q = document.createElement('div');
    q.id = 'mobile-topbar-quote';
    q.textContent = getDailyQuote();
    textEl.appendChild(q);
  }

  // Avatar
  const avatarWrap = document.getElementById('mobile-topbar-avatar-wrap');
  if (avatarWrap) {
    if (user.profile_picture) {
      avatarWrap.innerHTML = `<img src="${user.profile_picture}" alt="Profile"
        style="width:38px;height:38px;border-radius:50%;object-fit:cover;border:2px solid var(--border);display:block">`;
    } else {
      const initial = (user.name || 'U').charAt(0).toUpperCase();
      avatarWrap.innerHTML = `<div class="user-avatar"
        style="width:38px;height:38px;font-size:15px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center">
        ${initial}</div>`;
    }
  }
}

async function _globalToggleNotif() {
  const panel = document.getElementById('global-notif-panel');
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  panel.style.display = isOpen ? 'none' : 'block';
  if (isOpen) return;

  const list = document.getElementById('global-notif-list');
  list.innerHTML = '<div class="spinner"></div>';
  const data = await api.get('/api/customer/notifications');
  if (!data?.notifications?.length) {
    list.innerHTML = '<p style="padding:20px;color:#666;text-align:center;font-size:13px">No notifications yet</p>';
    return;
  }
  list.innerHTML = data.notifications.map(n => {
    const dt = n.created_at ? new Date(n.created_at.replace(' ', 'T')) : null;
    const timeStr = dt && !isNaN(dt)
      ? dt.toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', hour12:true })
      : '';
    return `
    <div style="padding:13px 16px;border-bottom:1px solid var(--border);${!n.is_read ? 'background:rgba(255,92,0,.04)' : ''}">
      <div style="font-size:13px;font-weight:600;color:${n.is_read ? 'var(--text-dim)' : 'var(--white)'};margin-bottom:3px">${n.title || ''}</div>
      <div style="font-size:12px;color:var(--text-dim);line-height:1.4">${n.body || ''}</div>
      ${timeStr ? `<div style="font-size:11px;color:#555;margin-top:5px">${timeStr}</div>` : ''}
    </div>`;
  }).join('');
  // Mark all as read & hide dots
  api.post('/api/customer/notifications/read', {});
  document.querySelectorAll('.notif-dot').forEach(el => el.classList.add('hidden'));
}

// ── Logout ────────────────────────────────────────────────────────────────
async function logout() {
  _clearTopbarCache();
  const data = await api.post('/api/auth/logout');
  window.location.href = data?.redirect || '/login';
}

// ── Format currency ───────────────────────────────────────────────────────
function formatINR(amount) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

// ── Timezone ──────────────────────────────────────────────────────────────
// Set by each page after loading profile. Stored times are in IST (Asia/Kolkata).
window.__userTz = 'Asia/Kolkata';

const TZ_LABELS = {
  'Asia/Kolkata':        'IST — India Standard Time (UTC+5:30)',
  'America/New_York':    'EST — Eastern Time (UTC-5/4)',
  'America/Chicago':     'CST — Central Time (UTC-6/5)',
  'America/Los_Angeles': 'PST — Pacific Time (UTC-8/7)',
  'Europe/London':       'GMT — London (UTC+0/1)',
  'Asia/Dubai':          'GST — Gulf Standard Time (UTC+4)',
};

// ── Format date ───────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

// Timezone-aware session time display (stored times are in IST)
function formatSessionTime(timeStr, dateStr) {
  if (!timeStr || !dateStr) return formatTime(timeStr);
  try {
    const date = new Date(`${dateStr}T${timeStr}:00+05:30`);
    return date.toLocaleTimeString('en-US', {
      timeZone: window.__userTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch { return formatTime(timeStr); }
}

function formatSessionDate(dateStr, timeStr) {
  if (!dateStr) return formatDate(dateStr);
  try {
    const t = timeStr || '12:00';
    const date = new Date(`${dateStr}T${t}:00+05:30`);
    return date.toLocaleDateString('en-US', {
      timeZone: window.__userTz,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch { return formatDate(dateStr); }
}

function meetUrl(link) {
  return link || null;
}

// Returns true if the session started more than 1 hour ago (times stored in IST)
function isMeetExpired(dateStr, startTime) {
  if (!dateStr || !startTime) return false;
  const sessionStart = new Date(`${dateStr}T${startTime}:00+05:30`);
  return Date.now() > sessionStart.getTime() + 60 * 60 * 1000;
}

function tzLabel() {
  const tz = window.__userTz || 'Asia/Kolkata';
  const map = {
    'Asia/Kolkata': 'IST', 'America/New_York': 'EST', 'America/Chicago': 'CST',
    'America/Los_Angeles': 'PST', 'Europe/London': 'GMT', 'Asia/Dubai': 'GST',
    'Asia/Singapore': 'SGT', 'Australia/Sydney': 'AEST',
  };
  // Fallback: derive short label from the IANA tz name
  return map[tz] || tz.split('/').pop().replace(/_/g, ' ');
}

// ── Notification badge ────────────────────────────────────────────────────
async function loadNotifCount() {
  try {
    const data = await api.get('/api/customer/notifications');
    if (data?.unreadCount > 0) {
      document.querySelectorAll('.notif-dot').forEach(el => el.classList.remove('hidden'));
      document.querySelectorAll('.notif-count').forEach(el => el.textContent = data.unreadCount);
    }
  } catch {}
}

// ── Sidebar mobile toggle + global top bar ────────────────────────────────
function initSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  // Build the mobile top bar (contains hamburger + greeting + avatar + bell)
  if (!document.getElementById('mobile-topbar')) {
    const topbar = document.createElement('div');
    topbar.id = 'mobile-topbar';
    topbar.innerHTML = `
      <button id="sidebar-toggle" aria-label="Open menu">
        <span></span><span></span><span></span>
      </button>
      <div id="mobile-topbar-mid">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <img src="/icons/logo.png" alt="Fitanya" style="height:38px;width:auto;flex-shrink:0">
          <div id="mobile-topbar-text" style="min-width:0;overflow:hidden">
            <div id="mobile-topbar-greeting">Welcome</div>
          </div>
        </div>
      </div>
      <div id="mobile-topbar-right">
        <button class="notif-btn" onclick="_globalToggleNotif()" title="Notifications"
          style="width:36px;height:36px;font-size:17px;flex-shrink:0">
          🔔<span class="notif-dot hidden"></span>
        </button>
        <a href="/dashboard/profile" id="mobile-topbar-avatar-wrap" style="flex-shrink:0;text-decoration:none">
          <div class="user-avatar" style="width:36px;height:36px;font-size:15px;border-radius:50%;border:2px solid var(--border)">?</div>
        </a>
      </div>`;
    document.body.prepend(topbar);

    // Pre-render from cache immediately so greeting shows without waiting for API
    const _cachedUser = _getTopbarCache();
    if (_cachedUser) _renderMobileTopbar(_cachedUser);

    // Notification slide-down panel
    const notifPanel = document.createElement('div');
    notifPanel.id = 'global-notif-panel';
    notifPanel.innerHTML = `
      <div style="padding:12px 16px 8px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
        <span style="font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:1px">NOTIFICATIONS</span>
        <button onclick="document.getElementById('global-notif-panel').style.display='none'"
          style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;line-height:1;padding:0">✕</button>
      </div>
      <div id="global-notif-list"></div>`;
    document.body.appendChild(notifPanel);

    // Close notif panel when tapping outside
    document.addEventListener('click', e => {
      const panel = document.getElementById('global-notif-panel');
      if (panel && panel.style.display === 'block'
          && !panel.contains(e.target)
          && !e.target.closest('#mobile-topbar-right')) {
        panel.style.display = 'none';
      }
    });
  }

  // Backdrop overlay
  let backdrop = document.getElementById('sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }

  const toggle = document.getElementById('sidebar-toggle');
  const open  = () => { sidebar.classList.add('open'); backdrop.classList.add('visible'); };
  const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('visible'); };

  toggle?.addEventListener('click', e => { e.stopPropagation(); sidebar.classList.contains('open') ? close() : open(); });
  backdrop.addEventListener('click', close);

  sidebar.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', () => { if (window.innerWidth <= 768) close(); });
  });
}

// ── Set active nav item ────────────────────────────────────────────────────
function setActiveNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('href') || item.dataset.href;
    if (href && path === href) item.classList.add('active');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSidebarToggle();
  setActiveNav();
});
