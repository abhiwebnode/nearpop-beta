const admin = require('firebase-admin');
const functions = require('firebase-functions');
const sharp = require('sharp');

admin.initializeApp();

const db = admin.firestore();
const region = functions.region('asia-south1');
const NOTIFICATION_COST = 0.1;

exports.uploadListingImage = region
  .runWith({ memory: '1GB', timeoutSeconds: 30, maxInstances: 10 })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
    }

    const userId = context.auth.uid;
    await enforceRateLimit(`upload_${userId}`, 5, 60 * 60 * 1000);

    const imageBase64 = data && data.imageBase64;
    if (!imageBase64 || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageBase64)) {
      throw new functions.https.HttpsError('invalid-argument', 'Only JPEG, PNG, and WebP images are allowed.');
    }

    const base64Data = imageBase64.split(',')[1];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    if (imageBuffer.length > 5 * 1024 * 1024) {
      throw new functions.https.HttpsError('invalid-argument', 'Image must be 5MB or smaller.');
    }

    const metadata = await sharp(imageBuffer).metadata();
    if (!['jpeg', 'jpg', 'png', 'webp'].includes(metadata.format)) {
      throw new functions.https.HttpsError('invalid-argument', 'Unsupported image type.');
    }
    if (metadata.width > 4000 || metadata.height > 4000) {
      throw new functions.https.HttpsError('invalid-argument', 'Image dimensions are too large.');
    }

    const optimized = await sharp(imageBuffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    const imgbbKey = functions.config().imgbb && functions.config().imgbb.key;
    if (!imgbbKey) {
      throw new functions.https.HttpsError('failed-precondition', 'Image upload service is not configured.');
    }

    const form = new URLSearchParams();
    form.append('image', optimized.toString('base64'));
    form.append('expiration', '15552000');

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const result = await response.json();
    if (!result.success || !result.data || !result.data.url) {
      throw new functions.https.HttpsError('internal', 'Image host rejected upload.');
    }

    await db.collection('upload_logs').add({
      userId,
      imageUrl: result.data.url,
      imageId: result.data.id || null,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      originalBytes: imageBuffer.length,
      optimizedBytes: optimized.length,
      dimensions: `${metadata.width}x${metadata.height}`,
      originalFormat: metadata.format
    });

    return {
      success: true,
      imageUrl: result.data.url,
      thumbnailUrl: (result.data.thumb && result.data.thumb.url) || result.data.url
    };
  });

exports.reserveNotificationSlot = region.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
  }

  const userId = context.auth.uid;
  const listingId = data && data.listingId;
  if (!listingId) {
    throw new functions.https.HttpsError('invalid-argument', 'listingId is required.');
  }

  await enforceRateLimit(`notif_${userId}`, 30, 60 * 1000);

  return db.runTransaction(async transaction => {
    const listingRef = db.collection('listings').doc(listingId);
    const listingSnap = await transaction.get(listingRef);
    if (!listingSnap.exists) return { allowed: false, reason: 'listing_not_found' };

    const listing = listingSnap.data();
    if (listing.status !== 'active') return { allowed: false, reason: 'listing_inactive' };
    if (listing.expiryDate && new Date(listing.expiryDate) < new Date()) {
      return { allowed: false, reason: 'listing_expired' };
    }

    const merchantId = listing.uid;
    if (!merchantId) return { allowed: false, reason: 'merchant_missing' };

    const merchantRef = db.collection('users').doc(merchantId);
    const merchantSnap = await transaction.get(merchantRef);
    if (!merchantSnap.exists) return { allowed: false, reason: 'merchant_not_found' };

    const merchant = merchantSnap.data();
    const wallet = Number(merchant.wallet || 0);
    if (wallet < NOTIFICATION_COST) {
      return { allowed: false, reason: 'insufficient_funds', balance: wallet };
    }

    const today = new Date().toDateString();
    const lastResetDate = listing.popupResetDate || '';
    const currentPopups = lastResetDate === today ? Number(listing.popupsSentToday || 0) : 0;
    const dailyLimit = Number(listing.dailyPopupLimit || 100);
    if (currentPopups >= dailyLimit) {
      return { allowed: false, reason: 'daily_limit_reached', sent: currentPopups, limit: dailyLimit };
    }

    transaction.update(listingRef, {
      popups: admin.firestore.FieldValue.increment(1),
      popupsSentToday: currentPopups + 1,
      popupResetDate: today,
      lastPopupAt: admin.firestore.FieldValue.serverTimestamp()
    });
    transaction.update(merchantRef, {
      wallet: admin.firestore.FieldValue.increment(-NOTIFICATION_COST),
      totalSpent: admin.firestore.FieldValue.increment(NOTIFICATION_COST),
      lastChargeAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      allowed: true,
      charged: NOTIFICATION_COST,
      balance: wallet - NOTIFICATION_COST,
      popupsSent: currentPopups + 1
    };
  });
});

exports.validateNewListing = region.firestore.document('listings/{listingId}').onCreate(async (snap, context) => {
  const listing = snap.data();
  const issues = [];
  const sanitized = {
    title: sanitizeText(listing.title, 200),
    desc: sanitizeText(listing.desc, 5000),
    price: sanitizeText(listing.price, 80),
    contact: sanitizePhone(listing.contact)
  };

  if (!sanitized.title || sanitized.title.length < 3) issues.push('invalid_title');
  if (!['deal', 'rental', 'pg', 'job'].includes(listing.type)) issues.push('invalid_type');
  if (!validIndiaCoordinates(listing.lat, listing.lng)) issues.push('invalid_location');
  if (!validBudget(listing.budget)) issues.push('invalid_budget');

  const suspicious = /<script|javascript:|onerror|onclick|<iframe|data:text\/html/i;
  if (suspicious.test(`${listing.title || ''} ${listing.desc || ''}`)) issues.push('suspicious_content');

  if (issues.length) {
    await snap.ref.update({
      status: 'flagged',
      flagReason: issues.join(','),
      flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...sanitized
    });
    await db.collection('admin_alerts').add({
      type: 'listing_flagged',
      listingId: context.params.listingId,
      userId: listing.uid || null,
      issues,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return;
  }

  await snap.ref.update(sanitized);
});

async function enforceRateLimit(key, limit, windowMs) {
  const ref = db.collection('rate_limits').doc(key);
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const hits = snap.exists ? (snap.data().hits || []) : [];
    const recentHits = hits.filter(ts => now - ts < windowMs);
    if (recentHits.length >= limit) {
      throw new functions.https.HttpsError('resource-exhausted', 'Rate limit exceeded.');
    }
    recentHits.push(now);
    transaction.set(ref, { hits: recentHits, updatedAt: now }, { merge: true });
  });
}

function sanitizeText(value, maxLength) {
  if (!value) return '';
  return String(value)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

function sanitizePhone(value) {
  if (!value) return '';
  let phone = String(value).replace(/[^\d+]/g, '');
  if (phone.startsWith('+')) phone = '+' + phone.slice(1).replace(/\+/g, '');
  return phone.slice(0, 15);
}

function validIndiaCoordinates(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' && lat >= 6 && lat <= 39 && lng >= 66 && lng <= 99;
}

function validBudget(budget) {
  return typeof budget === 'number' && budget >= 25 && budget <= 10000 && budget % 25 === 0;
}
