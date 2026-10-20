import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';

function VectorCheckmark({ color, size = 11 }) {
  return (
    <View
      style={{
        width: size * 0.38,
        height: size * 0.72,
        borderBottomWidth: 1.8,
        borderRightWidth: 1.8,
        borderColor: color,
        transform: [{ rotate: '45deg' }],
        marginRight: 1,
        marginBottom: 2,
      }}
    />
  );
}

function VectorDoubleCheckmark({ color, size = 11 }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
      <VectorCheckmark color={color} size={size} />
      <View style={{ marginLeft: -2 }}>
        <VectorCheckmark color={color} size={size} />
      </View>
    </View>
  );
}

function VectorClock({ color, size = 10 }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.2,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 1,
      }}
    >
      <View
        style={{
          width: 1.2,
          height: size * 0.38,
          backgroundColor: color,
          position: 'absolute',
          top: 1.8,
        }}
      />
      <View
        style={{
          width: size * 0.3,
          height: 1.2,
          backgroundColor: color,
          position: 'absolute',
          right: 1.8,
          top: size * 0.44,
        }}
      />
    </View>
  );
}

const USER_META_COLOR = '#ebebebff';
const BOT_META_COLOR = '#6b7280';
const READ_RECEIPT_COLOR = '#4a75bfff'; // Solid WhatsApp Blue

function formatTime(timestamp) {
  if (!timestamp) return null;
  try {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    // fallback
  }
  return String(timestamp);
}

function ReceiptStatus({ status }) {
  const scale = useRef(new Animated.Value(0.7)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    let isMounted = true;
    async function runAnimation() {
      let reduceMotion = false;
      try {
        if (AccessibilityInfo?.isReduceMotionEnabled) {
          reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
        }
      } catch {
        // Fallback gracefully
      }

      if (!isMounted) return;

      if (reduceMotion) {
        scale.setValue(1);
        opacity.setValue(1);
        return;
      }

      scale.setValue(0.7);
      opacity.setValue(0.5);
      Animated.parallel([
        Animated.spring(scale, {
          toValue: 1,
          friction: 6,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }

    runAnimation();
    return () => {
      isMounted = false;
    };
  }, [status, scale, opacity]);

  const normalColor = USER_META_COLOR;
  const readColor = READ_RECEIPT_COLOR;
  let content = null;

  switch (status) {
    case 'pending':
      content = (
        <View testID="status-pending" style={{ marginLeft: 2 }}>
          <VectorClock color={normalColor} />
        </View>
      );
      break;
    case 'sent':
      content = (
        <View testID="status-sent" style={{ marginLeft: 2 }}>
          <VectorCheckmark color={normalColor} />
        </View>
      );
      break;
    case 'delivered':
      content = (
        <View testID="status-delivered">
          <VectorDoubleCheckmark color={normalColor} />
        </View>
      );
      break;
    case 'read':
      content = (
        <View testID="status-read">
          <VectorDoubleCheckmark color={readColor} />
        </View>
      );
      break;
    default:
      return null;
  }

  return (
    <Animated.View
      style={{
        transform: [{ scale }],
        opacity,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      {content}
    </Animated.View>
  );
}

export function parseQuickReplies(message) {
  if (!message || message.sender !== 'bot') return [];
  if (Array.isArray(message.quickReplies) && message.quickReplies.length > 0) {
    return message.quickReplies.map((r, i) => {
      if (typeof r === 'string') return { id: `qr-${i}`, label: r, payload: r };
      return {
        id: r.id || `qr-${i}`,
        label: r.label || r.text || String(r),
        payload: r.payload || r.text || r.label || String(r),
      };
    });
  }
  if (Array.isArray(message.options) && message.options.length > 0) {
    return message.options.map((opt, i) => {
      if (typeof opt === 'string') return { id: `opt-${i}`, label: opt, payload: opt };
      return {
        id: opt.id || `opt-${i}`,
        label: opt.label || opt.text || String(opt),
        payload: opt.payload || opt.text || opt.label || String(opt),
      };
    });
  }
  const text = String(message.text || '');
  const replies = [];

  // Match numbered/listed options, e.g. "1: Check Balance", "2. Send Money", "1) Check Balance", "[1] Check Balance"
  const optionRegex = /(?:^|\n)\s*(?:\[?(\d+)\]?[\.:\)\-]\s+([^\n\r]+))/g;
  let match;
  while ((match = optionRegex.exec(text)) !== null) {
    const rawNum = match[1];
    const rawLabel = match[2].trim();
    replies.push({
      id: `num-${rawNum}`,
      label: `${rawNum}: ${rawLabel}`,
      payload: `${rawNum}: ${rawLabel}`,
    });
  }

  // Also check for yes/no confirmation prompts, e.g. Reply "YES" to confirm, or "NO" to cancel.
  if (replies.length === 0) {
    const yesNoMatch = text.match(/reply\s+["']?(yes)["']?\s+to\s+confirm(?:ing)?(?:,\s*or\s*["']?(no)["']?\s+to\s+cancel)?/i);
    if (yesNoMatch) {
      replies.push({ id: 'opt-yes', label: 'YES', payload: 'YES' });
      if (yesNoMatch[2] || /cancel/i.test(text)) {
        replies.push({ id: 'opt-no', label: 'NO', payload: 'NO' });
      }
    }
  }

  return replies;
}

export default function MessageList({
  messages,
  onQuickReply,
  disabledReplies = {},
  sending = false,
}) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
        const hasMeta = Boolean(item.timestamp || (isUser && item.status));
        const quickReplies = !isUser ? parseQuickReplies(item) : [];
        const isMsgDisabled = Boolean(disabledReplies[item.id]) || sending;

        return (
          <View key={item.id} className="gap-1.5">
            <View
              testID={`bubble-${item.sender}`}
              className={
                isUser
                  ? 'self-end bg-green-500 rounded-2xl px-3 py-2 max-w-[80%]'
                  : 'self-start bg-gray-200 rounded-2xl px-3 py-2 max-w-[80%]'
              }
            >
              <Text className={isUser ? 'text-white' : 'text-gray-900'}>{item.text}</Text>
              {hasMeta && (
                <View className="flex-row items-center justify-end gap-1 mt-1">
                  {item.timestamp ? (
                    <Text
                      style={{
                        fontSize: 10,
                        color: isUser ? USER_META_COLOR : BOT_META_COLOR,
                      }}
                    >
                      {formatTime(item.timestamp)}
                    </Text>
                  ) : null}
                  {isUser && item.status ? <ReceiptStatus status={item.status} /> : null}
                </View>
              )}
            </View>

            {/* WhatsApp interactive quick-reply pill buttons */}
            {quickReplies.length > 0 && (
              <View
                testID="quick-replies-container"
                className="flex-row flex-wrap gap-2 mt-1 self-start max-w-[90%]"
              >
                {quickReplies.map((reply, idx) => {
                  const isSelected = disabledReplies[item.id] === reply.payload;
                  return (
                    <Pressable
                      key={reply.id || idx}
                      testID={`quick-reply-${idx}`}
                      accessibilityRole="button"
                      disabled={isMsgDisabled}
                      onPress={() => onQuickReply && onQuickReply(reply.payload, item.id)}
                      className={`px-3 py-1.5 rounded-full border shadow-sm ${
                        isMsgDisabled
                          ? isSelected
                            ? 'bg-emerald-600 border-emerald-700 opacity-90'
                            : 'bg-gray-100 border-gray-300 opacity-50'
                          : 'bg-emerald-50 border-emerald-500 active:bg-emerald-100'
                      }`}
                    >
                      <Text
                        className={`text-xs font-semibold ${
                          isMsgDisabled
                            ? isSelected
                              ? 'text-white'
                              : 'text-gray-400'
                            : 'text-emerald-700'
                        }`}
                      >
                        {reply.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
