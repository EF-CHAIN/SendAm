import React from 'react';
import { act, create } from 'react-test-renderer';
import ChatScreen, { NETWORK_PROFILES } from '../ChatScreen';

jest.mock('../usePolling', () => jest.fn());
jest.mock('../config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));
jest.mock('../engine/voiceService', () => ({
  voiceService: {
    isSpeechRecognitionSupported: jest.fn(() => false),
    speak: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
  },
}));

describe('ChatScreen Network Latency Simulator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function findText(tree, text) {
    let found = false;
    function walk(node) {
      if (!node || found) return;
      if (typeof node === 'string' && node.includes(text)) {
        found = true;
        return;
      }
      if (typeof node === 'object' && node.children) {
        node.children.forEach(walk);
      }
    }
    walk(tree);
    return found;
  }

  it('renders connection status badge in header and allows switching network profiles in toolbar', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });

    // 1. Enter phone number to get past login screen
    const phoneInput = renderer.root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });

    const startButton = renderer.root.findByProps({
      className: 'w-full bg-green-500 rounded-lg py-2 items-center',
    });
    await act(async () => {
      startButton.props.onPress();
    });

    // 2. Verify initial connection status badge displays 'Online'
    const statusBadge = renderer.root.findByProps({ testID: 'connection-status-badge' });
    expect(statusBadge).toBeDefined();
    expect(findText(statusBadge, 'Online')).toBe(true);

    // 3. Verify dropdown trigger shows default 'No Throttling (0ms)'
    const trigger = renderer.root.findByProps({ testID: 'network-simulator-dropdown-trigger' });
    expect(trigger).toBeDefined();
    expect(findText(trigger, 'No Throttling (0ms)')).toBe(true);

    // 4. Open dropdown
    await act(async () => {
      trigger.props.onPress();
    });

    const menu = renderer.root.findByProps({ testID: 'network-simulator-menu' });
    expect(menu).toBeDefined();

    // 5. Select 'Fast 3G (500ms)'
    const fast3gOption = renderer.root.findByProps({ testID: 'network-profile-option-fast-3g' });
    await act(async () => {
      fast3gOption.props.onPress();
    });

    // 6. Verify badge and trigger updated
    expect(findText(statusBadge, 'Fast 3G')).toBe(true);
    expect(findText(trigger, 'Fast 3G (500ms)')).toBe(true);

    // 7. Open dropdown again and select 'Offline (Error)'
    await act(async () => {
      trigger.props.onPress();
    });
    const offlineOption = renderer.root.findByProps({ testID: 'network-profile-option-offline' });
    await act(async () => {
      offlineOption.props.onPress();
    });

    expect(findText(statusBadge, 'Offline')).toBe(true);
    expect(findText(trigger, 'Offline (Error)')).toBe(true);
  });

  it('delays response when Fast 3G is selected and simulates offline error when Offline is selected', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });

    // Enter phone number
    const phoneInput = renderer.root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });
    const startButton = renderer.root.findByProps({
      className: 'w-full bg-green-500 rounded-lg py-2 items-center',
    });
    await act(async () => {
      startButton.props.onPress();
    });

    // Mock fetch for successful response
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ replies: ['Hello from SendAm bot!'] }),
    });

    // Switch to Fast 3G (500ms)
    const trigger = renderer.root.findByProps({ testID: 'network-simulator-dropdown-trigger' });
    await act(async () => {
      trigger.props.onPress();
    });
    const fast3gOption = renderer.root.findByProps({ testID: 'network-profile-option-fast-3g' });
    await act(async () => {
      fast3gOption.props.onPress();
    });

    // Type and send a message
    const msgInput = renderer.root.findByProps({ placeholder: 'Type a message or use speech' });
    await act(async () => {
      msgInput.props.onChangeText('test message');
    });

    const sendBtn = renderer.root.findByProps({ testID: 'send-button' });
    const startTime = Date.now();
    await act(async () => {
      await sendBtn.props.onPress();
    });
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(global.fetch).toHaveBeenCalled();

    // Now switch to Offline (Error) profile
    await act(async () => {
      trigger.props.onPress();
    });
    const offlineOption = renderer.root.findByProps({ testID: 'network-profile-option-offline' });
    await act(async () => {
      offlineOption.props.onPress();
    });

    // Clear fetch calls
    global.fetch.mockClear();

    // Send another message
    await act(async () => {
      msgInput.props.onChangeText('offline test');
    });
    await act(async () => {
      await sendBtn.props.onPress();
    });

    // fetch should NOT have been called because network is offline
    expect(global.fetch).not.toHaveBeenCalled();
    // An error message should have been appended to the conversation
    expect(findText(renderer.toJSON(), "Couldn't reach SendAm: Network error: Device is offline")).toBe(true);
  });
});
