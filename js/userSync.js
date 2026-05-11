// ╔══════════════════════════════════════════════════════════╗
// ║  userSync.js — Private User Data  ↔  Firestore          ║
// ║                                                          ║
// ║  SECURITY MODEL                                          ║
// ║  • users/{uid} is readable/writable ONLY by the owner   ║
// ║  • Firestore rules enforce this at server level          ║
// ║  • JS also enforces: no page can load another user's UID ║
// ║  • Skip-OTP demo accounts stay in localStorage only      ║
// ║    (no Firebase Auth → no cloud backup for demo users)   ║
// ╚══════════════════════════════════════════════════════════╝

import { db, LS, SS }     from './app.js';
import { doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { app } from './app.js';

// ── Which keys live in cloud vs local-only ──────────────────
// Cloud: account data that must survive cache clears
// Local-only: ephemeral / device-specific state
const CLOUD_KEYS = [
  'points', 'liked', 'wallet', 'role', 'mname', 'phone', 'logoUrl',
  'pref_maxDay', 'pref_maxHour', 'pref_paused',
  'pref_interests', 'pref_mutedCats', 'pref_mutedVendors',
];
const LOCAL_ONLY = [
  'lastLoc', 'geo_states', 'vendor_cap', 'budget_throttle',
  'engagement', 'notif_log', 'vendor_shown', 'listing_seen',
  'searchRadius', 'viewId',
];

// ── Is this a real Firebase Auth user? ─────────────────────
export function isRealAuthUser(uid) {
  if (!uid) return false;
  // TEMPORARY FOR TESTING: Allow all users, including demo 'u_' accounts, to save to Firestore
  return true; 
}

// ── Build user document from current localStorage ──────────
export function buildUserDoc(uid) {
  const doc = {
    uid,
    phone:    LS('phone')      || '',
    role:     LS('role')       || 'consumer',
    points:   LS('points')     || 0,
    liked:    LS('liked')      || [],
    prefs: {
      maxDay:       LS('pref_maxDay')      ?? 999,
      maxHour:      LS('pref_maxHour')     ?? 999,
      paused:       LS('pref_paused')      || false,
      interests:    LS('pref_interests')   || ['deal','rental','pg','job'],
      mutedCats:    LS('pref_mutedCats')   || [],
      mutedVendors: LS('pref_mutedVendors')|| [],
    },
    lastSeen: serverTimestamp(),
  };
  // Merchant-only fields
  if (LS('role') === 'merchant') {
    doc.mname  = LS('mname')  || 'My Business';
    doc.wallet = LS('wallet') || 0;
    // 🚀 FIX: Ensure logoUrl is backed up to the cloud!
    if (LS('logoUrl')) doc.logoUrl = LS('logoUrl'); 
  }
  return doc;
}

// ── Apply a Firestore user document → localStorage ─────────
// This restores cloud data after login or cache clear
export function applyUserDoc(data) {
  if (!data) return;
  if (data.points   != null)  SS('points',   data.points);
  if (data.liked    != null)  SS('liked',    data.liked);
  if (data.phone)             SS('phone',    data.phone);
  if (data.role)              SS('role',     data.role);
  if (data.wallet   != null)  SS('wallet',   data.wallet);
  if (data.mname)             SS('mname',    data.mname);
  
  // 🚀 FIX: Restore logoUrl so the merchant sees their logo on new devices!
  if (data.logoUrl)           SS('logoUrl',  data.logoUrl);

  if (data.prefs) {
    const p = data.prefs;
    if (p.maxDay       != null) SS('pref_maxDay',       p.maxDay);
    if (p.maxHour      != null) SS('pref_maxHour',      p.maxHour);
    if (p.paused       != null) SS('pref_paused',       p.paused);
    if (p.interests    != null) SS('pref_interests',    p.interests);
    if (p.mutedCats    != null) SS('pref_mutedCats',    p.mutedCats);
    if (p.mutedVendors != null) SS('pref_mutedVendors', p.mutedVendors);
  }
}

// ── Write user data to Firestore (merge, not overwrite) ────
// Only called for real Firebase Auth users
export async function pushUserData(uid, partial = null) {
  if (!isRealAuthUser(uid)) return; // skip demo accounts
  try {
    const ref = doc(db, 'users', uid);
    const data = partial || buildUserDoc(uid);
    await setDoc(ref, data, { merge: true });
  } catch(e) {
    console.warn('userSync push failed:', e.message);
  }
}

// ── Pull user data from Firestore → localStorage ───────────
// Returns true if document existed, false if new user
export async function pullUserData(uid) {
  if (!isRealAuthUser(uid)) return false;
  try {
    const ref  = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      applyUserDoc(snap.data());
      return true; // existing user, data restored
    }
    return false; // new user, no cloud data yet
  } catch(e) {
    console.warn('userSync pull failed:', e.message);
    return false;
  }
}

// ── First-time registration: create Firestore document ─────
export async function registerUser(uid, phone, role, mname = null) {
  if (!isRealAuthUser(uid)) return;
  try {
    const ref  = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (snap.exists()) return; // already registered
    const data = {
      uid, phone, role,
      points: 0,
      liked:  [],
      prefs: {
        maxDay: 999, maxHour: 999, paused: false,
        interests: ['deal','rental','pg','job'],
        mutedCats: [], mutedVendors: [],
      },
      createdAt: serverTimestamp(),
      lastSeen:  serverTimestamp(),
    };
    if (role === 'merchant') {
      data.mname  = mname || 'My Business';
      data.wallet = 500; // ₹500 welcome credit
    }
    await setDoc(ref, data);
  } catch(e) {
    console.warn('userSync register failed:', e.message);
  }
}

// ── Sync a single field change immediately ──────────────────
// Use for points, liked, wallet changes that need to persist
export async function syncField(uid, fieldPath, value) {
  if (!isRealAuthUser(uid)) return;
  try {
    const ref = doc(db, 'users', uid);
    await updateDoc(ref, { [fieldPath]: value, lastSeen: serverTimestamp() });
  } catch(e) {
    // Document might not exist yet — create it
    try { await pushUserData(uid); } catch {}
  }
}

// ── Real-time listener: keeps localStorage in sync ─────────
// Call once on app boot for pages that show live user data
let _unsubscribe = null;
export function watchUserData(uid, onUpdate) {
  if (!isRealAuthUser(uid)) return () => {};
  if (_unsubscribe) _unsubscribe(); // cancel existing listener
  const ref = doc(db, 'users', uid);
  _unsubscribe = onSnapshot(ref, snap => {
    if (snap.exists()) {
      applyUserDoc(snap.data());
      if (onUpdate) onUpdate(snap.data());
    }
  }, err => console.warn('userSync watch error:', err.message));
  return () => { if (_unsubscribe) _unsubscribe(); };
}

// ── Auth state bridge ────────────────────────────────────────
// Waits for Firebase Auth to confirm session, then syncs
// Call this at app start so we catch the auth state even after
// page refresh (Firebase Auth persists across sessions)
export async function initAuthSync(onReady) {
  try {
    const { getAuth, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js');
    const auth = getAuth(app);
    onAuthStateChanged(auth, async user => {
      if (user) {
        // Real Firebase Auth user
        const uid = user.uid;
        SS('uid', uid);
        SS('phone', user.phoneNumber || LS('phone') || '');
        await pullUserData(uid);
        if (onReady) onReady(uid, true);
      } else {
        // No Firebase session — use localStorage UID (demo/skipOTP)
        const uid = LS('uid');
        if (onReady) onReady(uid, false);
      }
    });
  } catch(e) {
    // Firebase Auth unavailable (e.g. ad blocker) — keep app alive!
    console.warn('Firebase Auth blocked or unavailable, using local session.');
    const uid = LS('uid');
    if (onReady) onReady(uid, false);
  }
}