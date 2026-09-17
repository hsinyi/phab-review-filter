'use strict';

// ── config ────────────────────────────────────────────────────────────────────
const BUDGET = 40;           // monthly review budget
const STORAGE_PREFIX = 'prat_count_';  // key = prat_count_YYYY-MM

// ── inject XHR interceptor into the page context ──────────────────────────────
// Content scripts run in an isolated sandbox; we need a page-world script to
// wrap XMLHttpRequest before Phabricator's Javelin code uses it.

(function injectInterceptor() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('interceptor.js');
  (document.head || document.documentElement).appendChild(s);
  s.remove();
})();

// ── storage helpers ───────────────────────────────────────────────────────────

function monthKey() {
  const d = new Date();
  return STORAGE_PREFIX + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function getCount() {
  return parseInt(localStorage.getItem(monthKey()) || '0', 10);
}

function incrementCount() {
  const key = monthKey();
  const next = getCount() + 1;
  localStorage.setItem(key, String(next));
  return next;
}

// ── badge ─────────────────────────────────────────────────────────────────────

let badge = null;

function createBadge() {
  badge = document.createElement('div');
  badge.id = 'prat-badge';
  badge.innerHTML = `
    <span id="prat-label"></span>
    <div id="prat-bar-track"><div id="prat-bar-fill"></div></div>
  `;
  document.body.appendChild(badge);
}

function updateBadge(count) {
  if (!badge) return;
  const pct = Math.min(count / BUDGET, 1);
  const label = document.getElementById('prat-label');
  const fill  = document.getElementById('prat-bar-fill');

  label.textContent = `Reviews ${count} / ${BUDGET}`;
  fill.style.width  = (pct * 100) + '%';

  badge.className = pct < 0.7 ? 'prat-ok' : pct < 1 ? 'prat-warn' : 'prat-over';
}

// ── listen for review actions from interceptor ────────────────────────────────

document.addEventListener('prat-review-action', () => {
  const n = incrementCount();
  updateBadge(n);
  console.debug('[prat] review action recorded —', n, '/', BUDGET);
});

// ── boot ──────────────────────────────────────────────────────────────────────

function init() {
  createBadge();
  updateBadge(getCount());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
