'use strict';

// ── user detection ────────────────────────────────────────────────────────────
// Reads the logged-in Phabricator username from the nav bar profile link,
// which Phabricator renders as <a href="/p/username/">.
// Scoped to the header/nav to avoid picking up other users' links in content.

function detectCurrentUser() {
  const nav = document.querySelector(
    '.phabricator-main-menu, .phui-navigation-shell, nav, header'
  );
  const scope = nav || document;
  for (const a of scope.querySelectorAll('a[href]')) {
    const m = (a.getAttribute('href') || '').match(/^\/p\/([^/]+)\/?$/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ── config ────────────────────────────────────────────────────────────────────
const DEFAULT_HOURS = 24;  // hide reviews newer than this many hours
// Experimenter toggle: Alt+Shift+F (not shown in the page UI)

// Current user. Hard-coded to 'smaug' for the experiment.
// To switch to whoever is logged in, swap the two lines below:
const CURRENT_USER = 'smaug';
// const CURRENT_USER = detectCurrentUser();
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY_HOURS  = 'praf_threshold_hours';
const STORAGE_KEY_ACTIVE = 'praf_active';

// ── date parsing ──────────────────────────────────────────────────────────────
// Handles Phabricator display formats:
//   "Wed, Sep 16, 12:20 PM"   (no year)
//   "Sep 16"                   (no year, no time)
//   "Jan 1, 2025"              (past year)

const MONTH = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function parseTextDate(raw) {
  if (!raw) return null;
  let text = raw.trim();
  text = text.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+/i, '');

  const m = text.match(
    /^([A-Za-z]{3})\s+(\d{1,2})(?:,?\s+(?:(\d{4})|(\d{1,2}:\d{2}\s*[APap][Mm])))?(?:,?\s+(\d{1,2}:\d{2}\s*[APap][Mm]))?/
  );
  if (!m) return null;

  const month = MONTH[m[1].toLowerCase()];
  if (month === undefined) return null;

  const day  = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();

  let hours = 0, mins = 0;
  const timeStr = m[4] || m[5];
  if (timeStr) {
    const t = timeStr.match(/(\d+):(\d+)\s*([APap][Mm])/);
    if (t) {
      hours = parseInt(t[1], 10);
      mins  = parseInt(t[2], 10);
      const pm = t[3].toUpperCase() === 'PM';
      if (pm && hours !== 12) hours += 12;
      if (!pm && hours === 12) hours = 0;
    }
  }

  const d = new Date(year, month, day, hours, mins);
  return isNaN(d) ? null : d.getTime();
}

// ── relative date parsing ─────────────────────────────────────────────────────
// Handles formats Phabricator switches to after midnight:
//   "Yesterday, 12:20 PM"  "Today, 12:20 PM"  "12:20 PM"
//   "14 hours ago"  "5 minutes ago"  "2 days ago"  "Just now"

function parseRelativeDate(raw) {
  if (!raw) return null;
  const text = raw.trim();
  const now = Date.now();

  if (/^just now$/i.test(text)) return now;

  // "X minutes/hours/days ago"
  const rel = text.match(/^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = {second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5};
    return now - n * ms[unit];
  }

  // Extract optional time suffix "12:20 PM"
  function applyTime(base, timeStr) {
    if (!timeStr) return base;
    const t = timeStr.match(/(\d+):(\d+)\s*([APap][Mm])/);
    if (!t) return base;
    let h = parseInt(t[1], 10), m = parseInt(t[2], 10);
    const pm = t[3].toUpperCase() === 'PM';
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    const d = new Date(base);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // "Yesterday[, 12:20 PM]"
  const yest = text.match(/^yesterday(?:,?\s*(.+))?$/i);
  if (yest) {
    const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
    return applyTime(d.getTime(), yest[1]);
  }

  // "Today[, 12:20 PM]"
  const tod = text.match(/^today(?:,?\s*(.+))?$/i);
  if (tod) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return applyTime(d.getTime(), tod[1]);
  }

  // Bare time "12:20 PM" with no date prefix → assume today
  if (/^\d{1,2}:\d{2}\s*[APap][Mm]$/.test(text)) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return applyTime(d.getTime(), text);
  }

  return null;
}

function parseAnyDate(text) {
  return parseTextDate(text) || parseRelativeDate(text);
}

// ── epoch extraction ──────────────────────────────────────────────────────────

function getRowEpoch(row) {
  // 1. phui-oi-epoch span (most reliable)
  const epochSpan = row.querySelector('.phui-oi-epoch');
  if (epochSpan) {
    const ts = parseAnyDate(epochSpan.textContent.trim());
    if (ts) return ts;
  }

  // 2. Right-side region
  const right = row.querySelector('.phui-oi-right, .phui-oi-side');
  if (right) {
    const dateRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Yesterday|Today|Just|\d+\s+\w+\s+ago|\d+:\d+\s*[AP]M)/i;
    for (const el of right.querySelectorAll('span, div, td')) {
      const text = el.textContent.trim();
      if (dateRe.test(text) && text.length < 50) {
        const ts = parseAnyDate(text);
        if (ts) return ts;
      }
    }
  }

  // 3. Javelin epoch widget
  for (const el of row.querySelectorAll('[data-sigil]')) {
    if (el.getAttribute('data-sigil').includes('epoch')) {
      try {
        const meta = JSON.parse(el.getAttribute('data-meta') || '{}');
        if (meta.epoch) return meta.epoch * 1000;
      } catch (_) {}
    }
  }

  // 4. Standard <time datetime="...">
  const timeEl = row.querySelector('time[datetime]');
  if (timeEl) {
    const d = new Date(timeEl.getAttribute('datetime'));
    if (!isNaN(d)) return d.getTime();
  }

  // 5. Scan all td/span for any parseable date string (last resort)
  const anyDateRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Yesterday|Today|Just|\d+\s+\w+\s+ago|\d{1,2}:\d{2}\s*[AP]M)/i;
  for (const el of [...row.querySelectorAll('td, span')].reverse()) {
    if (el.children.length > 2) continue;
    const text = el.textContent.trim();
    if (anyDateRe.test(text) && text.length < 50) {
      const ts = parseAnyDate(text);
      if (ts) return ts;
    }
  }

  return null;
}

// ── row detection ─────────────────────────────────────────────────────────────

function getRows() {
  const seen = new Set();
  const rows = [];

  // Primary: phui-oi-link → walk up to enclosing <li>
  for (const link of document.querySelectorAll('a.phui-oi-link')) {
    let el = link;
    for (let i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el || el === document.body) break;
      if (el.tagName.toLowerCase() === 'li') {
        if (!seen.has(el)) { seen.add(el); rows.push(el); }
        break;
      }
    }
  }

  // Fallback: any /D\d+ link → walk up to <tr>
  if (rows.length === 0) {
    for (const link of document.querySelectorAll('a[href]')) {
      if (!/\/D\d+/.test(link.getAttribute('href') || '')) continue;
      let el = link;
      for (let i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        if (el.tagName.toLowerCase() === 'tr') {
          if (!seen.has(el)) { seen.add(el); rows.push(el); }
          break;
        }
      }
    }
  }

  return rows;
}

// ── state ─────────────────────────────────────────────────────────────────────

// active is always ON at page load — Alt+Shift+F is a temporary per-session
// toggle only and does not persist across reloads or addon restarts.
function setActive(v) { /* no-op: not persisted */ }

function getThreshold() {
  const v = parseInt(localStorage.getItem(STORAGE_KEY_HOURS), 10);
  return isNaN(v) ? DEFAULT_HOURS : v;
}

let active = true;

// ── group detection ───────────────────────────────────────────────────────────
// Returns true when the dom-core-reviewers group is in the reviewer list.
// We match reviewer *links* (exact text) to avoid false-positives from
// "r=#dom-core!" that appears in revision titles.

function hasGroupAssignment(row) {
  for (const a of row.querySelectorAll('a')) {
    const text = a.textContent.trim().toLowerCase();
    if (text.includes('dom-core-reviewers') || text === 'dom-core') return true;
  }
  return false;
}

function hasDirectAssignment(row, username) {
  const target = username.toLowerCase();
  for (const a of row.querySelectorAll('a')) {
    if (a.textContent.trim().toLowerCase() === target) return true;
  }
  return false;
}

// ── filter ────────────────────────────────────────────────────────────────────
// Only rows where the dom-core-reviewers GROUP is assigned get the age filter.
// Direct-only assignments to smaug are always shown — the author specifically
// needs him and no one else in the group can substitute.

function applyFilter() {
  const threshMs = getThreshold() * 3600 * 1000;
  const now = Date.now();
  const rows = getRows();

  rows.forEach(row => {
    const link = row.querySelector('a.phui-oi-link');
    const title = (link ? (link.getAttribute('href') || '') + ' ' + link.textContent.trim().slice(0, 30) : '(no link)');

    if (!active) {
      row.classList.remove('praf-hidden');
      return;
    }

    const hasGroup = hasGroupAssignment(row);
    const userDirect = CURRENT_USER && hasDirectAssignment(row, CURRENT_USER);

    if (!hasGroup || userDirect) {
      // No group, OR user explicitly named — author specifically wanted this reviewer
      row.classList.remove('praf-hidden');
      console.debug('[praf] SHOW (direct/explicit)', title);
      return;
    }

    const epoch = getRowEpoch(row);
    const unknownAge = epoch === null;
    const ageH = unknownAge ? null : ((now - epoch) / 3600000).toFixed(1);
    const isStale = !unknownAge && (now - epoch) > threshMs;
    const hide = !isStale && !unknownAge;
    row.classList.toggle('praf-hidden', hide);
    console.debug('[praf]', hide ? 'HIDE' : 'SHOW', `(${ageH}h)`, title);
  });
}

// ── experimenter shortcut: Alt + Shift + F ────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.altKey && e.shiftKey && e.key === 'F') {
    active = !active;
    setActive(active);
    applyFilter();
    console.debug('[praf] filter', active ? 'ON' : 'OFF',
      `threshold: ${getThreshold()}h`);
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────

function init() {
  console.debug('[praf] loaded — user:', CURRENT_USER, 'active:', active, 'threshold:', getThreshold() + 'h');
  applyFilter();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

const observer = new MutationObserver(applyFilter);
observer.observe(document.body, { childList: true, subtree: false });