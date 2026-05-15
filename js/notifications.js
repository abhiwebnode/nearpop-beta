// ╔══════════════════════════════════════════════════════════════════════╗
// ║  notifications.js — NearPop Smart Notification Engine (Phase 2)      ║
// ║  Full Feature Set: Linger · Cooldowns · Queuing · Preferences        ║
// ║  + Battery Optimization · Velocity Filter · Fake GPS Detection       ║
// ║  + Hourly Budget Pacing · Remote Admin Kill-Switch                   ║
// ╚══════════════════════════════════════════════════════════════════════╝

import { db, LS, SS, distM } from './app.js';
import {
    updateDoc, doc, increment, onSnapshot
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const RULES = {
    LINGER_MS:              5000,                   // 5 s dwell before firing
    GLOBAL_QUEUE_MS:        3  * 60 * 1000,         // 3 min between any push
    DEAL_COOLDOWN_MS:       48 * 60 * 60 * 1000,    // 48 h before repeating same deal
    MAX_NOTIFS_PER_DAY:     5,                      // Default daily cap fallback
    MIN_GPS_ACCURACY:       100,                    // Ignore fixes worse than 100 m
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

        this._initKillSwitch();
        this._initBatteryWatcher();
    }

    // ─── REMOTE ADMIN KILL-SWITCH ──────────────────────────────────────────────
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
            // API unavailable
        }
    }

    // ─── MAIN EVALUATION LOOP ─────────────────────────────────────────────────
    async evaluate(position, activeListings) {

        // ── Gate 1: System & battery ─────────────────────────────────────────
        if (this.systemMuted) return;
        if (!this.batteryOk)  return;

        // ── Gate 2: User preferences (global) ────────────────────────────────
        // FIXED: Using LS() to respect the 'np_' prefix
        if (LS('pref_paused') === true) return;

        const prefs = {
            maxDay:        LS('pref_maxDay')       ?? 999, // Force unlimited default
            interests:     LS('pref_interests')    || ['deal', 'rental', 'pg', 'job'],
            mutedCats:     LS('pref_mutedCats')    || [],
            mutedVendors:  LS('pref_mutedVendors') || [],
        };

        const lat      = position.coords.latitude;
        const lng      = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        const speed    = position.coords.speed;   
        const now      = Date.now();

        // ── Gate 3: GPS accuracy ──────────────────────────────────────────────
        if (accuracy > RULES.MIN_GPS_ACCURACY) return;

        // ── Gate 4: Fake GPS detection ────────────────────────────────────────
        if (this.lastPosition) {
            const dtSec  = (now - this.lastPosition.ts) / 1000;
            const jumpM  = distM(lat, lng, this.lastPosition.lat, this.lastPosition.lng);
            const impliedSpeed = dtSec > 0 ? jumpM / dtSec : 0;

            if (impliedSpeed > RULES.MAX_JUMP_MPS) {
                console.warn(`[NearPop] Fake GPS suspected. Skipping.`);
                this.lastPosition = { lat, lng, ts: now };
                return;
            }
        }
        this.lastPosition = { lat, lng, ts: now };

        // ── Gate 5: Velocity filter ───────────────────────────────────────────
        if (speed !== null && speed !== undefined && speed > RULES.MAX_SPEED_MPS) return;

        // ── Gate 6: Global notification queue (3-min gap) ─────────────────────
        // FIXED: Using LS() and SS()
        const lastNotifTime = parseInt(LS('last_notif_time')) || 0;
        if (now - lastNotifTime < RULES.GLOBAL_QUEUE_MS) return;

        // ── Gate 7: Daily limit ───────────────────────────────────────────────
        const today       = new Date().toDateString();
        let dailyTracker  = LS('daily_tracker') || { date: today, count: 0 };
        if (dailyTracker.date !== today) dailyTracker = { date: today, count: 0 };
        if (dailyTracker.count >= prefs.maxDay) return;

        // ── Gate 8: Density-based radius scaling ──────────────────────────────
        const triggerRadius = activeListings.length > 10 ? 50 : 500;
        const qualifiedDeals = [];

        // ── Deal loop ─────────────────────────────────────────────────────────
        for (const deal of activeListings) {

            if (deal.popupsSentToday >= (deal.dailyPopupLimit || 100)) continue;

            // ── Hourly budget pacing ──────────────────────────────────────────
            // FIXED: Using LS()
            const hourKey    = `hourly_${deal.id}_${new Date().toISOString().slice(0, 13)}`; 
            const hourlySent = parseInt(LS(hourKey)) || 0;
            const hourlyLimit = deal.hourlyPopupLimit || RULES.HOURLY_BUDGET_DEFAULT;
            if (hourlySent >= hourlyLimit) continue;

            if (deal.expiryDate && new Date(deal.expiryDate) < new Date()) continue;

            if (!prefs.interests.includes(deal.type))            continue;
            if (prefs.mutedCats.includes(deal.type))             continue;
            if (prefs.mutedVendors.includes(deal.uid || deal.id)) continue;

            // FIXED: Using LS()
            const lastSeenDeal = parseInt(LS(`seen_${deal.id}`)) || 0;
            if (now - lastSeenDeal < RULES.DEAL_COOLDOWN_MS) continue;

            const distance = distM(lat, lng, parseFloat(deal.lat), parseFloat(deal.lng));

            if (distance <= triggerRadius) {
                if (!this.lingerCache[deal.id]) {
                    this.lingerCache[deal.id] = now;
                } else if (now - this.lingerCache[deal.id] >= RULES.LINGER_MS) {
                    deal.score    = this.calculatePriorityScore(deal, distance);
                    deal._hourKey = hourKey; 
                    qualifiedDeals.push(deal);
                }
            } else {
                delete this.lingerCache[deal.id];
            }
        }

        if (qualifiedDeals.length > 0) {
            this.processAndFire(qualifiedDeals, dailyTracker);
        }
    }

    calculatePriorityScore(deal, distance) {
        const distanceScore = Math.max(0, 500 - distance);     
        const budgetScore   = Math.min(500, deal.budget || 0); 
        return (distanceScore * 0.6) + (budgetScore * 0.4);
    }

    async processAndFire(qualifiedDeals, dailyTracker) {
        qualifiedDeals.sort((a, b) => b.score - a.score);

        const groupedByMerchant = {};
        qualifiedDeals.forEach(deal => {
            if (!groupedByMerchant[deal.uid]) groupedByMerchant[deal.uid] = [];
            groupedByMerchant[deal.uid].push(deal);
        });

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

        this.triggerUI(primaryDeal, notifTitle, notifBody);

        // FIXED: Using SS()
        SS('last_notif_time', Date.now());

        dailyTracker.count += 1;
        SS('daily_tracker', dailyTracker);

        dealsToAnnounce.forEach(d => {
            SS(`seen_${d.id}`, Date.now());

            if (d._hourKey) {
                const prev = parseInt(LS(d._hourKey)) || 0;
                SS(d._hourKey, prev + 1);
            }

            delete this.lingerCache[d.id];

            try {
                if (d.id) {
                    updateDoc(doc(db, 'listings', d.id), {
                        popups:          increment(1),
                        popupsSentToday: increment(1),
                    });
                }
            } catch (e) {}
        });
    }

    triggerUI(deal, title, body) {
        if ('serviceWorker' in navigator && Notification.permission === 'granted') {
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body,
                    icon:    '/icons/icon-192.png',
                    vibrate: [500, 250, 500],
                    data:    { url: '/detail.html?id=' + deal.id },
                });
            });
        }
        if (typeof window.showNotif === 'function') {
            window.showNotif(deal);
        }
        if (navigator.vibrate) {
            try { navigator.vibrate([500, 250, 500]); } catch (e) {}
        }
    }
}

export const NotificationEngine = new SmartNotificationEngine();