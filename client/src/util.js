// Formatting helpers shared by every view.

export function fmtHours(h) {
  if (h == null) return '–';
  if (h === 0) return '0';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${(h / 24).toFixed(h < 240 ? 1 : 0)} d`;
}

export const fmtNum = (n) => (n == null ? '–' : n.toLocaleString());
export const fmtPct = (n) => (n == null ? '–' : `${Math.round(n)}%`);

export function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-11-02" → "Nov 2" (week) or "Nov 2026" (month)
export function fmtBucket(key, granularity) {
  const [y, m, d] = key.split('-').map(Number);
  return granularity === 'month' ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}`;
}

export function fmtBucketLong(key, granularity) {
  const [y, m, d] = key.split('-').map(Number);
  return granularity === 'month' ? `${MONTHS[m - 1]} ${y}` : `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
}

export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

export function monthsAgo(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return isoDay(d);
}

// Small persisted UI preferences. Storage can be unavailable; fall back silently.
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`review-pipeline:${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`review-pipeline:${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// Move a date back to the start of its week (Monday) or month.
export function snapToBucket(day, granularity) {
  const d = new Date(`${day}T00:00:00Z`);
  if (granularity === 'month') d.setUTCDate(1);
  else d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return isoDay(d);
}
