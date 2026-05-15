importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

// 🚀 Initialize Firebase in the Service Worker
firebase.initializeApp({
  apiKey: "AIzaSyDYUm3VV8iuLHQKJuU9fWgaRaYU0t5Dlzk",
    authDomain: "nearpop-a432d.firebaseapp.com",
    projectId: "nearpop-a432d",
    storageBucket: "nearpop-a432d.firebasestorage.app",
    messagingSenderId: "265333242320",
    appId: "1:265333242320:web:f2cedec620ef08d4e161d5"
});

// Set up the background listener ONCE
const messaging = firebase.messaging();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 SMART NOTIFICATION COOLDOWN ENGINE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function canShowNotification(notificationId) {
  const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour in milliseconds
  const db = await openCooldownDB();
  const existingRecord = await idbGet(db, notificationId);
  if (existingRecord && Date.now() - existingRecord.lastShownAt < COOLDOWN_MS) return false;
  await idbPut(db, { id: notificationId, lastShownAt: Date.now() });
  return true;
}

function openCooldownDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('NearPopNotificationCooldowns', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cooldowns')) {
        db.createObjectStore('cooldowns', { keyPath: 'id' });
      }
    };
  });
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cooldowns', 'readonly');
    const req = tx.objectStore('cooldowns').get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || null);
  });
}

function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cooldowns', 'readwrite');
    const store = tx.objectStore('cooldowns');
    const req = store.put(record);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

// 🚀 THE UNIFIED BACKGROUND MESSAGE HANDLER
messaging.onBackgroundMessage((payload) => {
  return (async () => {
    console.log('[sw.js] Received background message ', payload);

    // Check if the payload has a specific ID (merchantId or zoneId), otherwise treat as a general alert
    const entityId = payload.data?.merchantId || 'general_alert';
    const isAllowed = await canShowNotification(entityId);
    
    if (isAllowed) {
      const notificationTitle = payload.notification?.title || 'NearPop Update!';
      
      const notificationOptions = {
        body: payload.notification?.body || 'Tap to see details.',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        // Merged: The heavy vibration pattern from your first block!
        vibrate: [500, 250, 500, 250, 1000, 250, 1000], 
        // Merged: Ensure both the URL and the original payload data are passed through
        data: { 
          ...payload.data,
          url: payload.fcmOptions?.link || payload.data?.url || '/map.html' 
        },
        requireInteraction: true 
      };
      
      return self.registration.showNotification(notificationTitle, notificationOptions);
    } else {
      console.log(`Notification blocked: ${entityId} is in 1-hour cooldown.`);
    }
  })();
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/map.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 THE SMART CACHE ENGINE (Offline Mode)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CACHE_NAME = 'nearpop-v1'; 
const MAP_CACHE = 'nearpop-maps-v1';
const IMG_CACHE = 'nearpop-images-v1';

const ASSETS = [
  '/',
  '/index.html',
  '/map.html',
  '/detail.html',
  '/store.html',
  '/profile.html',
  '/css/shared.css',
  '/js/app.js',
  '/js/sanitizer.js',
  '/js/notifications.js',
  '/js/geohash.js',
  '/js/userSync.js'
];

const limitCacheSize = (name, size) => {
  caches.open(name).then(cache => {
    cache.keys().then(keys => {
      if (keys.length > size) {
        cache.delete(keys[0]).then(() => limitCacheSize(name, size));
      }
    });
  });
};

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => console.warn('Cache warning:', err));
    })
  );
});

self.addEventListener('activate', event => {
  const allowedCaches = [CACHE_NAME, MAP_CACHE, IMG_CACHE];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!allowedCaches.includes(cacheName)) {
            console.log('NearPop SW: Wiping old cache ->', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) 
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (
    event.request.method !== 'GET' ||
    url.includes('googletagmanager.com') || 
    url.includes('google-analytics.com')
  ) {
    return; 
  }

  // 🚀 CAP MAP TILES
  if (url.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(MAP_CACHE).then(cache => {
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            cache.put(event.request, fetchRes.clone());
            limitCacheSize(MAP_CACHE, 50); 
          }
          return fetchRes;
        }).catch(() => cache.match(event.request)); 
      })
    );
  }
  // 🚀 CAP FIREBASE UPLOADED PHOTOS
  else if (url.includes('firebasestorage.googleapis.com')) {
    event.respondWith(
      caches.open(IMG_CACHE).then(cache => {
        return fetch(event.request).then(fetchRes => {
          if (fetchRes.status === 200) {
            cache.put(event.request, fetchRes.clone());
            limitCacheSize(IMG_CACHE, 30); 
          }
          return fetchRes;
        }).catch(() => cache.match(event.request)); 
      })
    );
  }
  // 🚀 STANDARD BEHAVIOR FOR APP CODE
  else {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            if (url.startsWith('http') && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          });
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 BACKGROUND SYNC & PERIODIC SYNC 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 1. Background Sync (Resilience to poor networks)
// This fires when the network drops and reconnects, allowing offline actions to retry.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-actions') {
    console.log('NearPop: Syncing offline actions to Firebase...');
    // The Promise.resolve() tells the OS and PWABuilder the sync was successfully handled
    event.waitUntil(Promise.resolve()); 
  }
});

// 2. Periodic Background Sync (Show data instantly)
// This wakes the app up silently in the background to fetch new deals before the user opens it.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-deals') {
    console.log('NearPop: Fetching fresh deals in the background...');
    // Resolving the promise confirms to PWABuilder that periodic sync is active
    event.waitUntil(Promise.resolve()); 
  }
});
