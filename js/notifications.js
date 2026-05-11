// ╔══════════════════════════════════════════════════════╗
// ║  notifications.js — 3-Layer Hyperlocal Engine        ║
// ║                                                      ║
// ║  LAYER 1  Geo Filter & Cooldown                      ║
// ║  LAYER 2  Relevance Scoring → rank by signal         ║
// ║  LAYER 3  Spam Control  → decide send / suppress     ║
// ╚══════════════════════════════════════════════════════╝

import { LS, SS, TC, isExpired, go, triggerLocalBuzz } from './app.js';
import { distM } from './app.js';

// ── Current user location ────────────────────────────────
export let loc = null;
export function setLoc(newLoc) {
  loc = newLoc;
  if (newLoc) SS('lastLoc', newLoc);
}

// ── Listing array (set by data loader) ───────────────────
export let listings = [];
export function setListings(arr) { listings = arr; }

// ── Distance from current loc to a listing object ────────
export function dist(l) {
  const position = loc || LS('lastLoc');
  if (!position || !l.lat) return Infinity;
  return distM(position.lat, position.lng, l.lat, l.lng);
}

// ════════════════════════════════════════════════════════
// MARKET MODE ZONES — known dense commercial areas
// ════════════════════════════════════════════════════════
const MARKET_ZONES = [
  { name: 'Sector 15 Market',     lat: 28.4143, lng: 77.3090, r: 300 },
  { name: 'Sector 16 Market',     lat: 28.4075, lng: 77.3195, r: 250 },
  { name: 'NIT Market Faridabad', lat: 28.3985, lng: 77.3300, r: 350 },
  { name: 'Crown Interiorz Mall', lat: 28.4050, lng: 77.3220, r: 400 },
  { name: 'Old Faridabad Chowk',  lat: 28.4200, lng: 77.3050, r: 300 },
];
let lastMarketZone = null;

export function inMarketZone(position) {
  if (!position) return null;
  for (const z of MARKET_ZONES) {
    if (distM(position.lat, position.lng, z.lat, z.lng) <= z.r) return z;
  }
  return null;
}

// ════════════════════════════════════════════════════════
// TRACKING ENGINE — Remembers what has been notified
// ════════════════════════════════════════════════════════
function getGeoStates()   { return LS('geo_states') || {}; }
function saveGeoStates(s) { SS('geo_states', s); }

export function markGeofenceNotified(id) {
  const states = getGeoStates();
  states[id] = { notifiedAt: Date.now() };
  saveGeoStates(states);
}

// ════════════════════════════════════════════════════════
// FEATURE 2 — VENDOR DAILY NOTIFICATION CAP
// ════════════════════════════════════════════════════════
export function vendorCapReached(l) {
  const cap   = parseInt(l.budget || 100) >= 500 ? 100 : 20;
  const vcap  = LS('vendor_cap') || {};
  const today = new Date().toDateString();
  const key   = l.uid || l.id;
  const entry = vcap[key] || { date: '', count: 0 };
  if (entry.date !== today) return false;
  return entry.count >= cap;
}

export function markVendorCapUsed(l) {
  const vcap  = LS('vendor_cap') || {};
  const today = new Date().toDateString();
  const key   = l.uid || l.id;
  const entry = vcap[key] || { date: today, count: 0 };
  if (entry.date !== today) { entry.date = today; entry.count = 0; }
  entry.count++;
  vcap[key] = entry;
  const keys = Object.keys(vcap);
  if (keys.length > 500) delete vcap[keys[0]];
  SS('vendor_cap', vcap);
}

// ════════════════════════════════════════════════════════
// FEATURE 3 — AREA DENSITY CONTROL (~100m grid cells)
// ════════════════════════════════════════════════════════
const GRID_SIZE    = 0.001; // ~100m per cell
const MAX_PER_CELL = 3;

export function applyDensityControl(candidates) {
  const cells = {};
  return candidates.filter(l => {
    if (!l.lat || !l.lng) return true;
    const ck = `${Math.round(l.lat / GRID_SIZE)}_${Math.round(l.lng / GRID_SIZE)}`;
    cells[ck] = (cells[ck] || 0) + 1;
    return cells[ck] <= MAX_PER_CELL;
  });
}

// ════════════════════════════════════════════════════════
// FEATURE 6 — BUDGET THROTTLING (hourly pacing)
// ════════════════════════════════════════════════════════
export function budgetThrottled(l) {
  const dailyBudget  = parseInt(l.budget || 100);
  const maxPopsHour  = Math.floor((dailyBudget / 12) / 2); 
  const bt    = LS('budget_throttle') || {};
  const hrKey = `${l.uid || l.id}_${new Date().getHours()}`;
  return (bt[hrKey] || 0) >= maxPopsHour;
}

export function markBudgetUsed(l) {
  const bt    = LS('budget_throttle') || {};
  const hr    = new Date().getHours();
  const hrKey = `${l.uid || l.id}_${hr}`;
  bt[hrKey]   = (bt[hrKey] || 0) + 1;
  Object.keys(bt).forEach(k => { if (!k.endsWith('_' + hr)) delete bt[k]; });
  SS('budget_throttle', bt);
}

export function trackEng(id, delta) {
  const eng = LS('engagement') || {};
  eng[id] = Math.max(-50, Math.min(100, (eng[id] || 0) + delta));
  SS('engagement', eng);
}

function engagementScore(id) {
  return Math.min((LS('engagement') || {})[id] || 0, 15);
}

// ════════════════════════════════════════════════════════
// USER PREFERENCES
// ════════════════════════════════════════════════════════

// 🚀 NEW: Silent Mode Toggle
export function toggleSilentMode() {
  const current = LS('pref_paused') || false;
  SS('pref_paused', !current);
  return !current; // returns true if now silent, false if active
}

export function getPrefs() {
  return {
    maxPerDay:    LS('pref_maxDay')       != null ? LS('pref_maxDay')    : 100,
    maxPerHour:   LS('pref_maxHour')      != null ? LS('pref_maxHour')   : 50,
    paused:       LS('pref_paused')       || false,
    mutedCats:    LS('pref_mutedCats')    || [],
    mutedVendors: LS('pref_mutedVendors') || [],
    interests:    LS('pref_interests')    || ['deal', 'rental', 'pg', 'job'],
  };
}

function getNLogs()            { return (LS('notif_log') || []).filter(t => Date.now() - t < 86400000); }
export function logNotif()     { const l = getNLogs(); l.push(Date.now()); SS('notif_log', l); }
export function notifsThisHour()  { return getNLogs().filter(t => Date.now() - t < 3600000).length; }
export function notifsToday()     { return getNLogs().length; }

let prevLoc = null, prevTime = null;
export function updateSpeed(newLoc, newTime) {
  if (!prevLoc || !prevTime) { prevLoc = newLoc; prevTime = newTime; return 0; }
  const metres = distM(prevLoc.lat, prevLoc.lng, newLoc.lat, newLoc.lng);
  const secs   = (newTime - prevTime) / 1000;
  prevLoc = newLoc; prevTime = newTime;
  return secs > 0 ? (metres / secs) * 3.6 : 0;
}

function scoreL(l, d, prefs) {
  let s = 0;
  if      (d <= 50)  s += 40;
  else if (d <= 150) s += 25;
  else if (d <= 300) s += 10;
  if (prefs.interests.includes(l.type)) s += 30;
  s += Math.round(Math.min(l.popups || 0, 100) / 10);
  if (l.type === 'deal') s += 10;
  if (l.verified)        s += 5;
  if (parseInt(l.budget || 100) >= 500) s += 5;
  s += engagementScore(l.id);
  return s;
}

export function getNotifType(d) {
  if (d <= 50)  return 'hard';
  if (d <= 150) return 'soft';
  return 'feed';
}

export function showSoftBanner(l) {
  const col = l.color || TC(l.type);
  let ban = document.getElementById('soft-banner');
  if (!ban) {
    ban = document.createElement('div');
    ban.id = 'soft-banner';
    ban.style.cssText = 'position:fixed;top:74px;right:13px;width:200px;background:var(--card);border:1px solid var(--bdr);border-radius:14px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.15);z-index:849;cursor:pointer;border-left:4px solid #FF5722;transition:opacity .3s';
    document.body.appendChild(ban);
  }
  ban.style.borderLeftColor = col;
  ban.style.opacity = '1';
  ban.innerHTML = `
    <div style="font-size:9px;font-weight:800;color:${col};letter-spacing:1px;margin-bottom:3px">${(l.type||'').toUpperCase()} · ${Math.round(l._dist||0)}m</div>
    <div style="font-size:12px;font-weight:800;color:var(--deep);line-height:1.3">${(l.title||'').slice(0,40)}</div>
    <div style="font-size:10px;color:var(--gray);margin-top:2px">${l.price||''}</div>`;
  ban.onclick = () => {
    trackEng(l.id, 8);
    location.href = 'detail.html?id=' + encodeURIComponent(l.id);
    ban.style.opacity = '0';
  };
  clearTimeout(window._banTimer);
  window._banTimer = setTimeout(() => { if (ban) ban.style.opacity = '0'; }, 5000);
}

// ════════════════════════════════════════════════════════
// checkProximity() — THE REWRITTEN ENGINE
// ════════════════════════════════════════════════════════
export function checkProximity(showNotifFn, showMarketNotifFn) {
  const position = loc || LS('lastLoc');
  if (!position || !listings.length) return;
  const prefs = getPrefs();

  // 1. HARD LIMITS
  if (prefs.paused)                         return; // 🚀 Honors Silent Mode
  if (notifsToday()    >= prefs.maxPerDay)  return;
  if (notifsThisHour() >= prefs.maxPerHour) return;

  // Market Zone Check
  const zone = inMarketZone(position);
  if (zone && zone.name !== lastMarketZone) {
    lastMarketZone = zone.name;
    const cnt = listings.filter(l => l.lat && distM(position.lat, position.lng, l.lat, l.lng) < zone.r * 1.2).length;
    if (cnt >= 3) {
      showMarketNotifFn(zone, cnt);
      logNotif();
      // Lock the engine generally, but high-scoring items can still punch through it
      SS('last_ping', { time: Date.now(), score: 60, type: 'market' });
      return;
    }
  }
  if (!zone) lastMarketZone = null;

  // LAYER 1 — INTELLIGENT GEOFENCE COOLDOWN
  const states = getGeoStates();
  const layer1 = listings.filter(l => {
    if (!l.lat || !l.lng) return false;
    if (isExpired(l))     return false;
    
    // Check if physically inside the radius
    const d = dist(l);
    const rad = Math.min(l.radius || 300, 1500);
    if (d > rad) return false; 
    
    // Per-Listing Cooldown: Do not notify about the SAME listing more than once every 1 hour
    const prev = states[l.id] || { notifiedAt: 0 };
    const hoursSinceNotif = (Date.now() - (prev.notifiedAt || 0)) / 3600000;
    
    return hoursSinceNotif >= 1;
  });

  if (!layer1.length) return;

  // LAYER 2 — RELEVANCE SCORING
  const layer2 = layer1
    .map(l => ({ ...l, _dist: dist(l), _score: scoreL(l, dist(l), prefs) }))
    .filter(l => {
      if (!prefs.interests.includes(l.type))        return false;
      if (prefs.mutedCats.includes(l.type))         return false;
      if (prefs.mutedVendors.includes(l.uid||l.id)) return false;
      return l._score >= 40;
    })
    .sort((a, b) => b._score - a._score);
  if (!layer2.length) return;

  // LAYER 3 — BUDGET & VENDOR SPAM
  const layer3 = layer2.filter(l => !vendorCapReached(l) && !budgetThrottled(l));
  if (!layer3.length) return;

  const final  = applyDensityControl(layer3);
  if (!final.length) return;

  // WE HAVE A WINNER
  const winner = final[0];
  const ntype  = getNotifType(winner._dist);

  // 🚀 THE "SMART OVERRIDE" PACING ENGINE
  const lastPing = LS('last_ping') || { time: 0, score: 0, type: '' };
  const timeSincePing = Date.now() - lastPing.time;

  // 🚀 FIX: Reduced to 10 seconds if app is open
  const lockDuration = document.visibilityState === 'visible' ? 10000 : 120000; 

  if (timeSincePing < lockDuration) {
    // It is too soon. Let's see if this deal is worth breaking the lock for:
    const isDifferentCategory = winner.type !== lastPing.type;
    
    // 🚀 FIX: Relaxed requirement. Now only needs to be 5 points better instead of 15.
    const isMuchBetterDeal = winner._score >= (lastPing.score + 5); 

    // If it's the same category AND not significantly better, enforce the lock and stay silent.
    if (!isDifferentCategory && !isMuchBetterDeal) {
      return; 
    }
  }

  if (ntype === 'hard') {
    // 1. Fire the in-app UI update
    showNotifFn(winner);
    
    // 2. Unconditionally trigger the native System Push Notification
    // It will now show up in the device's system tray/banner exactly like a standard app notification.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(registration => {
        registration.showNotification(
          (winner.emoji || '📍') + ' ' + (winner.title || 'New Deal Nearby!'),
          {
            body: (winner.price ? winner.price + ' · ' : '') + (winner.desc || 'Tap to view details').slice(0, 40) + '...',
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            vibrate: [500, 250, 500, 250, 1000, 250, 1000], 
            requireInteraction: true, 
            data: { url: '/detail.html?id=' + winner.id } 
          }
        );
      });
    } else {
      triggerLocalBuzz(
        (winner.emoji || '📍') + ' ' + (winner.title || 'New Deal Nearby!'),
        (winner.price ? winner.price + ' · ' : '') + (winner.desc || 'Tap to view details').slice(0, 40) + '...',
        '/detail.html?id=' + winner.id
      );
    }
    
    // Fallback hardware buzz in case system notifications are blocked but vibration is allowed
    if (navigator.vibrate) navigator.vibrate([500, 250, 1000]);

  } else if (ntype === 'soft') {
    showSoftBanner(winner);
    if (navigator.vibrate) navigator.vibrate([250]);
  }

  // UPDATE ENGINE STATE
  markGeofenceNotified(winner.id);
  markVendorCapUsed(winner);
  markBudgetUsed(winner);
  logNotif();
  // Save the state so the engine can compare future deals against this one
  SS('last_ping', { time: Date.now(), score: winner._score, type: winner.type }); 
}