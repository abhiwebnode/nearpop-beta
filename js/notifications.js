// ╔══════════════════════════════════════════════════════════════════╗
// ║  notifications.js — NearPop Smart Notification Engine (Phase 1)  ║
// ║  Implements Linger, Density Scaling, Cooldowns, and Queuing      ║
// ╚══════════════════════════════════════════════════════════════════╝

import { db, LS, SS, distM } from './app.js';
import { updateDoc, doc, increment } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

// ─── 1. CORE CONFIGURATION ──────────────────────────────────────────
const RULES = {
    LINGER_MS: 5000,                  // 5 seconds wait before firing (Intent Filter)
    GLOBAL_QUEUE_MS: 3 * 60 * 1000,   // 3 minutes between ANY push notifications
    DEAL_COOLDOWN_MS: 48 * 60 * 60 * 1000, // 48 hours before repeating the same deal
    MAX_NOTIFS_PER_DAY: 5,            // Default global cap (Can be changed in profile)
    MIN_GPS_ACCURACY: 100             // Ignore GPS jumps worse than 100 meters
};

class SmartNotificationEngine {
    constructor() {
        this.lingerCache = {}; // Tracks { dealId: firstSeenTimestamp }
        this.systemMuted = false; // Admin kill-switch
    }

    // ─── 2. THE GATEWAY: PROCESS EVERY GPS PING ─────────────────────
    async evaluate(position, activeListings) {
        if (this.systemMuted) return;

        // RULE: User Preference - Is Muted? (Set in profile.html)
        if (localStorage.getItem('pref_paused') === 'true') return;

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        // RULE: GPS Accuracy Validation
        if (accuracy > RULES.MIN_GPS_ACCURACY) {
            console.warn(`[NearPop] GPS too inaccurate (${Math.round(accuracy)}m). Pausing notifications.`);
            return;
        }

        // RULE: Global Notification Limits (Queue & Daily Cap)
        const lastNotifTime = parseInt(LS('np_last_notif_time')) || 0;
        if (Date.now() - lastNotifTime < RULES.GLOBAL_QUEUE_MS) return; // Still in 3-min queue

        // RULE: User Preference - Max Per Day Limits
        const userMaxLimit = parseInt(localStorage.getItem('pref_maxDay')) || RULES.MAX_NOTIFS_PER_DAY;
        const notifsToday = parseInt(SS('np_notifs_today')) || 0; // Resets on session/day
        if (notifsToday >= userMaxLimit) return;

        // RULE: Radius Density Scaling
        // If there are > 10 deals in this chunk, shrink the radius to 50m. Otherwise 500m.
        const triggerRadius = activeListings.length > 10 ? 50 : 500;

        let qualifiedDeals = [];

        // ─── 3. EVALUATE NEARBY DEALS ───────────────────────────────
        for (const deal of activeListings) {
            // Check budget & expiry
            if (deal.popupsSentToday >= (deal.dailyPopupLimit || 100)) continue;
            if (deal.expiryDate && new Date(deal.expiryDate) < new Date()) continue;

            // RULE: Deal Cooldown (48 hours)
            const lastSeenDeal = parseInt(LS(`np_seen_${deal.id}`)) || 0;
            if (Date.now() - lastSeenDeal < RULES.DEAL_COOLDOWN_MS) continue;

            // Calculate distance safely
            const distance = distM(lat, lng, parseFloat(deal.lat), parseFloat(deal.lng));

            if (distance <= triggerRadius) {
                // RULE: Linger Filter (Wait 5 seconds)
                if (!this.lingerCache[deal.id]) {
                    // Just entered the radius. Start the timer.
                    this.lingerCache[deal.id] = Date.now();
                } else if (Date.now() - this.lingerCache[deal.id] >= RULES.LINGER_MS) {
                    // Lingered for > 5 seconds! Add to qualified list and score it.
                    deal.score = this.calculatePriorityScore(deal, distance);
                    qualifiedDeals.push(deal);
                }
            } else {
                // User left the radius. Reset their linger timer for this deal.
                delete this.lingerCache[deal.id];
            }
        }

        // If deals passed all rules, fire them!
        if (qualifiedDeals.length > 0) {
            this.processAndFire(qualifiedDeals);
        }
    }

    // ─── 4. PRIORITY SCORING ────────────────────────────────────────
    calculatePriorityScore(deal, distance) {
        // Lower distance = higher score. Higher budget = higher score.
        const distanceScore = Math.max(0, 500 - distance); 
        const budgetScore = Math.min(500, deal.budget || 0); 
        return (distanceScore * 0.6) + (budgetScore * 0.4);
    }

    // ─── 5. MERCHANT GROUPING & FIRING ──────────────────────────────
    async processAndFire(qualifiedDeals) {
        // Sort deals by our priority score (Highest score first)
        qualifiedDeals.sort((a, b) => b.score - a.score);

        // RULE: Merchant-Level Grouping
        // Group deals by merchant ID (uid) to prevent spamming 5 popups for one bakery
        const groupedByMerchant = {};
        qualifiedDeals.forEach(deal => {
            if (!groupedByMerchant[deal.uid]) groupedByMerchant[deal.uid] = [];
            groupedByMerchant[deal.uid].push(deal);
        });

        // Pick the top merchant group based on the highest scored deal
        const topMerchantUid = qualifiedDeals[0].uid;
        const dealsToAnnounce = groupedByMerchant[topMerchantUid];
        const primaryDeal = dealsToAnnounce[0];

        // Format the Notification Output
        let notifTitle = '';
        let notifBody = '';

        if (dealsToAnnounce.length > 1) {
            // Grouped Notification
            notifTitle = `${primaryDeal.owner || 'A nearby store'} has ${dealsToAnnounce.length} offers! 🎁`;
            notifBody = `Including: ${primaryDeal.title}. Tap to see all.`;
        } else {
            // Single Notification
            notifTitle = `${primaryDeal.emoji || '📍'} ${primaryDeal.title}`;
            notifBody = `${primaryDeal.price ? primaryDeal.price + ' · ' : ''}${primaryDeal.desc.slice(0, 40)}...`;
        }

        // Send to screen/device
        this.triggerUI(primaryDeal, notifTitle, notifBody);

        // Enforce Queues and Cooldowns locally
        localStorage.setItem('np_last_notif_time', Date.now());
        sessionStorage.setItem('np_notifs_today', (parseInt(SS('np_notifs_today')) || 0) + 1);
        
        dealsToAnnounce.forEach(d => {
            localStorage.setItem(`np_seen_${d.id}`, Date.now());
            delete this.lingerCache[d.id]; // Clear linger cache so it doesn't leak memory
            
            // Deduct from merchant budget in Firestore silently
            try {
                if (d.id) {
                    updateDoc(doc(db, 'listings', d.id), { 
                        popups: increment(1), 
                        popupsSentToday: increment(1) 
                    });
                }
            } catch(e) { console.warn("Failed to update popup count"); }
        });
    }

    // ─── 6. UI & HARDWARE TRIGGERS ──────────────────────────────────
    triggerUI(deal, title, body) {
        // A. Web Push (If permission granted & backgrounded)
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
        
        // B. In-App Buzz (If they are looking at the map)
        if (typeof window.showNotif === 'function') {
            window.showNotif(deal); // Triggers your visual DOM popup from map.html
        } 

        // C. Hardware Haptics (Vibration)
        if (navigator.vibrate) {
            try { navigator.vibrate([500, 250, 500]); } catch(e) {}
        }
    }
}

// ─── 7. EXPORT SINGLETON ────────────────────────────────────────────
export const NotificationEngine = new SmartNotificationEngine();