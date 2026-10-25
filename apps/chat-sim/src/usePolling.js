import { useEffect, useRef } from 'react';
import { fetchMessages } from './api';

export const ACTIVE_POLL_INTERVAL_MS = 3000;
export const BACKGROUND_POLL_INTERVAL_MS = 30000;
export const MAX_BACKOFF_MS = 30000;

export function calculateNextInterval({
  isHidden = false,
  consecutiveErrors = 0,
  activeInterval = ACTIVE_POLL_INTERVAL_MS,
  backgroundInterval = BACKGROUND_POLL_INTERVAL_MS,
  maxBackoff = MAX_BACKOFF_MS,
} = {}) {
  if (isHidden) {
    return backgroundInterval;
  }
  if (consecutiveErrors > 0) {
    const backoff = activeInterval * Math.pow(2, consecutiveErrors);
    return Math.min(backoff, maxBackoff);
  }
  return activeInterval;
}

export default function usePolling(phoneNumber, setMessages) {
  const sinceRef = useRef(null);
  const isPollingRef = useRef(false);

  useEffect(() => {
    if (!phoneNumber) {
      sinceRef.current = null;
      return;
    }

    let active = true;
    let timerId = null;
    let consecutiveErrors = 0;

    function isDocumentHidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function scheduleNextPoll(delay) {
      if (!active) return;
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(poll, delay);
    }

    async function poll() {
      if (!active || isPollingRef.current) return;
      isPollingRef.current = true;

      try {
        const newMsgs = await fetchMessages(phoneNumber, sinceRef.current);
        if (!active) return;

        consecutiveErrors = 0;

        if (newMsgs && newMsgs.length > 0) {
          // Sort messages by createdAt to find the latest
          const sorted = [...newMsgs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          sinceRef.current = sorted[sorted.length - 1].createdAt;

          setMessages((prev) => {
            const updatedList = [...prev];

            for (const msg of sorted) {
              const sender = msg.direction === 'in' ? 'user' : 'bot';

              // Find if there is a local message that matches (same text and sender, and no createdAt)
              const matchIndex = updatedList.findIndex(
                (m) => m.text === msg.text && m.sender === sender && !m.createdAt
              );

              if (matchIndex !== -1) {
                // Update the local message with the API's metadata
                updatedList[matchIndex] = {
                  ...updatedList[matchIndex],
                  id: msg.createdAt,
                  createdAt: msg.createdAt,
                };
              } else {
                // If it's not a local message we already have, check if it's already in there by id/createdAt
                const alreadyExists = updatedList.some(
                  (m) => m.id === msg.createdAt || m.createdAt === msg.createdAt
                );
                if (!alreadyExists) {
                  updatedList.push({
                    id: msg.createdAt,
                    text: msg.text,
                    sender,
                    createdAt: msg.createdAt,
                  });
                }
              }
            }
            return updatedList;
          });
        }
      } catch (error) {
        console.error('Polling error:', error);
        consecutiveErrors++;
      } finally {
        isPollingRef.current = false;
        if (active) {
          const delay = calculateNextInterval({
            isHidden: isDocumentHidden(),
            consecutiveErrors,
          });
          scheduleNextPoll(delay);
        }
      }
    }

    function handleVisibilityOrFocus() {
      if (!active) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        // Tab brought to foreground: immediately trigger fresh poll and restore active frequency
        if (timerId) clearTimeout(timerId);
        poll();
      }
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', handleVisibilityOrFocus);
    }

    // Trigger initial poll immediately
    poll();

    return () => {
      active = false;
      if (timerId) {
        clearTimeout(timerId);
      }
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      }
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('focus', handleVisibilityOrFocus);
      }
    };
  }, [phoneNumber, setMessages]);
}
