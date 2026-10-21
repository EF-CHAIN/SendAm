export const formatDate = (dateString) => {
  if (!dateString) return '';
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Future timestamps within this window are treated as clock skew. */
const FUTURE_SKEW_MS = MINUTE_MS;

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function toTime(date) {
  if (date === null || date === undefined || date === '') return NaN;
  return new Date(date).getTime();
}

/**
 * Formats a timestamp relative to now.
 *
 * - under 1 minute: "Just now"
 * - under 1 hour: "5m ago"
 * - under 24 hours: "2h ago"
 * - 24 hours or more: the absolute `formatDate` output
 *
 * Timestamps up to a minute in the future (clock skew) read "Just now";
 * further in the future they use `Intl.RelativeTimeFormat` ("in 5 minutes")
 * for the next 24 hours and the absolute date beyond that.
 *
 * Returns an empty string for empty or unparseable input instead of throwing.
 *
 * @param {Date|string|number} date
 * @param {number} [now] - current time in ms, injectable for tests
 * @returns {string}
 */
export function formatRelativeTime(date, now = Date.now()) {
  const time = toTime(date);
  if (Number.isNaN(time)) return '';

  const age = now - time;

  if (age < 0) {
    const ahead = -age;
    if (ahead < FUTURE_SKEW_MS) return 'Just now';
    if (ahead >= DAY_MS) return formatDate(date);
    return ahead < HOUR_MS
      ? relativeFormatter.format(Math.floor(ahead / MINUTE_MS), 'minute')
      : relativeFormatter.format(Math.floor(ahead / HOUR_MS), 'hour');
  }

  if (age < MINUTE_MS) return 'Just now';
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
  return formatDate(date);
}

/**
 * Milliseconds until the text from `formatRelativeTime` can next change, or
 * null when it never will (invalid input or already an absolute date).
 *
 * Recent events (< 1 hour) tick on every minute boundary; older ones on every
 * hour boundary until they roll over to the absolute date after 24 hours.
 *
 * @param {Date|string|number} date
 * @param {number} [now]
 * @returns {number|null}
 */
export function getNextRelativeTimeUpdateDelay(date, now = Date.now()) {
  const time = toTime(date);
  if (Number.isNaN(time)) return null;

  const age = now - time;
  if (age < 0) return MINUTE_MS;
  if (age >= DAY_MS) return null;

  const step = age < HOUR_MS ? MINUTE_MS : HOUR_MS;
  return step - (age % step);
}

/**
 * Calls `callback` with the relative text now and whenever it changes
 * (every minute for the first hour, hourly afterwards), then stops once the
 * text becomes an absolute date.
 *
 * @param {Date|string|number} date
 * @param {(text: string) => void} callback
 * @returns {() => void} unsubscribe
 */
export function subscribeRelativeTime(date, callback) {
  let timer = null;
  let active = true;

  const tick = () => {
    if (!active) return;
    callback(formatRelativeTime(date));
    const delay = getNextRelativeTimeUpdateDelay(date);
    if (delay !== null) timer = setTimeout(tick, delay);
  };

  tick();

  return () => {
    active = false;
    clearTimeout(timer);
  };
}
