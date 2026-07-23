import React from 'react';
import { act, create } from 'react-test-renderer';
import usePolling from '../usePolling';
import * as api from '../api';

jest.mock('../api');

function TestComponent({ phoneNumber, setMessages }) {
  usePolling(phoneNumber, setMessages);
  return null;
}

describe('usePolling hook', () => {
  let setMessagesMock;

  beforeEach(() => {
    jest.useFakeTimers();
    setMessagesMock = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  it('polls fetchMessages and appends new messages', async () => {
    const mockMessages = [
      { direction: 'in', text: 'hello', createdAt: '2026-07-23T12:00:00.000Z' },
    ];
    api.fetchMessages.mockResolvedValue(mockMessages);

    let renderer;
    await act(async () => {
      renderer = create(<TestComponent phoneNumber="+2348000000001" setMessages={setMessagesMock} />);
    });

    // Initial poll runs immediately
    await act(async () => {
      await Promise.resolve(); // Flush microtasks
    });

    expect(api.fetchMessages).toHaveBeenCalledWith('+2348000000001', null);
    expect(setMessagesMock).toHaveBeenCalled();

    // Call the setMessages callback updater to see how it adds the messages
    const updater = setMessagesMock.mock.calls[0][0];
    const result = updater([]);
    expect(result).toEqual([
      {
        id: '2026-07-23T12:00:00.000Z',
        text: 'hello',
        sender: 'user',
        createdAt: '2026-07-23T12:00:00.000Z',
      },
    ]);

    // Advance timer to trigger next poll
    api.fetchMessages.mockClear();
    setMessagesMock.mockClear();

    const mockMessages2 = [
      { direction: 'out', text: 'hi', createdAt: '2026-07-23T12:00:03.000Z' },
    ];
    api.fetchMessages.mockResolvedValue(mockMessages2);

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    await act(async () => {
      await Promise.resolve(); // Flush microtasks
    });

    // Verify it used the newest createdAt as cursor
    expect(api.fetchMessages).toHaveBeenCalledWith('+2348000000001', '2026-07-23T12:00:00.000Z');
  });

  it('stops polling on unmount', async () => {
    api.fetchMessages.mockResolvedValue([]);

    let renderer;
    await act(async () => {
      renderer = create(<TestComponent phoneNumber="+2348000000001" setMessages={setMessagesMock} />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    api.fetchMessages.mockClear();

    // Unmount
    await act(async () => {
      renderer.unmount();
    });

    // Advance timer
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    // Should not fetch messages after unmount
    expect(api.fetchMessages).not.toHaveBeenCalled();
  });
});
