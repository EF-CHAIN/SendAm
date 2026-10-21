import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import MessageList, { parseQuickReplies } from './MessageList';
import usePolling from './usePolling';
import {
  PaymentStateMachine,
  PaymentState,
  PaymentEvent,
} from './engine/paymentStateMachine';
import { voiceService } from './engine/voiceService';
import { API_BASE_URL } from './config';

export const NETWORK_PROFILES = [
  { id: 'no-throttling', label: 'No Throttling (0ms)', delayMs: 0, offline: false, badgeLabel: 'Online', badgeColor: 'bg-emerald-100 text-emerald-800' },
  { id: 'fast-3g', label: 'Fast 3G (500ms)', delayMs: 500, offline: false, badgeLabel: 'Fast 3G', badgeColor: 'bg-blue-100 text-blue-800' },
  { id: 'slow-3g', label: 'Slow 3G (2000ms)', delayMs: 2000, offline: false, badgeLabel: 'Slow 3G', badgeColor: 'bg-amber-100 text-amber-800' },
  { id: 'offline', label: 'Offline (Error)', delayMs: 0, offline: true, badgeLabel: 'Offline', badgeColor: 'bg-red-100 text-red-800' },
];

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
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceSynthesizeEnabled, setVoiceSynthesizeEnabled] = useState(true);
  const [devModeOpen, setDevModeOpen] = useState(false);
  const [disabledReplies, setDisabledReplies] = useState({});
  const [networkProfile, setNetworkProfile] = useState(NETWORK_PROFILES[0]);
  const [networkDropdownOpen, setNetworkDropdownOpen] = useState(false);

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
    setSending(false);
    setIsListening(false);
    setDisabledReplies({});
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

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, text, sender: 'user', timestamp: new Date().toISOString() },
    ]);
    setInputText('');
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
      if (networkProfile.offline) {
        throw new Error('Network error: Device is offline');
      }

      if (networkProfile.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, networkProfile.delayMs));
      }

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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="flex-row items-center justify-between px-3 py-2 border-b border-gray-200">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-semibold text-gray-900">{phoneNumber}</Text>
          <View
            testID="connection-status-badge"
            className={`px-2 py-0.5 rounded-full ${networkProfile.badgeColor}`}
          >
            <Text className="text-xs font-semibold">{networkProfile.badgeLabel}</Text>
          </View>
        </View>
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
          {/* Network Latency Selector Dropdown */}
          <Pressable
            testID="network-simulator-dropdown-trigger"
            onPress={() => setNetworkDropdownOpen((prev) => !prev)}
            className="px-2 py-1 bg-white border border-gray-300 rounded flex-row items-center gap-1"
          >
            <Text className="text-xs font-medium text-gray-800" testID="network-selected-label">
              {networkProfile.label}
            </Text>
            <Text className="text-xs text-gray-500">▼</Text>
          </Pressable>

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

      {/* Network Profile Dropdown Menu */}
      {networkDropdownOpen && (
        <View
          testID="network-simulator-menu"
          className="bg-white border-b border-gray-200 px-3 py-2 flex-row flex-wrap gap-2"
        >
          {NETWORK_PROFILES.map((profile) => (
            <Pressable
              key={profile.id}
              testID={`network-profile-option-${profile.id}`}
              onPress={() => {
                setNetworkProfile(profile);
                setNetworkDropdownOpen(false);
              }}
              className={`px-3 py-1.5 rounded-lg border ${
                networkProfile.id === profile.id
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <Text
                className={`text-xs ${
                  networkProfile.id === profile.id
                    ? 'font-bold text-indigo-700'
                    : 'text-gray-700'
                }`}
              >
                {profile.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

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

      <View className="flex-row items-center gap-2 px-3 py-2 border-t border-gray-200">
        <Pressable
          testID="mic-button"
          className={`rounded-full p-2 items-center justify-center ${isListening ? 'bg-red-500' : 'bg-gray-200'}`}
          onPress={handleVoiceInput}
        >
          <Text className="text-xs font-bold">{isListening ? 'REC...' : 'MIC'}</Text>
        </Pressable>
        <TextInput
          className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-base"
          placeholder="Type a message or use speech"
          value={inputText}
          onChangeText={setInputText}
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
