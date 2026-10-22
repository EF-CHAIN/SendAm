import { formatTranscriptText, formatTranscriptJson, triggerDownload } from '../ChatScreen';

describe('ChatScreen export transcript', () => {
  const sampleMessages = [
    {
      id: 'u-1',
      sender: 'user',
      text: 'balance',
      timestamp: '2026-10-18T20:00:00.000Z',
    },
    {
      id: 'b-1',
      sender: 'bot',
      text: 'Your SendAm balances: 50 XLM',
      timestamp: '2026-10-18T20:00:01.000Z',
    },
  ];

  it('formats transcript to structured plain text', () => {
    const text = formatTranscriptText(sampleMessages, '+2348000000001');
    expect(text).toContain('=== SendAm Chat Transcript ===');
    expect(text).toContain('Phone Number: +2348000000001');
    expect(text).toContain('Total Messages: 2');
    expect(text).toContain('[2026-10-18T20:00:00.000Z] [User]: balance');
    expect(text).toContain('[2026-10-18T20:00:01.000Z] [SendAm]: Your SendAm balances: 50 XLM');
  });

  it('formats transcript to structured json', () => {
    const jsonStr = formatTranscriptJson(sampleMessages, '+2348000000001');
    const parsed = JSON.parse(jsonStr);
    expect(parsed.phoneNumber).toBe('+2348000000001');
    expect(parsed.messageCount).toBe(2);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].text).toBe('balance');
    expect(parsed.messages[0].sender).toBe('user');
    expect(parsed.messages[1].sender).toBe('bot');
  });

  it('safely handles environments without DOM for triggerDownload', () => {
    const result = triggerDownload('hello', 'test.txt', 'text/plain');
    expect(typeof result).toBe('boolean');
  });
});
