import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import MessageList, { parseQuickReplies } from './MessageList';
import EmojiPicker from './EmojiPicker';
import usePolling from './usePolling';
import {
  PaymentStateMachine,
  PaymentState,
  PaymentEvent,
} from './engine/paymentStateMachine';
import { voiceService } from './engine/voiceService';
import { API_BASE_URL } from './config';

export function formatTranscriptText(messages, phoneNumber) {
  const lines = [
    '=== SendAm Chat Transcript ===',
    `Phone Number: ${phoneNumber || 'Unknown'}`,
    `Exported At: ${new Date().toISOString()}`,
    `Total Messages: ${messages.length}`,
    '==============================',
    '',
  ];
  messages.forEach((msg) => {
    const time = msg.timestamp || msg.createdAt || new Date().toISOString();
    const sender = msg.sender === 'user' ? 'User' : 'SendAm';
    lines.push(`[${time}] [${sender}]: ${msg.text}`);
  });
  return lines.join('\n');
}

export function formatTranscriptJson(messages, phoneNumber) {
  const data = {
    phoneNumber: phoneNumber || null,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      text: m.text,
      timestamp: m.timestamp || m.createdAt || new Date().toISOString(),
    })),
  };
  return JSON.stringify(data, null, 2);
}

export function triggerDownload(content, filename, mimeType) {
  if (typeof document !== 'undefined' && document.createElement) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }
  return false;
}

function TypingIndicator() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    function createAnimation(value, delay) {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0, duration: 300, useNativeDriver: true }),
        ])
      );
    }

    const a1 = createAnimation(dot1, 0);
    const a2 = createAnimation(dot2, 150);
    const a3 = createAnimation(dot3, 300);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  const dotStyle = {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#6b7280',
    marginHorizontal: 2,
  };

  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      <Text className="text-sm text-gray-500">SendAm is typing</Text>
      <View className="flex-row items-center">
        <Animated.View style={[dotStyle, { opacity: dot1 }]} />
        <Animated.View style={[dotStyle, { opacity: dot2 }]} />
        <Animated.View style={[dotStyle, { opacity: dot3 }]} />
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const [phoneNumber, setPhoneNumber] = useState(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const inputRef = useRef(null);
  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(60);
  const [screenHeight, setScreenHeight] = useState(600);
  const restoreInputFocus = useRef(false);
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceSynthesizeEnabled, setVoiceSynthesizeEnabled] = useState(true);
  const [devModeOpen, setDevModeOpen] = useState(false);
  const [disabledReplies, setDisabledReplies] = useState({});
  const [replyTo, setReplyTo] = useState(null);

  // Initialize deterministic Payment State Machine engine
  const stateMachine = useMemo(() => new PaymentStateMachine(), []);
  const [machineSnapshot, setMachineSnapshot] = useState({
    state: stateMachine.getState(),
    context: stateMachine.getContext(),
    history: stateMachine.getHistory(),
  });

  const latestBotMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender === 'bot') return messages[i];
    }
    return null;
  }, [messages]);

  const latestQuickReplies = useMemo(() => {
    return latestBotMessage ? parseQuickReplies(latestBotMessage) : [];
  }, [latestBotMessage]);

  useEffect(() => {
    const unsubscribe = stateMachine.subscribe(
      ({ state, context, history }) => {
        setMachineSnapshot({ state, context, history });
      }
    );
    return () => unsubscribe();
  }, [stateMachine]);

  usePolling(phoneNumber, setMessages);

  useLayoutEffect(() => {
    if (!emojiPickerOpen && restoreInputFocus.current) {
      restoreInputFocus.current = false;
      inputRef.current?.focus();
    }
  }, [emojiPickerOpen, inputText]);

  function closeEmojiPicker() {
    restoreInputFocus.current = true;
    setEmojiPickerOpen(false);
  }

  function insertEmoji(emoji) {
    if (sending) return;
    // TextInput selection offsets and JS string slices both use UTF-16 units,
    // so multi-code-unit flags advance the caret by their full string length.
    const start = Math.min(inputSelection.start, inputText.length);
    const end = Math.min(inputSelection.end, inputText.length);
    setInputText(inputText.slice(0, start) + emoji + inputText.slice(end));
    setInputSelection({ start: start + emoji.length, end: start + emoji.length });
    closeEmojiPicker();
  }

  function handleStart() {
    const trimmed = phoneInput.trim();
    if (!trimmed) return;
    setPhoneNumber(trimmed);
  }

  function handleReset() {
    setPhoneNumber(null);
    setPhoneInput('');
    setMessages([]);
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setEmojiPickerOpen(false);
    setSending(false);
    setIsListening(false);
    setDisabledReplies({});
    setReplyTo(null);
  }

  function handleQuickReply(payload, messageId) {
    if (sending || (messageId && disabledReplies[messageId])) return;
    if (messageId) {
      setDisabledReplies((prev) => ({ ...prev, [messageId]: payload }));
    }
    handleSend(payload);
  }

  function appendBotReplies(replies) {
    const now = new Date().toISOString();
    const newMsgs = replies.map((reply, index) => ({
      id: `b-${Date.now()}-${index}`,
      text: reply,
      sender: 'bot',
      timestamp: now,
    }));
    setMessages((prev) => [...prev, ...newMsgs]);

    if (voiceSynthesizeEnabled && replies.length > 0) {
      voiceService.speak(replies.join('. '));
    }
  }

  async function handleVoiceInput() {
    if (!voiceService.isSpeechRecognitionSupported()) {
      alert('Speech recognition is not available in your browser.');
      return;
    }

    if (isListening) {
      voiceService.stopListening();
      setIsListening(false);
      return;
    }

    setIsListening(true);
    stateMachine.transition(PaymentEvent.START_VOICE_COMMAND);

    try {
      const transcript = await voiceService.startListening();
      setIsListening(false);

      if (!transcript) {
        stateMachine.transition(PaymentEvent.PARSE_FAILED, {
          error: 'No speech detected',
        });
        return;
      }

      setInputText(transcript);
      setInputSelection({ start: transcript.length, end: transcript.length });

      const parsed = stateMachine.parsePaymentIntent(transcript);
      if (parsed) {
        stateMachine.transition(PaymentEvent.VOICE_PARSED, { intent: parsed });
      } else {
        stateMachine.transition(PaymentEvent.PARSE_FAILED, {
          error: 'Unrecognized intent',
        });
      }
    } catch (err) {
      setIsListening(false);
      stateMachine.transition(PaymentEvent.PARSE_FAILED, {
        error: err.message,
      });
    }
  }

  async function handleSend(customText) {
    const text = (customText !== undefined ? customText : inputText).trim();
    if (!text || sending) return;

    const quotedReply = replyTo
      ? { id: replyTo.id, text: replyTo.text, sender: replyTo.sender }
      : null;

    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        text,
        sender: 'user',
        timestamp: new Date().toISOString(),
        ...(quotedReply ? { replyTo: quotedReply } : {}),
      },
    ]);
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setEmojiPickerOpen(false);
    setReplyTo(null);
    setSending(true);

    // If current state machine is awaiting PIN and user enters a 4-6 digit PIN
    if (
      machineSnapshot.state === PaymentState.AWAITING_PIN ||
      machineSnapshot.state === PaymentState.RATE_QUOTED
    ) {
      if (/^\d{4,6}$/.test(text)) {
        stateMachine.transition(PaymentEvent.PIN_VALIDATED);
        // Simulate immediate stellar settlement progression
        setTimeout(() => {
          stateMachine.transition(PaymentEvent.STELLAR_SUCCESS, {
            txHash: `0x${Date.now().toString(16)}`,
          });
        }, 800);
      }
    } else if (machineSnapshot.state === PaymentState.IDLE) {
      const parsed = stateMachine.parsePaymentIntent(text);
      if (parsed) {
        stateMachine.transition(PaymentEvent.START_VOICE_COMMAND);
        stateMachine.transition(PaymentEvent.VOICE_PARSED, { intent: parsed });
      }
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/sim/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, text }),
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const data = await response.json();
      const replies = data.replies ?? [];
      appendBotReplies(replies);
    } catch (error) {
      const errorReply = `Couldn't reach SendAm: ${error.message}`;
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, text: errorReply, sender: 'bot', timestamp: new Date().toISOString() },
      ]);
      if (voiceSynthesizeEnabled) {
        voiceService.speak(errorReply);
      }
    } finally {
      setSending(false);
    }
  }

  function handleExportTxt() {
    const content = formatTranscriptText(messages, phoneNumber);
    const cleanPhone = (phoneNumber || 'session').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `transcript_${cleanPhone}_${Date.now()}.txt`;
    triggerDownload(content, filename, 'text/plain');
  }

  function handleExportJson() {
    const content = formatTranscriptJson(messages, phoneNumber);
    const cleanPhone = (phoneNumber || 'session').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `transcript_${cleanPhone}_${Date.now()}.json`;
    triggerDownload(content, filename, 'application/json');
  }

  function handleRollback(index) {
    try {
      stateMachine.rollback(index);
    } catch (err) {
      console.warn('Rollback failed:', err);
    }
  }

  if (!phoneNumber) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6 gap-3">
        <Text className="text-lg font-semibold text-gray-900">
          Enter your phone number
        </Text>
        <TextInput
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base"
          placeholder="+2348000000001"
          keyboardType="phone-pad"
          value={phoneInput}
          onChangeText={setPhoneInput}
          onSubmitEditing={handleStart}
        />
        <Pressable
          className="w-full bg-green-500 rounded-lg py-2 items-center"
          onPress={handleStart}
          disabled={!phoneInput.trim()}
        >
          <Text className="text-white font-semibold">Start chatting</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-white"
      onLayout={({ nativeEvent }) => setScreenHeight(nativeEvent.layout.height)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="flex-row items-center justify-between px-3 py-2 border-b border-gray-200">
        <Text className="text-base font-semibold text-gray-900">{phoneNumber}</Text>
        <View className="flex-row items-center gap-2">
          <Pressable
            testID="export-transcript-button"
            className="border border-emerald-500 bg-emerald-50 rounded-lg px-2.5 py-1"
            onPress={handleExportTxt}
          >
            <Text className="text-xs font-semibold text-emerald-700">Export .txt</Text>
          </Pressable>
          <Pressable
            testID="export-transcript-json-button"
            className="border border-emerald-500 bg-emerald-50 rounded-lg px-2.5 py-1"
            onPress={handleExportJson}
          >
            <Text className="text-xs font-semibold text-emerald-700">Export .json</Text>
          </Pressable>
          <Pressable
            testID="reset-session-button"
            className="border border-gray-300 rounded-lg px-3 py-1"
            onPress={handleReset}
          >
            <Text className="text-sm font-semibold text-gray-700">Switch Account</Text>
          </Pressable>
        </View>
      </View>

      {/* Dev Mode / State Machine Inspector Toolbar */}
      <View className="bg-gray-100 border-b border-gray-200 px-3 py-2 flex-row justify-between items-center">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs font-bold text-gray-700">ENGINE STATE:</Text>
          <Text
            className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800"
            testID="engine-state-badge"
          >
            {machineSnapshot.state}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Pressable
            testID="toggle-voice-synth"
            onPress={() => setVoiceSynthesizeEnabled((prev) => !prev)}
            className={`px-2 py-1 rounded text-xs ${voiceSynthesizeEnabled ? 'bg-emerald-100' : 'bg-gray-200'}`}
          >
            <Text className="text-xs font-medium text-gray-800">
              {voiceSynthesizeEnabled
                ? 'Voice TTS: ON'
                : 'Voice TTS: OFF'}
            </Text>
          </Pressable>
          <Pressable
            testID="toggle-dev-inspector"
            onPress={() => setDevModeOpen((prev) => !prev)}
            className="px-2 py-1 bg-indigo-600 rounded"
          >
            <Text className="text-xs font-medium text-white">
              {devModeOpen ? 'Hide Inspector' : 'Inspector'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Dev Inspector Drawer */}
      {devModeOpen && (
        <View
          className="bg-slate-900 text-slate-100 p-3 border-b border-slate-700 max-h-48"
          testID="dev-inspector"
        >
          <Text className="text-xs font-bold text-slate-300 mb-1">
            State Machine Context & Timeline:
          </Text>
          <Text className="text-xs text-emerald-400 font-mono mb-2">
            {JSON.stringify(machineSnapshot.context)}
          </Text>
          <Text className="text-xs font-semibold text-slate-400 mb-1">
            Timeline Snapshots (click to rollback):
          </Text>
          <ScrollView horizontal className="flex-row gap-2 py-1">
            {machineSnapshot.history.map((snapshot) => (
              <Pressable
                key={snapshot.index}
                testID={`rollback-btn-${snapshot.index}`}
                onPress={() => handleRollback(snapshot.index)}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 mr-2"
              >
                <Text className="text-xs text-slate-200">
                  #{snapshot.index}: {snapshot.action} ({snapshot.state})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      <View className="flex-1">
        <MessageList
          messages={messages}
          onQuickReply={handleQuickReply}
          disabledReplies={disabledReplies}
          sending={sending}
          onReply={setReplyTo}
        />
      </View>
      {sending ? <TypingIndicator /> : null}

      {/* WhatsApp interactive quick-reply suggestions bar above input */}
      {latestQuickReplies.length > 0 && !disabledReplies[latestBotMessage?.id] && (
        <View
          testID="quick-replies-bottom-bar"
          className="flex-row flex-wrap gap-2 px-3 py-2 bg-emerald-50/70 border-t border-emerald-100"
        >
          {latestQuickReplies.map((reply, idx) => (
            <Pressable
              key={reply.id || idx}
              testID={`bottom-quick-reply-${idx}`}
              disabled={sending || Boolean(disabledReplies[latestBotMessage?.id])}
              onPress={() => handleQuickReply(reply.payload, latestBotMessage?.id)}
              className="bg-white border border-emerald-500 rounded-full px-3 py-1 shadow-sm active:bg-emerald-50"
            >
              <Text className="text-xs font-semibold text-emerald-700">
                {reply.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {replyTo && (
        <View
          testID="reply-banner"
          className="flex-row items-center gap-2 px-3 py-2 bg-gray-50 border-t border-gray-200"
        >
          <View className="h-8 w-1 rounded bg-green-500" />
          <View className="flex-1">
            <Text className="text-xs font-semibold text-green-600">
              Replying to {replyTo.sender === 'user' ? 'yourself' : 'SendAm'}
            </Text>
            <Text className="text-sm text-gray-700" numberOfLines={1}>
              {replyTo.text}
            </Text>
          </View>
          <Pressable
            testID="cancel-reply"
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            onPress={() => setReplyTo(null)}
            className="p-2"
          >
            <Text className="text-base font-bold text-gray-500">✕</Text>
          </Pressable>
        </View>
      )}

      {emojiPickerOpen && (
        <Pressable testID="emoji-picker-backdrop" accessibilityRole="button" accessibilityLabel="Dismiss emoji picker"
          onPress={closeEmojiPicker} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 1 }} />
      )}
      {emojiPickerOpen && (
        <EmojiPicker onSelect={insertEmoji} onClose={closeEmojiPicker} bottom={composerHeight}
          maxHeight={Math.min(340, Math.max(120, screenHeight - composerHeight - 16))} />
      )}
      <View className="flex-row items-center gap-2 px-3 py-2 border-t border-gray-200 bg-white"
        style={{ zIndex: 2 }} onLayout={({ nativeEvent }) => setComposerHeight(nativeEvent.layout.height)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Choose emoji"
          accessibilityState={{ expanded: emojiPickerOpen, disabled: sending }}
          disabled={sending} onPress={() => emojiPickerOpen ? closeEmojiPicker() : setEmojiPickerOpen(true)}
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 24 }}>☺</Text>
        </Pressable>
        <Pressable
          testID="mic-button"
          className={`rounded-full p-2 items-center justify-center ${isListening ? 'bg-red-500' : 'bg-gray-200'}`}
          onPress={handleVoiceInput}
        >
          <Text className="text-xs font-bold">{isListening ? 'REC...' : 'MIC'}</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          style={{ minWidth: 0 }}
          className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-base"
          placeholder="Type a message or use speech"
          value={inputText}
          onChangeText={setInputText}
          selection={inputSelection}
          onSelectionChange={({ nativeEvent }) => setInputSelection(nativeEvent.selection)}
          onSubmitEditing={() => handleSend()}
          editable={!sending}
        />
        <Pressable
          testID="send-button"
          className="bg-green-500 rounded-full px-4 py-2 items-center justify-center"
          onPress={() => handleSend()}
          disabled={sending || !inputText.trim()}
        >
          <Text className="text-white font-semibold">
            {sending ? '...' : 'Send'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
