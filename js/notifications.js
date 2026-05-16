// ╔══════════════════════════════════════════════════════════════════╗
// ║  notifications.js — NearPop Smart Notification Engine (Phase 1)  ║
// ║  Implements Linger, Cooldowns, Queuing, AND User Preferences     ║
// ╚══════════════════════════════════════════════════════════════════╝

import { db, LS, SS, distM } from './app.js';
import { updateDoc, doc, increment } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const RULES = {
    LINGER_MS: 5000,                  // 5 seconds wait before firing
    GLOBAL_QUEUE_MS: 3 * 60 * 1000,   // 3 minutes between push notifications
    DEAL_COOLDOWN_MS: 48 * 60 * 60 * 1000, // 48 hours before repeating the same deal
    MAX_NOTIFS_PER_DAY: 5,            // Default fallback
    MIN_GPS_ACCURACY: 100             // Ignore GPS jumps
};

class SmartNotificationEngine {
    constructor() {
        this.lingerCache = {}; 
        this.systemMuted = false; 
    }

    // Safely parse JSON from localStorage
    getArrayPref(key, defaultVal) {
        try { return JSON.parse(localStorage.getItem(key)) || defaultVal; } 
        catch (e) { return defaultVal; }
    }

    async evaluate(position, activeListings) {
        if (this.systemMuted) return;

        // ─── 1. USER PREFERENCES (GLOBAL) ───
        if (localStorage.getItem('pref_paused') === 'true') return;

        const prefs = {
            maxDay: parseInt(localStorage.getItem('pref_maxDay')) || RULES.MAX_NOTIFS_PER_DAY,
            interests: this.getArrayPref('pref_interests', ['deal', 'rental', 'pg', 'job']),
            mutedCats: this.getArrayPref('pref_mutedCats', []),
            mutedVendors: this.getArrayPref('pref_mutedVendors', [])
        };

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        if (accuracy > RULES.MIN_GPS_ACCURACY) return;

        // ─── 2. QUEUE & DAILY LIMITS (Fixed LS Date Tracking) ───
        const lastNotifTime = parseInt(LS('np_last_notif_time')) || 0;
        if (Date.now() - lastNotifTime < RULES.GLOBAL_QUEUE_MS) return; // 3-min queue active

        const today = new Date().toDateString();
        let dailyTracker = this.getArrayPref('np_daily_tracker', { date: today, count: 0 });
        if (dailyTracker.date !== today) dailyTracker = { date: today, count: 0 }; // Reset on new day
        
        if (dailyTracker.count >= prefs.maxDay) return; // Reached user's daily limit

        // ─── 3. DENSITY SCALING ───
        const triggerRadius = activeListings.length > 10 ? 50 : 500;
        let qualifiedDeals = [];

        // ─── 4. EVALUATE DEALS AGAINST USER PREFS ───
        for (const deal of activeListings) {
            // Check merchant budget & expiry
            if (deal.popupsSentToday >= (deal.dailyPopupLimit || 100)) continue;
            if (deal.expiryDate && new Date(deal.expiryDate) < new Date()) continue;

            // NEW: Check User Interest & Blocklists
            if (!prefs.interests.includes(deal.type)) continue;
            if (prefs.mutedCats.includes(deal.type)) continue;
            if (prefs.mutedVendors.includes(deal.uid || deal.id)) continue;

            // Check 48-Hour Cooldown
            const lastSeenDeal = parseInt(LS(`np_seen_${deal.id}`)) || 0;
            if (Date.now() - lastSeenDeal < RULES.DEAL_COOLDOWN_MS) continue;

            const distance = distM(lat, lng, parseFloat(deal.lat), parseFloat(deal.lng));

            if (distance <= triggerRadius) {
                // Check 5-Second Linger
                if (!this.lingerCache[deal.id]) {
                    this.lingerCache[deal.id] = Date.now();
                } else if (Date.now() - this.lingerCache[deal.id] >= RULES.LINGER_MS) {
                    deal.score = this.calculatePriorityScore(deal, distance);
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
        const budgetScore = Math.min(500, deal.budget || 0); 
        return (distanceScore * 0.6) + (budgetScore * 0.4);
    }

    async processAndFire(qualifiedDeals, dailyTracker) {
        qualifiedDeals.sort((a, b) => b.score - a.score);

        const groupedByMerchant = {};
        qualifiedDeals.forEach(deal => {
            if (!groupedByMerchant[deal.uid]) groupedByMerchant[deal.uid] = [];
            groupedByMerchant[deal.uid].push(deal);
        });

        const topMerchantUid = qualifiedDeals[0].uid;
        const dealsToAnnounce = groupedByMerchant[topMerchantUid];
        const primaryDeal = dealsToAnnounce[0];

        let notifTitle = '';
        let notifBody = '';

        if (dealsToAnnounce.length > 1) {
            notifTitle = `${primaryDeal.owner || 'A nearby store'} has ${dealsToAnnounce.length} offers! 🎁`;
            notifBody = `Including: ${primaryDeal.title}. Tap to see all.`;
        } else {
            notifTitle = `${primaryDeal.emoji || '📍'} ${primaryDeal.title}`;
            notifBody = `${primaryDeal.price ? primaryDeal.price + ' · ' : ''}${primaryDeal.desc.slice(0, 40)}...`;
        }

        this.triggerUI(primaryDeal, notifTitle, notifBody);

        // Update Limits
        localStorage.setItem('np_last_notif_time', Date.now());
        
        dailyTracker.count += 1;
        localStorage.setItem('np_daily_tracker', JSON.stringify(dailyTracker));
        
        dealsToAnnounce.forEach(d => {
            localStorage.setItem(`np_seen_${d.id}`, Date.now());
            delete this.lingerCache[d.id]; 
            
            try {
                if (d.id) {
                    updateDoc(doc(db, 'listings', d.id), { 
                        popups: increment(1), 
                        popupsSentToday: increment(1) 
                    });
                }
            } catch(e) {}
        });
    }

    triggerUI(deal, title, body) {
        if ('serviceWorker' in navigator && Notification.permission === 'granted') {
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body: body,
                    icon: '/icons/icon-192.png',
                    vibrate: [500, 250, 500],
                    data: { url: '/detail.html?id=' + deal.id }
                });
            });
        } 
        if (typeof window.showNotif === 'function') {
            window.showNotif(deal);
        } 
        if (navigator.vibrate) {
            try { navigator.vibrate([500, 250, 500]); } catch(e) {}
        }
    }
}

export const NotificationEngine = new SmartNotificationEngine();
