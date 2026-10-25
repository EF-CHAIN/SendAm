import React from 'react';
import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import ChatScreen from '../ChatScreen';

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

describe('ChatScreen Reset Confirmation Dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
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

  it('prompts the user with confirmation dialog before resetting when reset button is pressed', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });

    // 1. Enter phone number
    const phoneInput = renderer.root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });

    // 2. Click Start chatting button
    const startButton = renderer.root.findByProps({
      className: 'w-full bg-green-500 rounded-lg py-2 items-center',
    });
    await act(async () => {
      startButton.props.onPress();
    });

    // 3. We should now be in the chat screen with phone number visible in header
    expect(findText(renderer.toJSON(), '+2348000000001')).toBe(true);

    // 4. Find the reset button
    const resetButton = renderer.root.findByProps({ testID: 'reset-session-button' });
    expect(resetButton).toBeDefined();

    // 5. Click reset button
    await act(async () => {
      resetButton.props.onPress();
    });

    // 6. Verify Alert.alert was called with the required confirmation message and buttons
    expect(Alert.alert).toHaveBeenCalledWith(
      'Reset Conversation',
      'Clear chat history and reset payment state machine?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Reset', style: 'destructive' }),
      ])
    );

    // 7. Still on the chat screen (not yet reset)
    expect(findText(renderer.toJSON(), '+2348000000001')).toBe(true);

    // 8. Extract the Reset action callback from Alert.alert arguments and invoke it
    const alertCalls = Alert.alert.mock.calls;
    const buttons = alertCalls[0][2];
    const confirmButton = buttons.find((b) => b.text === 'Reset');
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton.onPress();
    });

    // 9. Now it should be reset back to the initial login screen
    expect(findText(renderer.toJSON(), 'Enter your phone number')).toBe(true);
  });
});
