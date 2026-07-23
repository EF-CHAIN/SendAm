import { sendMessage, fetchMessages, ApiError } from './api';
import { API_BASE_URL } from './config';

describe('Chat Simulator API Client Modules', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('sendMessage', () => {
    it('should successfully execute POST request, verify headers, body payload, and return replies', async () => {
      const mockReplies = ['Your SendAm balances: 5 XLM'];
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ replies: mockReplies }),
      });

      const result = await sendMessage('+2348000000001', 'balance');

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/api/sim/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: '+2348000000001',
          text: 'balance',
          name: 'Simulated User',
        }),
      });
      expect(result).toEqual(mockReplies);
    });

    it('should propagate a clean ApiError on 4xx/5xx status drops', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid phone number format' }),
      });

      await expect(sendMessage('+123', 'hi')).rejects.toThrow(ApiError);
      await expect(sendMessage('+123', 'hi')).rejects.toThrow('Invalid phone number format');
    });
  });

  describe('fetchMessages', () => {
    it('should encode URL parameters cleanly, map target endpoints, and process query strings', async () => {
      const mockMessages = [{ direction: 'out', text: 'Alert', createdAt: '2026-01-01T00:00:00.000Z' }];
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: mockMessages }),
      });

      const result = await fetchMessages('+2348000000001', '2026-01-01');

      expect(global.fetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/sim/messages/%2B2348000000001?since=2026-01-01`,
        {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        }
      );
      expect(result).toEqual(mockMessages);
    });

    it('should cleanly capture hardware level network crashes and turn them into readable failures', async () => {
      global.fetch.mockRejectedValue(new Error('Network disconnected'));

      await expect(fetchMessages('+2348000000001')).rejects.toThrow(ApiError);
      await expect(fetchMessages('+2348000000001')).rejects.toThrow('Failed to fetch messages: Network disconnected');
    });
  });
});
                            
