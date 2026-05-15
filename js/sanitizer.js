class ContentSanitizer {
  constructor() {
    this.dangerousPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /vbscript:/gi,
      /data:text\/html/gi,
      /on\w+\s*=/gi,
      /<iframe/gi,
      /<embed/gi,
      /<object/gi,
      /<link/gi,
      /<style/gi,
      /expression\s*\(/gi,
      /<!--/g,
      /-->/g
    ];
  }

  sanitizeText(value, options = {}) {
    const {
      maxLength = 5000,
      allowNewlines = true,
      trimWhitespace = true
    } = options;

    if (value === null || value === undefined) return '';
    let text = String(value);

    for (const pattern of this.dangerousPatterns) {
      text = text.replace(pattern, '');
    }

    text = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');

    if (!allowNewlines) {
      text = text.replace(/[\r\n]+/g, ' ');
    }

    if (trimWhitespace) text = text.trim();
    return text.slice(0, maxLength);
  }

  escapeHTML(value, maxLength = 5000) {
    return this.sanitizeText(value, { maxLength });
  }

  sanitizePhone(value) {
    if (!value) return '';
    let phone = String(value).trim().replace(/[^\d+]/g, '');

    if (phone.startsWith('+')) {
      phone = '+' + phone.slice(1).replace(/\+/g, '');
    } else {
      phone = phone.replace(/\+/g, '');
    }

    if (phone.startsWith('+91')) {
      return phone.length === 13 ? phone : '';
    }

    if (!phone.startsWith('+') && phone.length !== 10) return '';
    return phone.slice(0, 15);
  }

  sanitizeNumber(value, options = {}) {
    const { min = null, max = null, decimals = 0 } = options;
    let num = Number.parseFloat(value);
    if (!Number.isFinite(num)) return min !== null ? min : 0;

    const factor = 10 ** decimals;
    num = Math.round(num * factor) / factor;

    if (min !== null && num < min) return min;
    if (max !== null && num > max) return max;
    return num;
  }

  sanitizeCoordinates(latValue, lngValue) {
    const lat = Number.parseFloat(latValue);
    const lng = Number.parseFloat(lngValue);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < 6 || lat > 39 || lng < 66 || lng > 99) return null;

    return {
      lat: Math.round(lat * 1000000) / 1000000,
      lng: Math.round(lng * 1000000) / 1000000
    };
  }

  sanitizeUrl(value) {
    if (!value) return '';
    const url = String(value).trim();
    if (url.length > 2048) return '';
    if (!/^https?:\/\//i.test(url)) return '';
    if (/^(javascript|data|vbscript):/i.test(url)) return '';
    return url;
  }

  sanitizeListing(input) {
    const coords = this.sanitizeCoordinates(input.lat, input.lng);
    const budget = this.sanitizeNumber(input.budget, { min: 25, max: 10000 });

    return {
      ...input,
      title: this.sanitizeText(input.title, { maxLength: 200, allowNewlines: false }),
      desc: this.sanitizeText(input.desc, { maxLength: 5000 }),
      price: this.sanitizeText(input.price, { maxLength: 80, allowNewlines: false }),
      contact: this.sanitizePhone(input.contact),
      lat: coords?.lat,
      lng: coords?.lng,
      budget
    };
  }

  validateListing(listing) {
    const errors = [];
    if (!listing.title || listing.title.length < 3) errors.push('Title must be at least 3 characters.');
    if (!listing.desc || listing.desc.length < 10) errors.push('Description must be at least 10 characters.');
    if (!listing.price) errors.push('Price or offer is required.');
    if (!listing.contact) errors.push('Enter a valid phone number.');
    if (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lng)) errors.push('Choose a valid location in India.');
    if (!['deal', 'rental', 'pg', 'job'].includes(listing.type)) errors.push('Choose a valid listing type.');
    if (!listing.budget || listing.budget < 25 || listing.budget > 10000 || listing.budget % 25 !== 0) {
      errors.push('Budget must be a multiple of 25 between 25 and 10000.');
    }

    return { valid: errors.length === 0, errors };
  }
}

export const sanitizer = new ContentSanitizer();
export const esc = (value, maxLength) => sanitizer.escapeHTML(value, maxLength);
export const safeUrl = value => sanitizer.sanitizeUrl(value);
