// apps/chat-sim/src/api.js
import { API_BASE_URL } from './config';

/**
 * Custom error class for API communication issues.
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Helper to process fetch responses and normalize errors.
 */
async function handleResponse(response) {
  if (!response.ok) {
    let errorMsg = `Network response error: ${response.status} ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData?.message) errorMsg = errorData.message;
    } catch {
      // Fallback if parsing JSON fails
    }
    throw new ApiError(errorMsg, response.status);
  }
  return response.json();
}

/**
 * Sends a message from a simulated user identity to the assistant pipeline.
 * @param {string} phoneNumber - The sender's phone number identity (e.g., '+2348000000001')
 * @param {string} text - The command or message body text
 * @param {string} [name='Simulated User'] - Optional profile name for the user
 * @returns {Promise<string[]>} Array of string replies from the bot
 */
export async function sendMessage(phoneNumber, text, name = 'Simulated User') {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sim/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phoneNumber, text, name }),
    });

    const data = await handleResponse(response);
    return data?.replies || [];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Failed to send message: ${error.message}`);
  }
}

/**
 * Fetches the conversation history and async pushes for a specific identity.
 * @param {string} phoneNumber - The user's phone number identity
 * @param {string} [since] - Optional ISO date string or message ID filter
 * @returns {Promise<Array>} Array of message objects { direction, text, createdAt }
 */
export async function fetchMessages(phoneNumber, since) {
  try {
    const cleanPhone = encodeURIComponent(phoneNumber);
    let url = `${API_BASE_URL}/api/sim/messages/${cleanPhone}`;
    
    if (since) {
      url += `?since=${encodeURIComponent(since)}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    const data = await handleResponse(response);
    return data?.messages || [];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(`Failed to fetch messages: ${error.message}`);
  }
}
