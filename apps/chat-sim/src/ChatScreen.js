import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import QRCode from '@ttsalpha/qrcode';
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import MessageList, {
  findMessageMatches,
  parseListMessage,
  parseQuickReplies,
} from './MessageList';
import EmojiPicker from './EmojiPicker';
import usePolling from './usePolling';
import {
  PaymentStateMachine,
  PaymentState,
  PaymentEvent,
} from './engine/paymentStateMachine';
import { voiceService } from './engine/voiceService';
import { API_BASE_URL } from './config';
import { buildSep7PaymentUri, isValidSep7Uri, normalizeSep7Uri } from './paymentRequest';
import { WHATSAPP_THEMES } from './theme';

export const NETWORK_PROFILES = [
  { id: 'no-throttling', label: 'No Throttling (0ms)', delayMs: 0, offline: false, badgeLabel: 'Online', badgeColor: 'bg-emerald-100 text-emerald-800' },
  { id: 'fast-3g', label: 'Fast 3G (500ms)', delayMs: 500, offline: false, badgeLabel: 'Fast 3G', badgeColor: 'bg-blue-100 text-blue-800' },
  { id: 'slow-3g', label: 'Slow 3G (2000ms)', delayMs: 2000, offline: false, badgeLabel: 'Slow 3G', badgeColor: 'bg-amber-100 text-amber-800' },
  { id: 'offline', label: 'Offline (Error)', delayMs: 0, offline: true, badgeLabel: 'Offline', badgeColor: 'bg-red-100 text-red-800' },
];

export { WHATSAPP_THEMES };

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

const SYNTHETIC_WEBHOOK_EVENTS = [
  {
    id: 'kyc_approved',
    title: 'Simulate KYC Approved Notification',
    badge: 'KYC / Tier 2',
    description: 'Simulates Dojah / SmileID identity verification callback promoting account to Tier 2 limits.',
    botMessage: '🔔 [Webhook: KYC_APPROVED] Identity verified successfully! Tier 2 daily limits ($1,000.00) are now active on your wallet.',
  },
  {
    id: 'user_blocked',
    title: 'Simulate User Blocked Bot',
    badge: 'WhatsApp Status',
    description: 'Simulates Meta Cloud API status callback where recipient opted out or blocked phone.',
    botMessage: '⚠️ [Webhook: USER_BLOCKED] WhatsApp webhook status: User blocked the bot or opted out of messages.',
  },
  {
    id: 'receipt_failed',
    title: 'Simulate Payment Receipt Failed',
    badge: 'Payment Delivery',
    description: 'Simulates delivery failure status webhook from WhatsApp delivery infrastructure.',
    botMessage: '❌ [Webhook: RECEIPT_DELIVERY_FAILED] Delivery failed for payment receipt to recipient. Reason: Destination phone unreachable.',
  },
  {
    id: 'inbound_payment',
    title: 'Simulate Inbound Payment Received',
    badge: 'Stellar Transfer',
    description: 'Simulates inbound payment webhook detected from Stellar Horizon watcher.',
    botMessage: '💰 [Webhook: INBOUND_PAYMENT] Inbound payment detected on Stellar: Received 50.00 USDC from +2348012345678. Stellar Tx: 9f8a42b1c73e5d0a62489cbe34efa18702b851dc2094ecb819f73240d892bc51.',
  },
  {
    id: 'stellar_confirmed',
    title: 'Simulate Stellar Settlement Confirmed',
    badge: 'Horizon Ledger',
    description: 'Simulates ledger sequence closing confirmation for active transfer.',
    botMessage: '✅ [Webhook: STELLAR_TX_CONFIRMED] Stellar transaction ledger sequence #4829104 confirmed. TxHash: 5a2d71e4b86c91a032ef17c24fbc0951e739a826410db56792f4e1837b049c6d.',
  },
  {
    id: 'compliance_alert',
    title: 'Simulate Compliance AML Flagged',
    badge: 'Compliance Risk',
    description: 'Simulates automated risk score threshold alert requiring operator manual review.',
    botMessage: '🛡️ [Webhook: COMPLIANCE_ALERT] High-risk threshold alert: Transaction flagged by AML rules for administrative review.',
  },
];

const PIPELINE_NODES = [
  PaymentState.IDLE,
  PaymentState.PARSING_VOICE,
  PaymentState.RATE_QUOTED,
  PaymentState.AWAITING_PIN,
  PaymentState.AUTHORIZING,
  PaymentState.SUBMITTING,
  PaymentState.SETTLING_STELLAR,
  PaymentState.RECEIPT_DELIVERED,
  PaymentState.COMPLETED,
  PaymentState.ERROR,
];


export function ChatWallpaper({ darkMode }) {
  const doodleSvg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><g fill="${darkMode ? '%23ffffff' : '%23000000'}" fill-opacity="${darkMode ? '0.04' : '0.03'}"><path d="M25 20c3 0 5 2 5 5s-2 5-5 5-5-2-5-5 2-5 5-5zm80 40c4 0 7 3 7 7s-3 7-7 7-7-3-7-7 3-7 7-7zm80-25c3 0 6 3 6 6s-3 6-6 6-6-3-6-6 3-6 6-6zM45 130c5 0 9 4 9 9s-4 9-9 9-9-4-9-9 4-9 9-9zm140 30c4 0 7 3 7 7s-3 7-7 7-7-3-7-7 3-7 7-7zm-70 40c3 0 6 3 6 6s-3 6-6 6-6-3-6-6 3-6 6-6zM30 210c4 0 8 4 8 8s-4 8-8 8-8-4-8-8 4-8 8-8zm160 10c3 0 5 2 5 5s-2 5-5 5-5-2-5-5 2-5 5-5z"/></g></svg>`;

  return (
    <View
      testID="chat-wallpaper"
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        ...(Platform.OS === 'web'
          ? {
              backgroundImage: `url("${doodleSvg}")`,
              backgroundRepeat: 'repeat',
            }
          : {}),
      }}
    />
  );
}

function TypingIndicator({ darkMode }) {
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
    backgroundColor: darkMode ? '#8696a0' : '#6b7280',
    marginHorizontal: 2,
  };

  return (
    <View testID="typing-indicator" className="flex-row items-center gap-2 px-3 py-2">
      <Text
        style={darkMode ? { color: '#8696a0' } : undefined}
        className="text-sm text-gray-500"
      >
        SendAm is typing
      </Text>
      <View className="flex-row items-center">
        <Animated.View style={[dotStyle, { opacity: dot1 }]} />
        <Animated.View style={[dotStyle, { opacity: dot2 }]} />
        <Animated.View style={[dotStyle, { opacity: dot3 }]} />
      </View>
    </View>
  );
}

export const MessageStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
};

const STATUS_PRIORITY = {
  [MessageStatus.PENDING]: 0,
  [MessageStatus.SENT]: 1,
  [MessageStatus.DELIVERED]: 2,
  [MessageStatus.READ]: 3,
};

export default function ChatScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 768;

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
  const [syntheticDrawerOpen, setSyntheticDrawerOpen] = useState(false);
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef(null);
  const recordedPress = useRef(false);
  const [disabledReplies, setDisabledReplies] = useState({});
  const timersRef = useRef(new Set());

  // Clean up all active timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current.clear();
    };
  }, []);

  // The open WhatsApp list-message drawer: { list, messageId } | null, plus
  // the id of the radio-selected row inside it.
  const [listDrawer, setListDrawer] = useState(null);
  const [listSelectedRowId, setListSelectedRowId] = useState(null);
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
  // In-chat search (#786): the query filters messages, matches highlight in
  // yellow, and Up/Down walk the matched bubbles.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [darkMode, setDarkMode] = useState(false);

  const theme = darkMode ? WHATSAPP_THEMES.dark : WHATSAPP_THEMES.light;

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
    if (!latestBotMessage) return [];
    // A list message opens through its own drawer; its JSON text is not a
    // menu for the quick-reply regex to chew on.
    if (parseListMessage(latestBotMessage)) return [];
    return parseQuickReplies(latestBotMessage);
  }, [latestBotMessage]);

  const searchMatches = useMemo(
    () => (searchOpen ? findMessageMatches(messages, searchQuery) : []),
    [messages, searchQuery, searchOpen]
  );
  // Keep the cursor on a real match when the query or the messages change.
  const activeSearchIndex = searchMatches.length > 0 ? searchIndex % searchMatches.length : 0;
  const activeMatchId = searchMatches.length > 0 ? searchMatches[activeSearchIndex] : null;

  function handleSearchChange(text) {
    setSearchQuery(text);
    setSearchIndex(0);
  }

  function handleSearchStep(direction) {
    if (searchMatches.length === 0) return;
    setSearchIndex(
      (activeSearchIndex + direction + searchMatches.length) % searchMatches.length
    );
  }

  function handleSearchClose() {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchIndex(0);
  }

  const isTyping =
    sending ||
    machineSnapshot.state === 'AUTHORIZING' ||
    machineSnapshot.state === 'SUBMITTING' ||
    machineSnapshot.state === PaymentState.AUTHORIZING ||
    machineSnapshot.state === PaymentState.SUBMITTING ||
    machineSnapshot.state === PaymentState.SETTLING_STELLAR;

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
    const draft = previewAttachment ? captionText : inputText;
    const start = Math.min(inputSelection.start, draft.length);
    const end = Math.min(inputSelection.end, draft.length);
    (previewAttachment ? setCaptionText : setInputText)(draft.slice(0, start) + emoji + draft.slice(end));
    setInputSelection({ start: start + emoji.length, end: start + emoji.length });
    closeEmojiPicker();
  }

  function handleStart() {
    const trimmed = phoneInput.trim();
    if (!trimmed) return;
    setPhoneNumber(trimmed);
  }

  function performReset() {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current.clear();
    stateMachine.transition(PaymentEvent.RESET);
    setPhoneNumber(null);
    setPhoneInput('');
    setMessages([]);
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setEmojiPickerOpen(false);
    setSending(false);
    setIsListening(false);
    setDisabledReplies({});
    setListDrawer(null);
    setListSelectedRowId(null);
    setReplyTo(null);
    cancelVoiceRecording();
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

  function handleReset() {
    const confirmationMessage =
      'Clear chat history and reset payment state machine?';

    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.confirm) {
      if (window.confirm(confirmationMessage)) {
        performReset();
      }
      return;
    }

    Alert.alert(
      'Reset Conversation',
      confirmationMessage,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: performReset,
        },
      ]
    );
  }

  function handleQuickReply(payload, messageId) {
    if (sending || (messageId && disabledReplies[messageId])) return;
    if (messageId) {
      setDisabledReplies((prev) => ({ ...prev, [messageId]: payload }));
    }
    handleSend(payload);
  }

  function updateMessageStatus(id, newStatus) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const currentPriority = STATUS_PRIORITY[m.status] ?? -1;
        const newPriority = STATUS_PRIORITY[newStatus] ?? -1;
        if (newPriority > currentPriority) {
          return { ...m, status: newStatus };
        }
        return m;
      })
    );
  }

  function scheduleStatus(id, newStatus, delay) {
    const timerId = setTimeout(() => {
      timersRef.current.delete(timerId);
      updateMessageStatus(id, newStatus);
    }, delay);
    timersRef.current.add(timerId);
    return timerId;
  }

  function handleOpenList(list, messageId) {
    if (sending || (messageId && disabledReplies[messageId])) return;
    setListSelectedRowId(null);
    setListDrawer({ list, messageId });
  }

  function handleCloseList() {
    setListDrawer(null);
    setListSelectedRowId(null);
  }

  function handleListSubmit() {
    if (!listDrawer || !listSelectedRowId) return;
    const row = listDrawer.list.sections
      .flatMap((section) => section.rows)
      .find((candidate) => candidate.id === listSelectedRowId);
    if (!row) return;
    const { messageId } = listDrawer;
    handleCloseList();
    // WhatsApp shows the chosen row's title as the user's reply.
    handleQuickReply(row.title, messageId);
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

  function handleInjectSyntheticEvent(eventItem) {
    const syntheticMsg = {
      id: `synth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: eventItem.botMessage,
      sender: 'bot',
      isSynthetic: true,
      syntheticEventId: eventItem.id,
      timestamp: new Date().toLocaleTimeString(),
    };
    setMessages((prev) => [...prev, syntheticMsg]);

    if (voiceSynthesizeEnabled) {
      voiceService.speak(eventItem.botMessage);
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

  function startVoiceRecording() {
    if (sending) return;
    setEmojiPickerOpen(false);
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
    const attachment = customText === undefined ? previewAttachment : null;
    const text = (customText !== undefined ? customText : attachment ? captionText : inputText).trim();
    if ((!text && !attachment) || sending) return;
    const userMessageText = text || (attachment ? (attachment.type === 'photo' ? 'Photo' : attachment.name) : '');
    const quotedReply = replyTo
      ? { id: replyTo.id, text: replyTo.text, sender: replyTo.sender }
      : null;
    const userMsgId = `u-${Date.now()}`;
    const timestamp = new Date().toISOString();

    if (!skipUserBubble) {
      setMessages((prev) => [...prev, {
        id: userMsgId,
        text,
        attachment: attachment || undefined,
        sender: 'user',
        status: MessageStatus.PENDING,
        timestamp,
        ...(quotedReply ? { replyTo: quotedReply } : {}),
      }]);
    }
    if (attachment) handleClearAttachment();
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setEmojiPickerOpen(false);
    setReplyTo(null);
    setSending(true);

    // Schedule micro-delays for receipt progression:
    // Clock -> Single grey tick (~300ms)
    // Single grey tick -> Double grey ticks (~600ms)
    scheduleStatus(userMsgId, MessageStatus.SENT, 300);
    scheduleStatus(userMsgId, MessageStatus.DELIVERED, 600);

    // If current state machine is awaiting PIN and user enters a 4-6 digit PIN
    if (
      machineSnapshot.state === PaymentState.AWAITING_PIN ||
      machineSnapshot.state === PaymentState.RATE_QUOTED
    ) {
      if (/^\d{4,6}$/.test(text)) {
        stateMachine.transition(PaymentEvent.AUTHORIZE);
        // Simulate immediate stellar settlement progression
        setTimeout(() => {
          stateMachine.transition(PaymentEvent.SUBMIT);
        }, 400);
        setTimeout(() => {
          stateMachine.transition(PaymentEvent.STELLAR_SUCCESS, {
            txHash: `${Date.now().toString(16).padEnd(64, '0')}`,
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

      // Bot replied: mark user message as read (double blue ticks)
      updateMessageStatus(userMsgId, MessageStatus.READ);
      appendBotReplies(replies);
      if (
        machineSnapshot.state === 'AUTHORIZING' ||
        machineSnapshot.state === 'SUBMITTING' ||
        machineSnapshot.state === PaymentState.AUTHORIZING ||
        machineSnapshot.state === PaymentState.SUBMITTING ||
        machineSnapshot.state === PaymentState.SETTLING_STELLAR
      ) {
        stateMachine.transition(PaymentEvent.STELLAR_SUCCESS, {
          txHash: `0x${Date.now().toString(16)}`,
        });
      }
    } catch (error) {
      const errorReply = `Couldn't reach SendAm: ${error.message}`;
      const errTimestamp = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, text: errorReply, sender: 'bot', timestamp: errTimestamp },
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
      <View
        className="flex-1 items-center justify-center px-6 gap-3"
        style={{ backgroundColor: theme.background }}
      >
        <View style={{ position: 'absolute', top: 16, right: 16 }}>
          <Pressable
            testID="toggle-theme-button"
            className="border rounded-lg px-2.5 py-1"
            style={{
              borderColor: darkMode ? '#374248' : '#d1d5db',
              backgroundColor: darkMode ? '#2a3942' : '#f9fafb',
            }}
            onPress={() => setDarkMode((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: darkMode ? '#e9edef' : '#374151' }}
            >
              {darkMode ? '☀️ Light' : '🌙 Dark'}
            </Text>
          </Pressable>
        </View>
        <Text
          className="text-lg font-semibold"
          style={{ color: theme.headerText }}
        >
          Enter your phone number
        </Text>
        <TextInput
          className="w-full border rounded-lg px-3 py-2 text-base"
          style={{
            borderColor: darkMode ? '#2a3942' : '#d1d5db',
            backgroundColor: theme.inputBg,
            color: theme.inputText,
          }}
          placeholder="+2348000000001"
          placeholderTextColor={theme.inputPlaceholder}
          keyboardType="phone-pad"
          value={phoneInput}
          onChangeText={setPhoneInput}
          onSubmitEditing={handleStart}
        />
        <Pressable
          testID="start-button"
          className="w-full rounded-lg py-2 items-center"
          style={{ backgroundColor: theme.sendButtonBg }}
          onPress={handleStart}
          disabled={!phoneInput.trim()}
        >
          <Text className="text-white font-semibold">Start chatting</Text>
        </Pressable>
      </View>
    );
  }

  // Developer Synthetic Webhook Event Injector Drawer
  const syntheticEventsDrawer = (
    <View
      className="bg-amber-50 border-b border-amber-200 p-3"
      testID="synthetic-webhook-drawer"
    >
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-xs font-bold text-amber-900">
            SYNTHETIC WEBHOOK EVENT INJECTOR:
          </Text>
          <Text className="text-[11px] text-amber-700">
            One-click simulate inbound WhatsApp status events
          </Text>
        </View>
        <Pressable
          onPress={() => setSyntheticDrawerOpen(false)}
          className="px-2 py-0.5 rounded bg-amber-200"
          aria-label="Close webhook injector drawer"
        >
          <Text className="text-[11px] font-semibold text-amber-900">Close</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row py-1">
        {SYNTHETIC_WEBHOOK_EVENTS.map((eventItem) => (
          <Pressable
            key={eventItem.id}
            testID={`synth-event-${eventItem.id}`}
            onPress={() => handleInjectSyntheticEvent(eventItem)}
            className="bg-white border border-amber-300 rounded-lg p-2.5 mr-2.5 w-60 shadow-sm"
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-xs font-bold text-gray-900" numberOfLines={1}>
                {eventItem.title}
              </Text>
            </View>
            <Text className="text-[11px] text-amber-700 font-semibold mb-1">
              {eventItem.badge}
            </Text>
            <Text className="text-[11px] text-gray-500" numberOfLines={2}>
              {eventItem.description}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );

  // Desktop State Machine Inspector Side Panel
  const desktopInspectorPanel = (
    <View
      testID="desktop-state-machine-inspector"
      className="w-96 border-l border-slate-700 bg-slate-900 text-slate-100 flex-col h-full overflow-hidden"
    >
      {/* Side Panel Header */}
      <View className="p-3 border-b border-slate-800 flex-row items-center justify-between">
        <View>
          <Text className="text-xs font-bold text-slate-200">
            PAYMENT STATE MACHINE
          </Text>
          <Text className="text-[11px] text-slate-400">
            Live Desktop Inspector
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text
            className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-600 text-white"
            testID="active-state-node"
          >
            {machineSnapshot.state}
          </Text>
          <Pressable
            testID="close-desktop-inspector"
            onPress={() => setDesktopInspectorOpen(false)}
            className="px-1.5 py-0.5 rounded bg-slate-800"
          >
            <Text className="text-xs text-slate-400">✕</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1 p-3">
        {/* State Machine Nodes Pipeline Visualizer */}
        <View className="mb-4">
          <Text className="text-xs font-semibold text-slate-400 mb-2">
            State Machine Nodes:
          </Text>
          <View className="flex-row flex-wrap gap-1.5" testID="state-machine-nodes">
            {PIPELINE_NODES.map((node) => {
              const isActive = machineSnapshot.state === node;
              return (
                <View
                  key={node}
                  className={`px-2.5 py-1 rounded text-xs border ${
                    isActive
                      ? 'bg-emerald-600 border-emerald-400 text-white font-bold'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <Text
                    className={`text-xs ${
                      isActive ? 'text-white font-bold' : 'text-slate-400'
                    }`}
                  >
                    {isActive ? `● ${node}` : node}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Live Context Variables */}
        <View className="mb-4" testID="desktop-context-variables">
          <Text className="text-xs font-semibold text-slate-400 mb-2">
            Context Variables:
          </Text>
          <View className="bg-slate-800/80 rounded-lg p-2.5 border border-slate-700 space-y-1">
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">Amount & Asset:</Text>
              <Text className="text-xs font-mono text-emerald-400">
                {machineSnapshot.context.amount !== null
                  ? `${machineSnapshot.context.amount} ${machineSnapshot.context.asset || 'USDC'}`
                  : 'None'}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">Recipient:</Text>
              <Text className="text-xs font-mono text-slate-200">
                {machineSnapshot.context.recipient || 'None'}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">Recipient Phone:</Text>
              <Text className="text-xs font-mono text-slate-200">
                {machineSnapshot.context.recipientPhone || 'None'}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">Fee / Rate:</Text>
              <Text className="text-xs font-mono text-slate-200">
                {machineSnapshot.context.fee
                  ? `${machineSnapshot.context.fee} (Rate: ${machineSnapshot.context.estimatedRate})`
                  : 'None'}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">Stellar Tx Hash:</Text>
              <Text className="text-xs font-mono text-sky-400" numberOfLines={1}>
                {machineSnapshot.context.stellarTxHash || 'None'}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5 border-b border-slate-700/50">
              <Text className="text-xs text-slate-400">PIN Attempts:</Text>
              <Text className="text-xs font-mono text-amber-400">
                {machineSnapshot.context.pinAttempts ?? 0}
              </Text>
            </View>
            <View className="flex-row justify-between py-0.5">
              <Text className="text-xs text-slate-400">Error Message:</Text>
              <Text className="text-xs font-mono text-rose-400">
                {machineSnapshot.context.errorMessage || 'None'}
              </Text>
            </View>
          </View>
        </View>

        {/* Synthetic Webhooks Quick Inject */}
        <View className="mb-4">
          <Text className="text-xs font-semibold text-slate-400 mb-2">
            Quick Webhook Injection:
          </Text>
          <View className="flex-col gap-1.5">
            {SYNTHETIC_WEBHOOK_EVENTS.slice(0, 4).map((evt) => (
              <Pressable
                key={evt.id}
                onPress={() => handleInjectSyntheticEvent(evt)}
                className="bg-slate-800 border border-slate-700 rounded p-2 hover:bg-slate-700"
              >
                <Text className="text-xs font-medium text-amber-300">
                  {evt.title}
                </Text>
                <Text className="text-[10px] text-slate-400">
                  {evt.badge}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Live Event Logs & Timeline */}
        <View className="mb-4" testID="desktop-event-logs">
          <Text className="text-xs font-semibold text-slate-400 mb-2">
            Live Event Logs & Timeline ({machineSnapshot.history.length}):
          </Text>
          <View className="space-y-1.5">
            {machineSnapshot.history.map((snapshot) => (
              <View
                key={snapshot.index}
                className="bg-slate-800/90 border border-slate-700 rounded p-2 flex-row items-center justify-between"
              >
                <View className="flex-1 mr-2">
                  <Text className="text-xs font-mono text-emerald-400">
                    #{snapshot.index}: {snapshot.action}
                  </Text>
                  <Text className="text-[10px] text-slate-400">
                    State: {snapshot.state}
                  </Text>
                </View>
                <Pressable
                  testID={`desktop-rollback-${snapshot.index}`}
                  onPress={() => handleRollback(snapshot.index)}
                  className="bg-slate-700 rounded px-2 py-1"
                >
                  <Text className="text-[10px] text-slate-200">Rollback</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );

  // Chat Interface Main Content
  const chatMainContent = (
    <View className="flex-1 flex-col h-full" style={{ backgroundColor: theme.background }}>
      {/* Top Header */}
      <View
        className="flex-row items-center justify-between px-3 py-2 border-b"
        style={{
          backgroundColor: theme.headerBg,
          borderBottomColor: theme.headerBorder,
        }}
      >
        <View className="flex-row items-center gap-2">
          <Text
            className="text-base font-semibold"
            style={{ color: theme.headerText }}
          >
            {phoneNumber}
          </Text>
          <View
            testID="connection-status-badge"
            className={`px-2 py-0.5 rounded-full ${networkProfile.badgeColor}`}
          >
            <Text className="text-xs font-semibold">{networkProfile.badgeLabel}</Text>
          </View>
        </View>
        <View className="flex-row items-center gap-2">
          <Pressable
            testID="toggle-theme-button"
            className="border rounded-lg px-2.5 py-1"
            style={{
              borderColor: darkMode ? '#374248' : '#d1d5db',
              backgroundColor: darkMode ? '#2a3942' : '#f9fafb',
            }}
            onPress={() => setDarkMode((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: darkMode ? '#e9edef' : '#374151' }}
            >
              {darkMode ? '☀️ Light' : '🌙 Dark'}
            </Text>
          </Pressable>
          <Pressable
            testID="search-toggle-button"
            className={`border rounded-lg px-2.5 py-1 ${searchOpen ? 'border-yellow-500 bg-yellow-50' : 'border-gray-300'}`}
            onPress={() => (searchOpen ? handleSearchClose() : setSearchOpen(true))}
          >
            <Text className="text-xs font-semibold text-gray-700">🔍 Search</Text>
          </Pressable>
          <Pressable
            testID="export-transcript-button"
            className="border rounded-lg px-2.5 py-1"
            style={{
              borderColor: darkMode ? '#00a884' : '#10b981',
              backgroundColor: darkMode ? '#202c33' : '#ecfdf5',
            }}
            onPress={handleExportTxt}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: darkMode ? '#00a884' : '#047857' }}
            >
              Export .txt
            </Text>
          </Pressable>
          <Pressable
            testID="export-transcript-json-button"
            className="border rounded-lg px-2.5 py-1"
            style={{
              borderColor: darkMode ? '#00a884' : '#10b981',
              backgroundColor: darkMode ? '#202c33' : '#ecfdf5',
            }}
            onPress={handleExportJson}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: darkMode ? '#00a884' : '#047857' }}
            >
              Export .json
            </Text>
          </Pressable>
          <Pressable
            testID="reset-session-button"
            className="border rounded-lg px-3 py-1"
            style={{
              borderColor: darkMode ? '#374248' : '#d1d5db',
              backgroundColor: darkMode ? '#2a3942' : '#ffffff',
            }}
            onPress={handleReset}
          >
            <Text
              className="text-sm font-semibold"
              style={{ color: darkMode ? '#e9edef' : '#374151' }}
            >
              Reset
            </Text>
          </Pressable>
        </View>
      </View>

      {/* In-chat search bar (#786) */}
      {searchOpen && (
        <View
          testID="search-bar"
          className="flex-row items-center gap-2 px-3 py-2 bg-yellow-50/70 border-b border-yellow-200"
        >
          <TextInput
            testID="search-input"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-1 text-sm bg-white"
            placeholder="Search messages"
            value={searchQuery}
            onChangeText={handleSearchChange}
            autoComplete="off"
            autoCorrect={false}
          />
          <Text testID="search-counter" className="text-xs font-semibold text-gray-600">
            {searchQuery.trim()
              ? searchMatches.length > 0
                ? `${activeSearchIndex + 1} of ${searchMatches.length}`
                : 'No matches'
              : ''}
          </Text>
          <Pressable
            testID="search-up-button"
            disabled={searchMatches.length === 0}
            onPress={() => handleSearchStep(-1)}
            className={`border border-gray-300 rounded-lg px-2 py-1 ${searchMatches.length === 0 ? 'opacity-40' : ''}`}
          >
            <Text className="text-xs font-bold text-gray-700">▲</Text>
          </Pressable>
          <Pressable
            testID="search-down-button"
            disabled={searchMatches.length === 0}
            onPress={() => handleSearchStep(1)}
            className={`border border-gray-300 rounded-lg px-2 py-1 ${searchMatches.length === 0 ? 'opacity-40' : ''}`}
          >
            <Text className="text-xs font-bold text-gray-700">▼</Text>
          </Pressable>
          <Pressable
            testID="search-close-button"
            onPress={handleSearchClose}
            className="rounded-lg px-2 py-1"
          >
            <Text className="text-sm text-gray-500">✕</Text>
          </Pressable>
        </View>
      )}

      {/* Dev Mode Toolbar */}
      <View
        className="border-b px-3 py-2 flex-row justify-between items-center flex-wrap gap-2"
        style={{
          backgroundColor: darkMode ? '#182229' : '#f3f4f6',
          borderBottomColor: darkMode ? '#222d34' : '#e5e7eb',
        }}
      >
        <View className="flex-row items-center gap-2">
          <Text
            className="text-xs font-bold"
            style={{ color: darkMode ? '#8696a0' : '#374151' }}
          >
            ENGINE STATE:
          </Text>
          <Text
            className="text-xs font-semibold px-2 py-0.5 rounded"
            style={{
              backgroundColor: darkMode ? '#202c33' : '#e0e7ff',
              color: darkMode ? '#818cf8' : '#3730a3',
            }}
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
            className="px-2 py-1 rounded"
            style={{
              backgroundColor: voiceSynthesizeEnabled
                ? darkMode
                  ? '#202c33'
                  : '#d1fae5'
                : darkMode
                  ? '#2a3942'
                  : '#e5e7eb',
            }}
          >
            <Text
              className="text-xs font-medium"
              style={{
                color: voiceSynthesizeEnabled
                  ? darkMode
                    ? '#00a884'
                    : '#065f46'
                  : darkMode
                    ? '#8696a0'
                    : '#1f2937',
              }}
            >
              {voiceSynthesizeEnabled
                ? 'Voice TTS: ON'
                : 'Voice TTS: OFF'}
            </Text>
          </Pressable>
          <Pressable
            testID="toggle-synthetic-drawer"
            onPress={() => setSyntheticDrawerOpen((prev) => !prev)}
            className={`px-2 py-1 rounded ${syntheticDrawerOpen ? 'bg-amber-600' : 'bg-amber-500'}`}
          >
            <Text className="text-xs font-medium text-white">
              {syntheticDrawerOpen ? 'Hide Webhooks' : 'Webhooks'}
            </Text>
          </Pressable>
          {isDesktop ? (
            <Pressable
              testID="toggle-desktop-inspector"
              onPress={() => setDesktopInspectorOpen((prev) => !prev)}
              className="px-2 py-1 bg-indigo-600 rounded"
            >
              <Text className="text-xs font-medium text-white">
                {desktopInspectorOpen ? 'Hide Inspector' : 'Inspector'}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              testID="toggle-dev-inspector"
              onPress={() => setDevModeOpen((prev) => !prev)}
              className="px-2 py-1 bg-indigo-600 rounded"
            >
              <Text className="text-xs font-medium text-white">
                {devModeOpen ? 'Hide Inspector' : 'Inspector'}
              </Text>
            </Pressable>
          )}
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

      {/* Synthetic Webhooks Drawer */}
      {syntheticDrawerOpen && syntheticEventsDrawer}

      {/* Mobile Dev Inspector Drawer */}
      {!isDesktop && devModeOpen && (
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

      {/* Messages Thread */}
      <View
        className="flex-1"
        style={{
          backgroundColor: theme.chatBackground,
          position: 'relative',
        }}
      >
        <ChatWallpaper darkMode={darkMode} />
        <MessageList
          messages={messages}
          onQuickReply={handleQuickReply}
          onOpenList={handleOpenList}
          disabledReplies={disabledReplies}
          sending={sending}
          onReply={setReplyTo}
          searchQuery={searchOpen ? searchQuery : ''}
          activeMatchId={searchOpen ? activeMatchId : null}
          darkMode={darkMode}
        />
      </View>
      {isTyping ? <TypingIndicator darkMode={darkMode} /> : null}

      {/* WhatsApp interactive quick-reply suggestions bar above input */}
      {latestQuickReplies.length > 0 && !disabledReplies[latestBotMessage?.id] && (
        <View
          testID="quick-replies-bottom-bar"
          className="flex-row flex-wrap gap-2 px-3 py-2 border-t"
          style={{
            backgroundColor: darkMode ? '#182229' : 'rgba(236, 253, 245, 0.7)',
            borderTopColor: darkMode ? '#222d34' : '#d1fae5',
          }}
        >
          {latestQuickReplies.map((reply, idx) => (
            <Pressable
              key={reply.id || idx}
              testID={`bottom-quick-reply-${idx}`}
              disabled={sending || Boolean(disabledReplies[latestBotMessage?.id])}
              onPress={() => handleQuickReply(reply.payload, latestBotMessage?.id)}
              className="border rounded-full px-3 py-1 shadow-sm"
              style={
                darkMode
                  ? { backgroundColor: '#202c33', borderColor: '#00a884' }
                  : { backgroundColor: '#ffffff', borderColor: '#10b981' }
              }
            >
              <Text
                className="text-xs font-semibold"
                style={{ color: darkMode ? '#00a884' : '#047857' }}
              >
                {reply.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View
        className="flex-row items-center justify-end px-3 py-2 border-t"
        style={{
          backgroundColor: darkMode ? '#182229' : '#ecfdf5',
          borderTopColor: darkMode ? '#222d34' : '#e5e7eb',
        }}
      >
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
          </Pressable>
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
      <View className="flex-row items-center gap-2 px-3 py-2 border-t"
        style={{ zIndex: 2, backgroundColor: theme.inputBarBg, borderTopColor: theme.inputBarBorder }} onLayout={({ nativeEvent }) => setComposerHeight(nativeEvent.layout.height)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Choose emoji"
          accessibilityState={{ expanded: emojiPickerOpen, disabled: sending || isRecording }}
          disabled={sending || isRecording} onPress={() => emojiPickerOpen ? closeEmojiPicker() : setEmojiPickerOpen(true)}
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 24 }}>☺</Text>
        </Pressable>
        {isRecording && (
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
        )}
        <Pressable
          testID="paperclip-button"
          className={`rounded-full p-2 items-center justify-center ${attachmentMenuOpen ? 'bg-emerald-200' : 'bg-gray-100'}`}
          style={darkMode ? { backgroundColor: attachmentMenuOpen ? '#005c4b' : '#2a3942' } : undefined}
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
          accessibilityLabel="Tap to dictate or hold to record"
          onPressIn={() => { recordedPress.current = false; }}
          onLongPress={() => { recordedPress.current = true; startVoiceRecording(); }}
          onPressOut={stopVoiceRecordingAndSend}
          onPress={() => { if (!recordedPress.current) handleVoiceInput(); }}
        >
          <Text
            className="text-xs font-bold"
            style={{
              color: isListening ? '#ffffff' : darkMode ? '#d1d7db' : '#374151',
            }}
          >
            {isListening ? 'REC...' : 'MIC'}
          </Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          className="flex-1 border rounded-full px-4 py-2 text-base"
          style={{
            minWidth: 0,
            backgroundColor: theme.inputBg,
            borderColor: darkMode ? '#2a3942' : '#d1d5db',
            color: theme.inputText,
          }}
          placeholder={previewAttachment ? 'Caption or press Send...' : 'Type a message or use speech'}
          placeholderTextColor={theme.inputPlaceholder}
          value={previewAttachment ? captionText : inputText}
          onChangeText={previewAttachment ? setCaptionText : setInputText}
          selection={inputSelection}
          onSelectionChange={({ nativeEvent }) => setInputSelection(nativeEvent.selection)}
          onSubmitEditing={() => handleSend()}
          editable={!sending}
        />
        <Pressable
          testID="send-button"
          className="rounded-full px-4 py-2 items-center justify-center"
          style={{ backgroundColor: theme.sendButtonBg }}
          onPress={() => handleSend()}
          disabled={sending || (!inputText.trim() && !previewAttachment && !captionText.trim())}
        >
          <Text className="text-xs font-bold text-white">
            {sending ? '...' : 'Send'}
          </Text>
        </Pressable>
      </View>

      {/* WhatsApp list-message modal drawer (#784): sections, row descriptions
          and radio selection, submitted through the same quick-reply path. */}
      <Modal
        visible={Boolean(listDrawer)}
        transparent
        animationType="slide"
        onRequestClose={handleCloseList}
      >
        <View className="flex-1 justify-end bg-black/40">
          <Pressable
            testID="list-drawer-backdrop"
            className="flex-1"
            onPress={handleCloseList}
          />
          {listDrawer && (
            <View testID="list-drawer" className="bg-white rounded-t-2xl max-h-[75%]">
              <View className="items-center pt-2">
                <View className="w-10 h-1 rounded-full bg-gray-300" />
              </View>
              <View className="flex-row items-center justify-between px-4 py-3 border-b border-gray-200">
                <Text className="text-base font-semibold text-gray-900">
                  {listDrawer.list.buttonLabel}
                </Text>
                <Pressable
                  testID="list-drawer-close"
                  accessibilityRole="button"
                  onPress={handleCloseList}
                  className="rounded-full px-2 py-0.5 active:bg-gray-100"
                >
                  <Text className="text-lg text-gray-500">✕</Text>
                </Pressable>
              </View>
              <ScrollView className="px-2">
                {listDrawer.list.sections.map((section) => (
                  <View key={section.id} className="pb-1">
                    {section.title ? (
                      <Text
                        testID={`list-section-${section.id}`}
                        className="px-2 pt-3 pb-1 text-xs font-semibold uppercase text-emerald-700"
                      >
                        {section.title}
                      </Text>
                    ) : null}
                    {section.rows.map((row) => {
                      const isSelected = listSelectedRowId === row.id;
                      return (
                        <Pressable
                          key={row.id}
                          testID={`list-row-${row.id}`}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: isSelected }}
                          onPress={() => setListSelectedRowId(row.id)}
                          className="flex-row items-center justify-between gap-3 px-2 py-2.5 border-b border-gray-100 active:bg-gray-50"
                        >
                          <View className="flex-1">
                            <Text className="text-sm font-medium text-gray-900">
                              {row.title}
                            </Text>
                            {row.description ? (
                              <Text className="text-xs text-gray-500">{row.description}</Text>
                            ) : null}
                          </View>
                          <View
                            testID={`list-row-radio-${row.id}`}
                            className={`w-5 h-5 rounded-full border-2 items-center justify-center ${
                              isSelected ? 'border-emerald-600' : 'border-gray-300'
                            }`}
                          >
                            {isSelected ? (
                              <View className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </ScrollView>
              <View className="px-4 py-3 border-t border-gray-200">
                <Pressable
                  testID="list-drawer-send"
                  accessibilityRole="button"
                  disabled={!listSelectedRowId}
                  onPress={handleListSubmit}
                  className={`rounded-full py-2.5 items-center ${
                    listSelectedRowId ? 'bg-emerald-600 active:bg-emerald-700' : 'bg-gray-200'
                  }`}
                >
                  <Text
                    className={`font-semibold ${
                      listSelectedRowId ? 'text-white' : 'text-gray-400'
                    }`}
                  >
                    Send
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );

  return (
    <KeyboardAvoidingView
      className="flex-1"
      style={{ backgroundColor: theme.background }}
      onLayout={({ nativeEvent }) => setScreenHeight(nativeEvent.layout.height)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {isDesktop ? (
        <View className="flex-1 flex-row bg-gray-100">
          <View className="flex-1 max-w-3xl border-r border-gray-200 bg-white">
            {chatMainContent}
          </View>
          {desktopInspectorOpen && desktopInspectorPanel}
        </View>
      ) : (
        chatMainContent
      )}

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
