'use strict';

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Install prompt ────────────────────────────────────────────────────────────
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  hideInstallBanner();
  _installPrompt = null;
});

function isAdminPage() {
  return window.location.pathname.startsWith('/admin');
}

function isHomePage() {
  const p = window.location.pathname;
  return p === '/' || p === '/index.html';
}

function showInstallBanner() {
  if (isAdminPage()) return;
  if (!isHomePage()) return;
  if (document.getElementById('pwa-install-bar')) return;
  // Don't show if already running as standalone (already installed)
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  const bar = document.createElement('div');
  bar.id = 'pwa-install-bar';
  bar.innerHTML = `
    <div style="
      position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:#1a1a1a;border-top:1px solid #FF5C00;
      padding:14px 20px;display:flex;align-items:center;justify-content:space-between;
      gap:12px;font-family:system-ui,sans-serif;
    ">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="/icons/icon.svg" width="40" height="40" style="border-radius:8px" onerror="this.style.display='none'">
        <div>
          <div style="color:#fff;font-weight:600;font-size:14px">Install Fitanya App</div>
          <div style="color:#888;font-size:12px">Add to home screen for the best experience</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button onclick="dismissInstallBanner()" style="background:none;border:1px solid #444;color:#888;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px">Not now</button>
        <button onclick="triggerInstall()" style="background:#FF5C00;border:none;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px">Install</button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);
}

function hideInstallBanner() {
  const bar = document.getElementById('pwa-install-bar');
  if (bar) bar.remove();
}

window.dismissInstallBanner = function() {
  hideInstallBanner();
  sessionStorage.setItem('pwa-dismissed', '1');
};

window.triggerInstall = async function() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  if (outcome === 'accepted') hideInstallBanner();
  _installPrompt = null;
};

// ── iOS manual instructions ───────────────────────────────────────────────────
// iOS Safari doesn't fire beforeinstallprompt — show a tip instead
function isIosSafari() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios/i.test(ua);
}

window.addEventListener('DOMContentLoaded', () => {
  if (isAdminPage()) return;
  if (!isHomePage()) return;
  if (sessionStorage.getItem('pwa-dismissed')) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  if (isIosSafari()) {
    const tip = document.createElement('div');
    tip.id = 'pwa-install-bar';
    tip.innerHTML = `
      <div style="
        position:fixed;bottom:0;left:0;right:0;z-index:9999;
        background:#1a1a1a;border-top:1px solid #FF5C00;
        padding:14px 20px;display:flex;align-items:center;justify-content:space-between;
        gap:12px;font-family:system-ui,sans-serif;
      ">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px">📲</span>
          <div>
            <div style="color:#fff;font-weight:600;font-size:14px">Install Fitanya on iPhone</div>
            <div style="color:#888;font-size:12px">Tap <strong style="color:#FF5C00">Share</strong> → <strong style="color:#FF5C00">Add to Home Screen</strong></div>
          </div>
        </div>
        <button onclick="dismissInstallBanner()" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;padding:0 4px">×</button>
      </div>
    `;
    document.body.appendChild(tip);
  }
});
