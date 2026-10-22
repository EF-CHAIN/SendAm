import { useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';

const SWIPE_REPLY_THRESHOLD = 56;
const MAX_SWIPE_DISTANCE = 96;

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

function pointFromEvent(event) {
  const touch = event?.nativeEvent?.touches?.[0] ?? event?.nativeEvent ?? {};
  return {
    x: touch.pageX ?? touch.locationX ?? 0,
    y: touch.pageY ?? touch.locationY ?? 0,
  };
}

// A message bubble that can be dragged horizontally to the right to quote it.
// Swiping reveals a reply arrow; releasing past the threshold notifies the
// parent and springs the bubble back into place.
function SwipeableBubble({ item, isUser, onReply }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const startX = useRef(0);
  const startY = useRef(0);
  const distance = useRef(0);
  const [swiping, setSwiping] = useState(false);
  const iconOpacity = translateX.interpolate({
    inputRange: [0, 24, SWIPE_REPLY_THRESHOLD],
    outputRange: [0, 0.45, 1],
    extrapolate: 'clamp',
  });

  const resetBubble = () => {
    distance.current = 0;
    setSwiping(false);
    Animated.spring(translateX, {
      toValue: 0,
      speed: 20,
      bounciness: 4,
      useNativeDriver: false,
    }).start();
  };

  const handleTouchStart = (event) => {
    const point = pointFromEvent(event);
    startX.current = point.x;
    startY.current = point.y;
    distance.current = 0;
  };

  const handleMoveShouldSetResponder = (event) => {
    const point = pointFromEvent(event);
    const dx = point.x - startX.current;
    const dy = point.y - startY.current;
    // Only claim the gesture for a rightward swipe that is clearly horizontal.
    return dx > 8 && Math.abs(dx) > Math.abs(dy) * 1.5;
  };

  const handleResponderMove = (event) => {
    const point = pointFromEvent(event);
    const dx = Math.max(0, Math.min(point.x - startX.current, MAX_SWIPE_DISTANCE));
    distance.current = dx;
    translateX.setValue(dx);
    setSwiping(dx > 0);
  };

  const handleResponderRelease = () => {
    if (distance.current >= SWIPE_REPLY_THRESHOLD) {
      onReply?.(item);
    }
    resetBubble();
  };

  return (
    <View className={`relative ${isUser ? 'self-end' : 'self-start'} max-w-[80%]`}>
      <Animated.View
        testID={`swipe-row-${item.id}`}
        style={{ transform: [{ translateX }] }}
        onTouchStart={handleTouchStart}
        onStartShouldSetResponder={() => false}
        onMoveShouldSetResponder={handleMoveShouldSetResponder}
        onResponderMove={handleResponderMove}
        onResponderRelease={handleResponderRelease}
        onResponderTerminate={resetBubble}
        onResponderTerminationRequest={() => false}
      >
        <View
          testID={`bubble-${item.sender}`}
          className={
            isUser
              ? 'bg-green-500 rounded-2xl px-3 py-2'
              : 'bg-gray-200 rounded-2xl px-3 py-2'
          }
        >
          {item.replyTo && (
            <View className="mb-1 border-l-2 border-emerald-300 pl-2">
              <Text className="text-[11px] font-semibold text-emerald-700">
                {item.replyTo.sender === 'user' ? 'You' : 'SendAm'}
              </Text>
              <Text className="text-[11px] text-gray-600" numberOfLines={1}>
                {item.replyTo.text}
              </Text>
            </View>
          )}
          <Text className={isUser ? 'text-white' : 'text-gray-900'}>{item.text}</Text>
        </View>
      </Animated.View>
      {swiping && (
        <Animated.View
          testID={`reply-icon-${item.id}`}
          pointerEvents="none"
          className="h-8 w-8 items-center justify-center rounded-full bg-emerald-100"
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            marginTop: -16,
            opacity: iconOpacity,
          }}
        >
          <Text className="text-base font-bold text-emerald-700">↩</Text>
        </Animated.View>
      )}
    </View>
  );
}

export default function MessageList({
  messages,
  onQuickReply,
  disabledReplies = {},
  sending = false,
  onReply,
}) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
        const quickReplies = !isUser ? parseQuickReplies(item) : [];
        const isMsgDisabled = Boolean(disabledReplies[item.id]) || sending;

        return (
          <View key={item.id} className="gap-1.5">
            <SwipeableBubble item={item} isUser={isUser} onReply={onReply} />

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
