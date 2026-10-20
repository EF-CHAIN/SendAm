import { useEffect, useState } from 'react';
import { formatRelativeTime, subscribeRelativeTime } from './formatDate.js';

/**
 * React hook returning live relative time text ("Just now", "5m ago",
 * "2h ago", then the absolute date after 24 hours). Re-renders only when the
 * text changes and cleans up its timer on unmount.
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
export default function useRelativeTime(date) {
  // Key on the timestamp so a new Date instance each render doesn't resubscribe.
  const key = date instanceof Date ? date.getTime() : date;
  const [text, setText] = useState(() => formatRelativeTime(key));

  useEffect(() => subscribeRelativeTime(key, setText), [key]);

  return text;
}
