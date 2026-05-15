// ╔══════════════════════════════════════════════════════════════════════╗
// ║  notifications.js — NearPop Smart Notification Engine (Phase 2)      ║
// ║  Full Feature Set: Linger · Cooldowns · Queuing · Preferences        ║
// ║  + Battery Optimization · Velocity Filter · Fake GPS Detection       ║
// ║  + Hourly Budget Pacing · Remote Admin Kill-Switch                   ║
// ╚══════════════════════════════════════════════════════════════════════╝

import { app, db, LS, SS, distM, enqueueFirestoreWrite } from './app.js';
import {
    updateDoc, doc, increment, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-functions.js';

const functions = getFunctions(app, 'asia-south1');

const RULES = {
    LINGER_MS:              5000,                   // 5 s dwell before firing
    GLOBAL_QUEUE_MS:        3  * 60 * 1000,         // 3 min between any push
    DEAL_COOLDOWN_MS:       48 * 60 * 60 * 1000,    // 48 h before repeating same deal
    MAX_NOTIFS_PER_DAY:     5,                      // Default daily cap fallback
    MIN_GPS_ACCURACY:       50,                     // Ignore fixes worse than 50 m
    MAX_SPEED_MPS:          5.56,                   // ~20 km/h — above = vehicle, skip
    MAX_JUMP_MPS:           55.6,                   // ~200 km/h — above = fake GPS
    LOW_BATTERY_THRESHOLD:  0.20,                   // Pause below 20 % unless charging
    HOURLY_BUDGET_DEFAULT:  20,                     // Default hourly popup cap per deal
};

class SmartNotificationEngine {
    constructor() {
        this.lingerCache      = {};     // deal.id → timestamp of first proximity entry
        this.systemMuted      = false;  // toggled by remote Firestore kill-switch
        this.batteryOk        = true;   // updated by Battery API watcher
        this.lastPosition     = null;   // { lat, lng, ts } for jump / velocity checks
        this._isEvaluating    = false;

        this._initKillSwitch();
        this._initBatteryWatcher();
        setInterval(() => this.cleanupLingerCache(), 30000);
    }

    // ─── REMOTE ADMIN KILL-SWITCH ──────────────────────────────────────────────
    // Listens to Firestore `config/killSwitch` in real time.
    // Set  { active: true }  in that document to mute all notifications instantly,
    // no app deploy required.
    _initKillSwitch() {
        try {
            onSnapshot(doc(db, 'config', 'killSwitch'), (snap) => {
                if (snap.exists()) {
                    const prev = this.systemMuted;
                    this.systemMuted = snap.data().active === true;
                    if (this.systemMuted && !prev) {
                        console.info('[NearPop] Admin kill-switch activated — notifications paused.');
                    } else if (!this.systemMuted && prev) {
                        console.info('[NearPop] Admin kill-switch deactivated — notifications resumed.');
                    }
                }
            });
        } catch (e) {
            console.warn('[NearPop] Kill-switch listener failed to attach:', e);
        }
    }

    // ─── BATTERY OPTIMIZATION ─────────────────────────────────────────────────
    // Pauses evaluation when battery is low AND not plugged in.
    // Keeps listening so it resumes automatically when the user plugs in.
    async _initBatteryWatcher() {
        if (!('getBattery' in navigator)) return;
        try {
            const battery = await navigator.getBattery();
            const update = () => {
                this.batteryOk = battery.charging || battery.level > RULES.LOW_BATTERY_THRESHOLD;
            };
            update();
            battery.addEventListener('chargingchange',      update);
            battery.addEventListener('levelchange',         update);
        } catch (e) {
            // API unavailable — default to true (don't block notifications)
        }
    }

    // ─── SAFE JSON PARSE FROM LOCALSTORAGE ────────────────────────────────────
    getArrayPref(key, defaultVal) {
        try { return JSON.parse(localStorage.getItem(key)) || defaultVal; }
        catch (e) { return defaultVal; }
    }

    cleanupLingerCache() {
        const now = Date.now();
        Object.keys(this.lingerCache).forEach(dealId => {
            const entry = this.lingerCache[dealId];
            const ts = typeof entry === 'number' ? entry : entry?.timestamp;
            const qualifiedAt = typeof entry === 'object' ? entry.qualifiedAt : null;
            if (!ts || now - ts > 60000 || (qualifiedAt && now - qualifiedAt > 10000)) {
                delete this.lingerCache[dealId];
            }
        });
    }

    // ─── MAIN EVALUATION LOOP ─────────────────────────────────────────────────
    async evaluate(position, activeListings, movementContext = {}) {
        if (this._isEvaluating) return;
        this._isEvaluating = true;
        try {

        // ── Gate 1: System & battery ─────────────────────────────────────────
        if (this.systemMuted) return;
        if (!this.batteryOk)  return;

        // ── Gate 2: User preferences (global) ────────────────────────────────
        if (localStorage.getItem('pref_paused') === 'true') return;

        const prefs = {
            maxDay:        parseInt(localStorage.getItem('pref_maxDay')) || RULES.MAX_NOTIFS_PER_DAY,
            interests:     this.getArrayPref('pref_interests',     ['deal', 'rental', 'pg', 'job']),
            mutedCats:     this.getArrayPref('pref_mutedCats',     []),
            mutedVendors:  this.getArrayPref('pref_mutedVendors',  []),
        };

        const lat      = position.coords.latitude;
        const lng      = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        const speed    = position.coords.speed;   // m/s, may be null on some devices
        const now      = Date.now();

        // ── Gate 3: GPS accuracy ──────────────────────────────────────────────
        if (accuracy > RULES.MIN_GPS_ACCURACY) return;

        // ── Gate 4: Fake GPS detection ────────────────────────────────────────
        // Computes implied speed between the last two fixes.
        // A legitimate device cannot jump 200+ km/h without hardware motion sensors
        // also reporting that — this catches mock-location apps and spoofing tools.
        if (this.lastPosition) {
            const dtSec  = (now - this.lastPosition.ts) / 1000;
            const jumpM  = distM(lat, lng, this.lastPosition.lat, this.lastPosition.lng);
            const impliedSpeed = dtSec > 0 ? jumpM / dtSec : 0;

            if (impliedSpeed > RULES.MAX_JUMP_MPS) {
                console.warn(`[NearPop] Fake GPS suspected — implied speed ${Math.round(impliedSpeed * 3.6)} km/h. Skipping.`);
                this.lastPosition = { lat, lng, ts: now };
                return;
            }
        }
        this.lastPosition = { lat, lng, ts: now };

        // ── Gate 5: Velocity filter ───────────────────────────────────────────
        // Skip when the user is clearly in a moving vehicle.
        // Falls back to null-safe check: if speed is unavailable we let it through.
        if (speed !== null && speed !== undefined && speed > RULES.MAX_SPEED_MPS) return;

        // ── Gate 6: Global notification queue (3-min gap) ─────────────────────
        const lastNotifTime = parseInt(localStorage.getItem('np_last_notif_time')) || 0;
        if (now - lastNotifTime < RULES.GLOBAL_QUEUE_MS) return;

        // ── Gate 7: Daily limit ───────────────────────────────────────────────
        const today       = new Date().toDateString();
        let dailyTracker  = this.getArrayPref('np_daily_tracker', { date: today, count: 0 });
        if (dailyTracker.date !== today) dailyTracker = { date: today, count: 0 };
        if (dailyTracker.count >= prefs.maxDay) return;

        // ── Gate 8: Density-based radius scaling ──────────────────────────────
        const isStationary = movementContext.isStationary === true;
        const densityLevel = movementContext.densityLevel || (activeListings.length > 10 ? 'high' : 'normal');
        let triggerRadius = isStationary ? 100 : 500;
        if (speed !== null && speed !== undefined && speed > 2) triggerRadius = Math.min(triggerRadius, 300);
        if (densityLevel === 'high') triggerRadius = Math.min(triggerRadius, 50);
        const qualifiedDeals = [];

        // ── Deal loop ─────────────────────────────────────────────────────────
        for (const deal of activeListings) {

            // Merchant daily budget cap
            if (deal.popupsSentToday >= (deal.dailyPopupLimit || 100)) continue;

            // ── Hourly budget pacing ──────────────────────────────────────────
            // Prevents a merchant from burning their entire day's allowance in
            // one burst. Uses a rolling per-hour key stored in localStorage.
            const hourKey    = `np_hourly_${deal.id}_${new Date().toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
            const hourlySent = parseInt(localStorage.getItem(hourKey)) || 0;
            const hourlyLimit = deal.hourlyPopupLimit || RULES.HOURLY_BUDGET_DEFAULT;
            if (hourlySent >= hourlyLimit) continue;

            // Deal expiry
            if (deal.expiryDate && new Date(deal.expiryDate) < new Date()) continue;

            // User interest & block-lists
            if (!prefs.interests.includes(deal.type))            continue;
            if (prefs.mutedCats.includes(deal.type))             continue;
            if (prefs.mutedVendors.includes(deal.uid || deal.id)) continue;

            // 48-hour per-deal cooldown
            const lastSeenDeal = parseInt(localStorage.getItem(`np_seen_${deal.id}`)) || 0;
            if (now - lastSeenDeal < RULES.DEAL_COOLDOWN_MS) continue;

            const distance = distM(lat, lng, parseFloat(deal.lat), parseFloat(deal.lng));

            if (distance <= triggerRadius) {
                // 5-second linger / dwell check
                const cacheEntry = this.lingerCache[deal.id];
                if (!cacheEntry) {
                    this.lingerCache[deal.id] = {
                        timestamp: now,
                        qualified: false,
                        distance,
                        evaluationCount: 1
                    };
                } else if (!cacheEntry.qualified && now - cacheEntry.timestamp >= RULES.LINGER_MS) {
                    cacheEntry.qualified = true;
                    cacheEntry.qualifiedAt = now;
                    cacheEntry.distance = distance;
                    deal.score    = this.calculatePriorityScore(deal, distance);
                    deal._hourKey = hourKey; // carry the key through to processAndFire
                    deal._distance = distance;
                    qualifiedDeals.push(deal);
                } else if (!cacheEntry.qualified) {
                    cacheEntry.distance = distance;
                    cacheEntry.evaluationCount = (cacheEntry.evaluationCount || 0) + 1;
                }
            } else {
                delete this.lingerCache[deal.id];
            }
        }

        if (qualifiedDeals.length > 0) {
            await this.processAndFire(qualifiedDeals, dailyTracker);
        }
        } finally {
            this._isEvaluating = false;
        }
    }

    // ─── PRIORITY SCORING ─────────────────────────────────────────────────────
    calculatePriorityScore(deal, distance) {
        const distanceScore = Math.max(0, 500 - distance);     // closer = higher
        const budgetScore   = Math.min(500, deal.budget || 0); // higher spend = higher
        return (distanceScore * 0.6) + (budgetScore * 0.4);
    }

    // ─── MERCHANT GROUPING + FIRE ──────────────────────────────────────────────
    async processAndFire(qualifiedDeals, dailyTracker) {
        // Sort by priority score — highest first
        qualifiedDeals.sort((a, b) => b.score - a.score);

        // Group all qualified deals by merchant uid
        const groupedByMerchant = {};
        qualifiedDeals.forEach(deal => {
            if (!groupedByMerchant[deal.uid]) groupedByMerchant[deal.uid] = [];
            groupedByMerchant[deal.uid].push(deal);
        });

        // Fire ONE notification for the highest-scoring merchant only
        const topMerchantUid  = qualifiedDeals[0].uid;
        const dealsToAnnounce = groupedByMerchant[topMerchantUid];
        const primaryDeal     = dealsToAnnounce[0];

        let notifTitle, notifBody;
        if (dealsToAnnounce.length > 1) {
            notifTitle = `${primaryDeal.owner || 'A nearby store'} has ${dealsToAnnounce.length} offers! 🎁`;
            notifBody  = `Including: ${primaryDeal.title}. Tap to see all.`;
        } else {
            notifTitle = `${primaryDeal.emoji || '📍'} ${primaryDeal.title}`;
            notifBody  = `${primaryDeal.price ? primaryDeal.price + ' · ' : ''}${primaryDeal.desc.slice(0, 40)}...`;
        }

        const reserved = await this.reserveNotificationSlot(primaryDeal);
        if (!reserved.allowed) {
            dealsToAnnounce.forEach(d => delete this.lingerCache[d.id]);
            console.warn('[NearPop] Notification blocked by budget verification:', reserved.reason);
            return;
        }

        this.triggerUI(primaryDeal, notifTitle, notifBody);

        // ── Update all rate-limit counters ────────────────────────────────────
        localStorage.setItem('np_last_notif_time', Date.now());

        dailyTracker.count += 1;
        localStorage.setItem('np_daily_tracker', JSON.stringify(dailyTracker));

        dealsToAnnounce.forEach(d => {
            // Per-deal cooldown stamp
            localStorage.setItem(`np_seen_${d.id}`, Date.now());

            // Hourly budget pacing counter
            if (d._hourKey) {
                const prev = parseInt(localStorage.getItem(d._hourKey)) || 0;
                localStorage.setItem(d._hourKey, prev + 1);
            }

            // Clear linger so it doesn't re-fire immediately
            delete this.lingerCache[d.id];

            // Increment Firestore popup counters for merchant analytics
            try {
                if (d.id) {
                    if (!reserved.serverCharged) enqueueFirestoreWrite(() => updateDoc(doc(db, 'listings', d.id), {
                        popups:          increment(1),
                        popupsSentToday: increment(1),
                        lastPopupAt: Date.now()
                    }), `listing_popup_${d.id}`);
                }
            } catch (e) { /* non-critical — analytics only */ }
        });
    }

    // ─── UI DELIVERY ──────────────────────────────────────────────────────────
    // Three delivery paths in priority order:
    //   1. Service Worker push  → works on lock screen / background
    //   2. window.showNotif     → in-app overlay when app is in foreground
    //   3. navigator.vibrate    → haptic feedback fallback
    async reserveNotificationSlot(deal) {
        try {
            const reserveSlot = httpsCallable(functions, 'reserveNotificationSlot');
            const result = await reserveSlot({
                listingId: deal.id,
                userId: LS('uid')
            });
            if (result.data?.allowed) return { allowed: true, serverCharged: true };
            return { allowed: false, reason: result.data?.reason || 'server_rejected' };
        } catch (error) {
            console.warn('[NearPop] Server budget verification unavailable; using queued analytics fallback.', error);
            return { allowed: true, serverCharged: false, reason: 'function_unavailable' };
        }
    }

    triggerUI(deal, title, body) {
        if (document.hidden && 'serviceWorker' in navigator && Notification.permission === 'granted') {
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body,
                    icon:    '/icons/icon-192.png',
                    vibrate: [500, 250, 500],
                    data:    { url: '/detail.html?id=' + deal.id },
                });
            });
        }
        if (!document.hidden && typeof window.showNotif === 'function') {
            window.showNotif(deal);
        }
        if (navigator.vibrate) {
            try { navigator.vibrate([500, 250, 500]); } catch (e) {}
        }
    }
}

export const NotificationEngine = new SmartNotificationEngine();
