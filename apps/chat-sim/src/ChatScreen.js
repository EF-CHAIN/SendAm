import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import MessageList from './MessageList';
import usePolling from './usePolling';
import {
  PaymentStateMachine,
  PaymentState,
  PaymentEvent,
} from './engine/paymentStateMachine';
import { voiceService } from './engine/voiceService';
import { API_BASE_URL } from './config';

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
  PaymentState.SETTLING_STELLAR,
  PaymentState.RECEIPT_DELIVERED,
  PaymentState.COMPLETED,
  PaymentState.ERROR,
];

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
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 768;

  const [phoneNumber, setPhoneNumber] = useState(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceSynthesizeEnabled, setVoiceSynthesizeEnabled] = useState(true);
  const [devModeOpen, setDevModeOpen] = useState(false);
  const [syntheticDrawerOpen, setSyntheticDrawerOpen] = useState(false);
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState(true);

  // Initialize deterministic Payment State Machine engine
  const stateMachine = useMemo(() => new PaymentStateMachine(), []);
  const [machineSnapshot, setMachineSnapshot] = useState({
    state: stateMachine.getState(),
    context: stateMachine.getContext(),
    history: stateMachine.getHistory(),
  });

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
  }

  function appendBotReplies(replies) {
    const newMsgs = replies.map((reply, index) => ({
      id: `b-${Date.now()}-${index}`,
      text: reply,
      sender: 'bot',
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
      { id: `u-${Date.now()}`, text, sender: 'user' },
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
        { id: `err-${Date.now()}`, text: errorReply, sender: 'bot' },
      ]);
      if (voiceSynthesizeEnabled) {
        voiceService.speak(errorReply);
      }
    } finally {
      setSending(false);
    }
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
    <View className="flex-1 flex-col h-full bg-white">
      {/* Top Header */}
      <View className="flex-row items-center justify-between px-3 py-2 border-b border-gray-200">
        <Text className="text-base font-semibold text-gray-900">{phoneNumber}</Text>
        <Pressable
          testID="reset-session-button"
          className="border border-gray-300 rounded-lg px-3 py-1"
          onPress={handleReset}
        >
          <Text className="text-sm font-semibold text-gray-700">Switch Account</Text>
        </Pressable>
      </View>

      {/* Dev Mode Toolbar */}
      <View className="bg-gray-100 border-b border-gray-200 px-3 py-2 flex-row justify-between items-center flex-wrap gap-2">
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
              {voiceSynthesizeEnabled ? 'Voice TTS: ON' : 'Voice TTS: OFF'}
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
      <View className="flex-1">
        <MessageList messages={messages} />
      </View>
      {sending ? <TypingIndicator /> : null}

      {/* Chat Input Bar */}
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
    </View>
  );

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-white"
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
    </KeyboardAvoidingView>
  );
}
