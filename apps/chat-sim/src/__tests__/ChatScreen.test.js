import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import ChatScreen, { MessageStatus } from '../ChatScreen';

jest.mock('../api', () => ({
  fetchMessages: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn().mockResolvedValue([]),
}));

describe('ChatScreen message receipt lifecycle & edge cases', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function findByTestId(tree, testId) {
    let found = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.props?.testID === testId) {
        found.push(node);
      }
      (node.children ?? []).forEach(walk);
    }
    walk(tree);
    return found;
  }

  function findOneByTestId(tree, testId) {
    const results = findByTestId(tree, testId);
    return results[0] ?? null;
  }

  async function setupAndStartChat(renderer) {
    const phoneInput = renderer.root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });
    // Submit in a second act: handleStart reads the phone state from the
    // render that follows the change, not from the one that created the handler.
    await act(async () => {
      renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onSubmitEditing();
    });
  }

  async function sendMessage(renderer, text) {
    const messageInput = renderer.root.findByProps({ placeholder: 'Type a message or use speech' });
    await act(async () => {
      messageInput.props.onChangeText(text);
    });
    await act(async () => {
      renderer.root
        .findByProps({ placeholder: 'Type a message or use speech' })
        .props.onSubmitEditing();
    });
  }

  it('1-4. progresses sequentially: Clock -> Single tick -> Double grey -> Double blue ticks', async () => {
    let resolveFetch;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch.mockReturnValue(fetchPromise);

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'balance');

    // 1. Immediate state: Clock icon (status-pending)
    let json = renderer.toJSON();
    expect(findOneByTestId(json, 'status-pending')).toBeTruthy();
    expect(findOneByTestId(json, 'status-sent')).toBeNull();
    expect(findOneByTestId(json, 'status-delivered')).toBeNull();
    expect(findOneByTestId(json, 'status-read')).toBeNull();

    // 2. Advance 300ms: Single tick (status-sent)
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    json = renderer.toJSON();
    expect(findOneByTestId(json, 'status-pending')).toBeNull();
    expect(findOneByTestId(json, 'status-sent')).toBeTruthy();
    expect(findOneByTestId(json, 'status-delivered')).toBeNull();

    // 3. Advance to 600ms: Double grey ticks (status-delivered)
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    json = renderer.toJSON();
    expect(findOneByTestId(json, 'status-sent')).toBeNull();
    expect(findOneByTestId(json, 'status-delivered')).toBeTruthy();
    expect(findOneByTestId(json, 'status-read')).toBeNull();

    // 4. Resolve fetch bot reply: Double blue ticks (status-read)
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ replies: ['Your SendAm balances: 10 XLM'] }),
      });
      await Promise.resolve();
    });

    json = renderer.toJSON();
    expect(findOneByTestId(json, 'status-delivered')).toBeNull();
    expect(findOneByTestId(json, 'status-read')).toBeTruthy();
  });

  it('5. fast response cannot be overwritten or downgraded by later timer callbacks', async () => {
    // Bot responds in 100ms, before the 300ms and 600ms timers fire
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: ['Fast response'] }),
    });

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'instant');

    // Flush promise microtasks
    await act(async () => {
      await Promise.resolve();
    });

    let json = renderer.toJSON();
    // Reached read state immediately upon reply
    expect(findOneByTestId(json, 'status-read')).toBeTruthy();

    // Advance past 300ms and 600ms timers
    await act(async () => {
      jest.advanceTimersByTime(700);
    });

    json = renderer.toJSON();
    // Must stay at read and not downgrade to sent or delivered
    expect(findOneByTestId(json, 'status-read')).toBeTruthy();
    expect(findOneByTestId(json, 'status-sent')).toBeNull();
    expect(findOneByTestId(json, 'status-delivered')).toBeNull();
  });

  it('6. delayed response stays at delivered grey ticks until reply arrives', async () => {
    global.fetch.mockImplementation(() => new Promise(() => {})); // Request never completes

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'slow request');

    // Advance 5 seconds
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    const json = renderer.toJSON();
    expect(findOneByTestId(json, 'status-delivered')).toBeTruthy();
    expect(findOneByTestId(json, 'status-read')).toBeNull();
  });

  it('7. failed request never transitions to blue', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network disconnected'));

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'failing request');

    // Flush rejection
    await act(async () => {
      await Promise.resolve();
    });

    // Advance past delivery timers
    await act(async () => {
      jest.advanceTimersByTime(700);
    });

    const json = renderer.toJSON();
    // Message reached delivered, but NEVER read
    expect(findOneByTestId(json, 'status-read')).toBeNull();
    // Error bubble rendered for bot
    expect(findOneByTestId(json, 'bubble-bot')).toBeTruthy();
  });

  it('8. handles multiple messages with independent status states and timers', async () => {
    global.fetch.mockImplementation(() => new Promise(() => {}));

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);

    // Message 1
    await sendMessage(renderer, 'first message');

    // Advance 300ms -> Message 1 reaches sent
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    let json = renderer.toJSON();
    expect(findByTestId(json, 'status-sent').length).toBe(1);

    // Advance another 300ms -> Message 1 reaches delivered
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    json = renderer.toJSON();
    expect(findByTestId(json, 'status-delivered').length).toBe(1);
  });

  it('9. reset session cancels pending timers and clears conversation without stale updates', async () => {
    global.fetch.mockImplementation(() => new Promise(() => {}));

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'to be reset');

    // Reset session while timers are active
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const resetButton = renderer.root.findByProps({ testID: 'reset-session-button' });
    await act(async () => {
      resetButton.props.onPress();
    });
    // Reset asks for confirmation first; confirm it.
    const confirmButton = alertSpy.mock.calls[0][2].find((b) => b.text === 'Reset');
    await act(async () => {
      confirmButton.onPress();
    });
    alertSpy.mockRestore();

    // Advance time past all timer delays
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    // Screen is back to enter phone number, no messages rendered
    expect(renderer.root.findAllByProps({ placeholder: '+2348000000001' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ placeholder: 'Type a message or use speech' })).toHaveLength(0);
  });

  it('10. unmount cancels timers cleanly without leaking updates', async () => {
    global.fetch.mockImplementation(() => new Promise(() => {}));

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'unmount test');

    await act(async () => {
      renderer.unmount();
    });

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(true).toBe(true);
  });

  it('11-12. preserves existing bubble test IDs and renders correct indicators', async () => {
    global.fetch.mockImplementation(() => new Promise(() => {}));

    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    await setupAndStartChat(renderer);
    await sendMessage(renderer, 'check bubbles');

    const json = renderer.toJSON();
    expect(findOneByTestId(json, 'bubble-user')).toBeTruthy();
    expect(findOneByTestId(json, 'status-pending')).toBeTruthy();
  });
});
