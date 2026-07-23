import { useEffect, useRef } from 'react';
import { fetchMessages } from './api';

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

    async function poll() {
      if (!active || isPollingRef.current) return;
      isPollingRef.current = true;

      try {
        const newMsgs = await fetchMessages(phoneNumber, sinceRef.current);
        if (!active) return;

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
      } finally {
        isPollingRef.current = false;
        if (active) {
          timerId = setTimeout(poll, 3000);
        }
      }
    }

    // Trigger initial poll immediately
    poll();

    return () => {
      active = false;
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [phoneNumber, setMessages]);
}
