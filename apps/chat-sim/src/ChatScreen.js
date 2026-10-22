import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from '@ttsalpha/qrcode';
import {
  Animated,
  Alert,
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
import { buildSep7PaymentUri, isValidSep7Uri, normalizeSep7Uri } from './paymentRequest';

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
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef(null);
  const [disabledReplies, setDisabledReplies] = useState({});
  const [networkProfile, setNetworkProfile] = useState(NETWORK_PROFILES[0]);
  const [networkDropdownOpen, setNetworkDropdownOpen] = useState(false);
  const [qrModalVisible, setQrModalVisible] = useState(false);
  const [paymentLink, setPaymentLink] = useState('');
  const [qrError, setQrError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [captionText, setCaptionText] = useState('');
  const photoInputRef = useRef(null);
  const docInputRef = useRef(null);
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
    setAttachmentMenuOpen(false);
    setPreviewAttachment(null);
    setCaptionText('');
  }

  function handleFileSelect(event, type) {
    const file = event.target?.files?.[0];
    if (!file) return;

    const attachmentObj = {
      type, // 'photo' or 'document'
      name: file.name || (type === 'photo' ? 'photo.jpg' : 'document.pdf'),
      size: file.size ? `${(file.size / 1024).toFixed(1)} KB` : '',
    };

    if (type === 'photo') {
      if (typeof FileReader !== 'undefined') {
        const reader = new FileReader();
        reader.onload = (e) => {
          setPreviewAttachment({
            ...attachmentObj,
            uri: e.target?.result,
          });
          setAttachmentMenuOpen(false);
        };
        reader.readAsDataURL(file);
      } else {
        setPreviewAttachment({
          ...attachmentObj,
          uri: file.uri || 'data:image/jpeg;base64,mock',
        });
        setAttachmentMenuOpen(false);
      }
    } else {
      setPreviewAttachment({
        ...attachmentObj,
        uri: null,
      });
      setAttachmentMenuOpen(false);
    }
  }

  function handleClearAttachment() {
    setPreviewAttachment(null);
    setCaptionText('');
    if (photoInputRef.current) photoInputRef.current.value = '';
    if (docInputRef.current) docInputRef.current.value = '';
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

  function startVoiceRecording() {
    if (sending) return;
    setIsRecording(true);
    setRecordSeconds(0);
    clearInterval(recordTimerRef.current);
    recordTimerRef.current = setInterval(() => {
      setRecordSeconds((sec) => sec + 1);
    }, 1000);
  }

  function stopVoiceRecordingAndSend() {
    if (!isRecording) return;
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    const duration = recordSeconds || 1;
    setRecordSeconds(0);

    const voiceId = `v-${Date.now()}`;
    const formatted = `0:${duration < 10 ? '0' : ''}${duration}`;
    const voiceMsg = {
      id: voiceId,
      sender: 'user',
      type: 'voice',
      isVoice: true,
      duration,
      text: `🎤 Voice note (${formatted})`,
    };

    setMessages((prev) => [...prev, voiceMsg]);

    // Send Nigerian Pidgin / English voice intent to SendAm bot
    const sampleVoiceIntents = [
      'Abeg send 5000 Naira to +2348000000002',
      'Send 10 USDC to +2348000000003',
      'Pay 2500 NGN to +2348000000004 for fuel',
    ];
    const transcript = sampleVoiceIntents[messages.length % sampleVoiceIntents.length];
    handleSend(transcript, true);
  }

  function cancelVoiceRecording() {
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    setRecordSeconds(0);
  }

  async function handleSend(customText, skipUserBubble = false) {
    const text = (customText !== undefined ? customText : inputText).trim();
    if (!text || sending) return;

    if (!skipUserBubble) {
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, text, sender: 'user' },
      ]);
    }
  async function handleSend(customText) {
    const attachment = previewAttachment;
    const text = (
      customText !== undefined
        ? customText
        : attachment
        ? captionText
        : inputText
    ).trim();

    if ((!text && !attachment) || sending) return;

    const userMessageText = text || (attachment ? (attachment.type === 'photo' ? 'Photo' : attachment.name) : '');

    const quotedReply = replyTo
      ? { id: replyTo.id, text: replyTo.text, sender: replyTo.sender }
      : null;

    setMessages((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        text: text,
        attachment: attachment || undefined,
        sender: 'user',
        timestamp: new Date().toISOString(),
      },
    ]);

    if (attachment) {
      handleClearAttachment();
    } else {
      setInputText('');
    }
        text,
        sender: 'user',
        timestamp: new Date().toISOString(),
        ...(quotedReply ? { replyTo: quotedReply } : {}),
      },
    ]);
    setInputText('');
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
      if (networkProfile.offline) {
        throw new Error('Network error: Device is offline');
      }

      if (networkProfile.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, networkProfile.delayMs));
      }

      const response = await fetch(`${API_BASE_URL}/api/sim/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, text: userMessageText }),
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

  function handleOpenQrModal() {
    const context = machineSnapshot.context;
    const generatedUri = buildSep7PaymentUri({
      destination: context.recipient,
      amount: context.amount,
      asset: context.asset,
    });
    if (generatedUri) setPaymentLink(generatedUri);
    setQrError('');
    setCopyStatus('');
    setQrModalVisible(true);
  }

  function handlePaymentLinkChange(value) {
    setPaymentLink(value);
    setQrError('');
    setCopyStatus('');
  }

  async function handleCopyPaymentLink() {
    const uri = normalizeSep7Uri(paymentLink);
    if (!uri) {
      setQrError('Enter a valid SEP-0007 web+stellar payment or transaction URI first.');
      return;
    }

    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(uri);
        setCopyStatus('Payment link copied to clipboard.');
        setQrError('');
      } catch {
        setQrError('Clipboard access was blocked. Select the link below and copy it manually.');
      }
      return;
    }

    setCopyStatus('Long-press the link below to copy it on this device.');
    Alert.alert('Copy payment link', 'Long-press the payment link below to select and copy it.');
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

      <View className="flex-row items-center justify-end px-3 py-2 border-t border-gray-200 bg-emerald-50">
        <Pressable
          testID="show-qr-code-button"
          className="rounded-lg border border-emerald-600 bg-white px-3 py-2"
          onPress={handleOpenQrModal}
        >
          <Text className="text-sm font-semibold text-emerald-700">Show QR Code</Text>
        </Pressable>
      </View>
      {/* Hidden file inputs for web/mobile browsers */}
      {typeof document !== 'undefined' && (
        <View style={{ display: 'none' }}>
          <input
            type="file"
            ref={photoInputRef}
            accept="image/*"
            data-testid="photo-file-input"
            onChange={(e) => handleFileSelect(e, 'photo')}
          />
          <input
            type="file"
            ref={docInputRef}
            accept=".pdf,.doc,.docx,.txt"
            data-testid="doc-file-input"
            onChange={(e) => handleFileSelect(e, 'document')}
          />
        </View>
      )}

      {/* Inline Media Preview Bubble above input */}
      {previewAttachment && (
        <View
          testID="attachment-preview-bubble"
          className="mx-3 mb-2 p-3 bg-gray-50 border border-emerald-300 rounded-xl shadow-sm gap-2"
        >
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm font-bold text-gray-800">
                {previewAttachment.type === 'photo' ? '📷 Photo Preview' : '📄 Document'}
              </Text>
              <Text className="text-xs text-gray-500">
                {previewAttachment.name} {previewAttachment.size ? `(${previewAttachment.size})` : ''}
              </Text>
            </View>
            <Pressable
              testID="cancel-attachment-button"
              onPress={handleClearAttachment}
              className="p-1 rounded-full bg-gray-200"
            >
              <Text className="text-xs font-bold text-gray-600 px-1">✕</Text>
            </Pressable>
          </View>

          {previewAttachment.type === 'photo' && previewAttachment.uri ? (
            <View className="rounded-lg overflow-hidden border border-gray-200 max-h-48 bg-black/5 items-center justify-center">
              <img
                src={previewAttachment.uri}
                alt="Selected preview"
                data-testid="preview-thumbnail-img"
                style={{ maxHeight: 180, maxWidth: '100%', objectFit: 'contain' }}
              />
            </View>
          ) : (
            <View className="p-3 bg-white rounded border border-gray-200 flex-row items-center gap-3">
              <Text className="text-2xl">📄</Text>
              <View>
                <Text className="text-sm font-semibold text-gray-800">{previewAttachment.name}</Text>
                {previewAttachment.size ? (
                  <Text className="text-xs text-gray-500">{previewAttachment.size}</Text>
                ) : null}
              </View>
            </View>
          )}

          {/* Caption input */}
          <TextInput
            testID="attachment-caption-input"
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white"
            placeholder="Add a caption..."
            value={captionText}
            onChangeText={setCaptionText}
            editable={!sending}
            onSubmitEditing={() => handleSend()}
          />
        </View>
      )}

      {/* Paperclip Attachment Popup Menu */}
      {attachmentMenuOpen && (
        <View
          testID="attachment-menu"
          className="mx-3 mb-2 p-2 bg-white rounded-xl border border-gray-200 shadow-md flex-row gap-3"
        >
          <Pressable
            testID="attach-photo-button"
            className="flex-row items-center gap-2 p-2 rounded-lg bg-emerald-50 active:bg-emerald-100 flex-1 justify-center"
            onPress={() => {
              if (photoInputRef.current) {
                photoInputRef.current.click();
              } else {
                // Fallback for tests or non-DOM
                handleFileSelect(
                  { target: { files: [{ name: 'sample-id.jpg', size: 102400, type: 'image/jpeg' }] } },
                  'photo'
                );
              }
            }}
          >
            <Text className="text-base">📷</Text>
            <Text className="text-xs font-semibold text-emerald-800">Photo</Text>
          </Pressable>
          <Pressable
            testID="attach-doc-button"
            className="flex-row items-center gap-2 p-2 rounded-lg bg-blue-50 active:bg-blue-100 flex-1 justify-center"
            onPress={() => {
              if (docInputRef.current) {
                docInputRef.current.click();
              } else {
                // Fallback for tests or non-DOM
                handleFileSelect(
                  { target: { files: [{ name: 'receipt.pdf', size: 204800, type: 'application/pdf' }] } },
                  'document'
                );
              }
            }}
          >
            <Text className="text-base">📄</Text>
            <Text className="text-xs font-semibold text-blue-800">Document</Text>
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

      <View className="flex-row items-center gap-2 px-3 py-2 border-t border-gray-200">
        {isRecording ? (
          <View
            className="flex-1 flex-row items-center justify-between bg-red-50 border border-red-200 rounded-full px-4 py-2"
            testID="audio-recording-bar"
          >
            <View className="flex-row items-center gap-2">
              <View className="w-2.5 h-2.5 rounded-full bg-red-600" />
              <Text className="text-sm font-semibold text-red-600 font-mono" testID="recording-timer">
                0:{recordSeconds < 10 ? '0' : ''}{recordSeconds}
              </Text>
            </View>

            <View className="flex-row items-center gap-1">
              {[8, 16, 22, 12, 20, 14, 24, 10, 18].map((h, i) => (
                <View
                  key={i}
                  style={{ height: recordSeconds % 2 === 0 ? h : h * 0.7 }}
                  className="w-1 bg-red-500 rounded-full"
                />
              ))}
            </View>

            <Pressable onPress={cancelVoiceRecording} testID="cancel-recording-button">
              <Text className="text-xs font-semibold text-gray-500">Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <TextInput
              className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-base"
              placeholder="Type a message or hold mic"
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={() => handleSend()}
              editable={!sending}
            />
            {inputText.trim() ? (
              <Pressable
                testID="send-button"
                className="bg-green-500 rounded-full px-4 py-2 items-center justify-center"
                onPress={() => handleSend()}
                disabled={sending}
              >
                <Text className="text-white font-semibold">
                  {sending ? '...' : 'Send'}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}

        <Pressable
          testID="paperclip-button"
          className={`rounded-full p-2 items-center justify-center ${attachmentMenuOpen ? 'bg-emerald-200' : 'bg-gray-100'}`}
          onPress={() => setAttachmentMenuOpen((prev) => !prev)}
        >
          <Text className="text-sm">📎</Text>
        </Pressable>
        <Pressable
          testID="mic-button"
          className={`rounded-full p-2.5 items-center justify-center ${
            isRecording
              ? 'bg-red-600'
              : isListening
              ? 'bg-amber-500'
              : 'bg-green-500'
          }`}
          onPressIn={startVoiceRecording}
          onPressOut={stopVoiceRecordingAndSend}
          onPress={() => {
            if (isRecording) {
              stopVoiceRecordingAndSend();
            } else {
              startVoiceRecording();
            }
          }}
          className={`rounded-full p-2 items-center justify-center ${isListening ? 'bg-red-500' : 'bg-gray-200'}`}
          onPress={handleVoiceInput}
        >
          <Text className="text-xs font-bold">{isListening ? 'REC...' : 'MIC'}</Text>
        </Pressable>
        <TextInput
          className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-base"
          placeholder={previewAttachment ? 'Caption or press Send...' : 'Type a message or use speech'}
          value={previewAttachment ? captionText : inputText}
          onChangeText={previewAttachment ? setCaptionText : setInputText}
          onSubmitEditing={() => handleSend()}
          editable={!sending}
        />
        <Pressable
          testID="send-button"
          className="bg-green-500 rounded-full px-4 py-2 items-center justify-center"
          onPress={() => handleSend()}
          disabled={sending || (!inputText.trim() && !previewAttachment && !captionText.trim())}
        >
          <Text className="text-xs font-bold text-white">
            {isRecording ? 'REC' : 'MIC'}
          </Text>
        </Pressable>
      </View>

      <Modal
        visible={qrModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setQrModalVisible(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/50 px-4">
          <View className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <Text className="text-lg font-bold text-gray-900">Payment request QR code</Text>
            <Text className="mt-1 text-sm text-gray-600">
              Paste a SEP-0007 web+stellar URI. The QR encodes the link only; it does not submit a payment.
            </Text>
            <TextInput
              testID="payment-link-input"
              className="mt-4 min-h-20 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
              placeholder="web+stellar:pay?destination=...&amount=..."
              value={paymentLink}
              onChangeText={handlePaymentLinkChange}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
            />
            {qrError ? (
              <Text testID="qr-error" accessibilityRole="alert" className="mt-2 text-sm text-red-600">
                {qrError}
              </Text>
            ) : null}
            {isValidSep7Uri(paymentLink) ? (
              Platform.OS === 'web' ? (
                <View testID="payment-qr-code" className="mt-4 items-center rounded-lg bg-white p-3">
                  <QRCode value={normalizeSep7Uri(paymentLink)} size={240} ariaLabel="SEP-0007 payment request QR code" />
                </View>
              ) : (
                <Text className="mt-3 text-sm text-gray-600">
                  Open the chat simulator in a web browser to display the scannable SVG QR code.
                </Text>
              )
            ) : (
              <Text className="mt-3 text-sm text-gray-500">
                A QR code appears here when the URI includes a valid pay destination or transaction XDR.
              </Text>
            )}
            <Text
              testID="payment-link-preview"
              selectable
              className="mt-3 text-xs text-gray-600"
            >
              {normalizeSep7Uri(paymentLink)}
            </Text>
            {copyStatus ? (
              <Text accessibilityLiveRegion="polite" className="mt-2 text-sm text-emerald-700">{copyStatus}</Text>
            ) : null}
            <View className="mt-4 flex-row gap-2">
              <Pressable
                testID="copy-payment-link-button"
                className="flex-1 items-center rounded-lg bg-emerald-600 px-3 py-2"
                onPress={handleCopyPaymentLink}
              >
                <Text className="font-semibold text-white">Copy Payment Link</Text>
              </Pressable>
              <Pressable
                testID="close-qr-modal-button"
                className="items-center rounded-lg border border-gray-300 px-3 py-2"
                onPress={() => setQrModalVisible(false)}
              >
                <Text className="font-semibold text-gray-700">Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
