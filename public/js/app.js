// ── FITANIYA GLOBAL JS ────────────────────────────────────────────────────

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

// ── Format date ───────────────────────────────────────────────────────────
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h);
  return `${hour > 12 ? hour - 12 : hour}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
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
