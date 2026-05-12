// ╔══════════════════════════════════════════════════════╗
// ║  app.js — NearPop shared foundation                  ║
// ║  Firebase init · LS/SS · toast · type helpers        ║
// ║  Imported by every page                              ║
// ╚══════════════════════════════════════════════════════╝

// 🚀 ALL IMPORTS SAFELY CONSOLIDATED AT THE TOP
import { initializeApp }  from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging.js";

// ── Firebase config ──────────────────────────────────────
const FB_CONFIG = {
    apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
    authDomain: "nearpop-a432d.firebaseapp.com",
    projectId: "nearpop-a432d",
    storageBucket: "nearpop-a432d.firebasestorage.app",
    messagingSenderId: "265333242320",
    appId: "1:265333242320:web:f2cedec620ef08d4e161d5"
};

export const app = initializeApp(FB_CONFIG);

// Hard limit offline database to 5MB to prevent storage bloat
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ cacheSizeBytes: 5242880 })
});

export const auth = getAuth(app);

// 🛡️ SAFE START: Only turn on messaging if the browser/app allows it
export let messaging = null;

isSupported().then((supported) => {
  if (supported) {
    messaging = getMessaging(app);
    console.log("Web Push is supported! Messaging initialized.");
    
    // Move the foreground listener here so it only runs if supported!
    onMessage(messaging, (payload) => {
      console.log('Foreground Push Received:', payload);
      toast('🔔', payload.notification?.title || "New Offer Nearby!", 5000);
    });
  } else {
    console.log("Running inside Android App - Skipping Web Push!");
  }
}).catch(console.error);

// 🚀 1. ENFORCE INDEFINITE SESSION PERSISTENCE
setPersistence(auth, browserLocalPersistence)
  .then(() => {
    // Silently keep our Local Storage vault perfectly synced with Firebase
    onAuthStateChanged(auth, (user) => {
      if (user) {
        SS('uid', user.uid); 
      }
    });
  })
  .catch(console.error);

// ── localStorage helpers ─────────────────────────────────
export const LS = k => {
  try { return JSON.parse(localStorage.getItem('np_' + k)); }
  catch { return null; }
};
export const SS = (k, v) => {
  try { localStorage.setItem('np_' + k, JSON.stringify(v)); }
  catch {}
};

// 🚀 2. MULTILINGUAL SUPPORT (Hindi / English)
const DICTIONARY = {
  en: {
    rad: "📡 Radius:", any: "Anywhere", all: "All",
    deal: "🏷️ Deals", rental: "🏠 Flats", pg: "🛋️ PG", job: "💼 Jobs",
    list: "📋 List", disc: "🔍 Discover", no_deals: "No offers match your current filters."
  },
  hi: {
    rad: "📡 दायरा:", any: "कहीं भी", all: "सभी",
    deal: "🏷️ सौदे", rental: "🏠 मकान", pg: "🛋️ पीजी", job: "💼 नौकरी",
    list: "📋 सूची", disc: "🔍 खोजें", no_deals: "आपके फ़िल्टर से कोई सौदा नहीं मिला।"
  }
};

export const getLang = () => LS('pref_lang') || 'en';
export const toggleLang = () => { 
  SS('pref_lang', getLang() === 'en' ? 'hi' : 'en'); 
  window.location.reload(); 
};
export const t = (key) => DICTIONARY[getLang()][key] || key;

// ── Type → colour / emoji maps ───────────────────────────
export const TC = t => ({ deal:'#FF5722', rental:'#3B82F6', pg:'#8B5CF6', job:'#10B981' }[t] || '#666');
export const TE = t => ({ deal:'🏷️',    rental:'🏠',       pg:'🛋️',      job:'💼'      }[t] || '📍');

export const TYPE_LABELS = { deal:'Deal', rental:'Flat / Room', pg:'PG / Hostel', job:'Job' };
export const CTAS        = { deal:'🛍️ Get Offer', rental:'📅 Schedule Visit', pg:'📅 Visit PG', job:'📝 Apply Now' };

// ── Haversine distance (metres) ──────────────────────────
export function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLa = (lat2 - lat1) * Math.PI / 180;
  const dLo = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLa/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLo/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function fmtDist(l) {
  const loc = LS('lastLoc');
  if (!loc || !l.lat) return '—';
  const d = distM(loc.lat, loc.lng, l.lat, l.lng);
  return d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'km';
}

export function isExpired(l) {
  if (!l.expiryDate) return false;
  return new Date(l.expiryDate) < new Date();
}

export function toast(icon, text, durationMs = 3500) {
  clearTimeout(window._toastTimer);
  const el = document.getElementById('toast');
  if (!el) return;
  document.getElementById('t-ic').textContent = icon;
  document.getElementById('t-tx').textContent = text;
  el.classList.remove('on');
  requestAnimationFrame(() => el.classList.add('on'));
  window._toastTimer = setTimeout(() => el.classList.remove('on'), durationMs);
}

export function requireAuth(role = null) {
  const uid  = LS('uid');
  const r    = LS('role');
  if (!uid || !r)               { location.href = 'index.html'; return false; }
  if (role && r !== role)       { location.href = 'index.html'; return false; }
  return true;
}

// ── Listing cache ────────────────────────────────────────
export const CACHE_KEY = 'np_listings_cache';
export const CACHE_TTL = 5 * 60 * 1000;

export function cacheGet() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

export function cacheSet(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

export function cacheClear() { localStorage.removeItem(CACHE_KEY); }

export const go = href => { location.href = href; };
window.go = go; 

// Auto-Sync Engine attached to the global Point adder
export function addPts(n) { 
  const currentPts = parseInt(LS('points')) || 0;
  const newPts = currentPts + parseInt(n);
  
  SS('points', newPts); 
  
  const uid = LS('uid');
  if (uid) {
    updateDoc(doc(db, 'users', uid), { points: newPts }).catch(e => console.warn("Point sync skipped", e));
  }
}

export async function loadNavigation() {
  const placeholder = document.getElementById('nav-placeholder');
  if (!placeholder) return; 

  try {
    const response = await fetch('nav.html');
    const html = await response.text();
    placeholder.innerHTML = html;

    if (LS('role') === 'merchant') {
      const mBtn = document.getElementById('nav-merchant');
      if (mBtn) mBtn.style.display = '';
    }

    const path = window.location.pathname;
    if (path.includes('map.html')) {
      document.getElementById('nav-map')?.classList.add('on');
    } else if (path.includes('home.html')) {
      document.getElementById('nav-home')?.classList.add('on');
    } else if (path.includes('profile.html')) {
      document.getElementById('nav-profile')?.classList.add('on');
    }
  } catch (error) { console.error("Failed to load navigation:", error); }
}

// 🚀 GLOBAL ANALYTICS INJECTOR
const GA_MEASUREMENT_ID = 'G-71Y2Y75FLQ'; 

function initAnalytics() {
  if (window.gtag) return; 

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = gtag; 
  
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, {
    page_path: window.location.pathname
  });
}

initAnalytics();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 SMART PUSH NOTIFICATION PROMPT & FCM TOKEN MANAGER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function requestPushPermissions(uid) {
  if (!('Notification' in window)) return;
  
  if (Notification.permission === 'granted') {
    fetchAndSaveToken(uid);
    return;
  }
  
  if (Notification.permission === 'denied' || sessionStorage.getItem('push_asked')) return;

  if (document.getElementById('mod-push')) return;

  const modal = document.createElement('div');
  modal.className = 'modal on';
  modal.id = 'mod-push';
  modal.style.cssText = 'z-index:999999; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); pointer-events: auto;';
  
  modal.innerHTML = `
    <div class="msht" style="text-align:center; padding: 30px 20px 20px; pointer-events: auto;">
      <div class="mh"></div>
      <div style="font-size:54px; margin-bottom:12px; filter: drop-shadow(0 4px 12px rgba(255,87,34,0.3));">🔔</div>
      <h3 style="font-family:'Syne',sans-serif; font-size:22px; font-weight:800; color:var(--deep); margin-bottom:8px;">Never Miss a Deal</h3>
      <p style="font-size:14px; color:var(--gray); margin-bottom:24px; line-height:1.5; font-weight:600;">
        NearPop needs notification access to ping your phone the second you walk past a massive discount.
      </p>
      <button id="btn-allow-push" style="width:100%; padding:14px; background:var(--or); color:#fff; border:none; border-radius:14px; font-size:15px; font-weight:800; cursor:pointer; margin-bottom:10px; box-shadow:0 4px 14px rgba(255,87,34,0.3); font-family:inherit;">Yes, Notify Me!</button>
      <button id="btn-deny-push" style="width:100%; padding:14px; background:var(--light); color:var(--gray); border:none; border-radius:14px; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit;">Maybe Later</button>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#btn-allow-push').onclick = async () => {
    modal.remove();
    sessionStorage.setItem('push_asked', 'true');
    
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      fetchAndSaveToken(uid);
    } else {
      toast('⚠️', 'Alerts blocked. You can enable them in your browser settings later.');
    }
  };

  modal.querySelector('#btn-deny-push').onclick = () => {
    modal.remove();
    sessionStorage.setItem('push_asked', 'true');
  };
}

async function fetchAndSaveToken(uid) {
  if (!messaging) return; // 🛡️ SAFETY NET: Stop here if running in Android app
  
  try {
    const vapidKey = "BJWz7jdnCy1hb-E8M-7-Q2wanQdNY46Rw7T9I8g_EPr02m-AYAxhGCM7QBm7DpL0WgE-nSnud5mqBK6MWd4w6T0"; 
    const currentToken = await getToken(messaging, { vapidKey });
    
    if (currentToken) {
      await updateDoc(doc(db, 'users', uid), {
        fcmToken: currentToken,
        tokenUpdatedAt: Date.now()
      });
      console.log("FCM Token secured and saved to database.");
    }
  } catch (error) {
    console.warn("Failed to get FCM token:", error);
  }
}

export async function triggerLocalBuzz(title, body, url) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      reg.showNotification(title, {
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        vibrate: [200, 100, 200, 100, 200], 
        data: { url: url || '/map.html' },
        requireInteraction: true
      });
    }
  } catch (e) { console.error('Local Buzz failed:', e); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 SEAMLESS AUTO-UPDATE ENGINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let newWorker;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdatePopup();
        }
      });
    });
  });

  let refreshing;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    window.location.reload();
    refreshing = true;
  });
}

function showUpdatePopup() {
  if (document.getElementById('np-update-pill')) return; 

  const ui = document.createElement('div');
  ui.id = 'np-update-pill';
  ui.innerHTML = `
    <div style="position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--or, #FF5722); color:#fff; padding:12px 18px; border-radius:100px; font-weight:800; font-size:14px; box-shadow:0 6px 20px rgba(255,87,34,0.4); z-index:999999; cursor:pointer; display:flex; align-items:center; gap:10px; font-family:'Nunito', sans-serif; white-space:nowrap; animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);">
      🚀 Update Available! 
      <span style="background:#fff; color:var(--deep, #0F0F13); padding:5px 12px; border-radius:100px; font-size:12px; font-weight:900;">Refresh</span>
    </div>
    <style>@keyframes slideUp { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }</style>
  `;
  
  ui.onclick = () => {
    ui.style.opacity = '0.5';
    ui.style.pointerEvents = 'none';
    if (newWorker) newWorker.postMessage({ type: 'SKIP_WAITING' });
  };
  
  document.body.appendChild(ui);
}

window.deferredPWA = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); 
  window.deferredPWA = e; 
});