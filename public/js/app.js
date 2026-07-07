// ── FITANYA GLOBAL JS ────────────────────────────────────────────────────

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
  el.innerHTML = `<span>${icons[type] || '💬'}</span><span>${message}</span>`;
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

// ── Auth Guard ────────────────────────────────────────────────────────────
async function requireAuth(expectedRole = null) {
  const data = await api.get('/api/customer/profile');
  if (!data || !data.success) {
    window.location.href = '/login';
    return null;
  }
  return data;
}

// ── Logout ────────────────────────────────────────────────────────────────
async function logout() {
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

function tzLabel() {
  const tz = window.__userTz;
  if (tz === 'Asia/Kolkata') return 'IST';
  if (tz === 'America/New_York') return 'EST';
  if (tz === 'America/Chicago') return 'CST';
  if (tz === 'America/Los_Angeles') return 'PST';
  if (tz === 'Europe/London') return 'GMT';
  if (tz === 'Asia/Dubai') return 'GST';
  return tz;
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

// ── Sidebar mobile toggle ─────────────────────────────────────────────────
function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (!sidebar.contains(e.target) && !toggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  }
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
