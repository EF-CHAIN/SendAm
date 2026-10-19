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

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-white"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
        <MessageList messages={messages} />
      </View>
      {sending ? <TypingIndicator /> : null}

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
        >
          <Text className="text-xs font-bold text-white">
            {isRecording ? 'REC' : 'MIC'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
