import { useEffect, useRef, useState } from 'react';
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

const WAVEFORM_BARS = [8, 14, 20, 12, 24, 18, 10, 22, 26, 16, 20, 14, 18, 10, 16, 12, 22, 14, 8];

function VoiceBubble({ item, isUser }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const totalDuration = item.duration || 3;
  const timerRef = useRef(null);

  useEffect(() => {
    if (isPlaying) {
      const stepSeconds = 0.1 * speed;
      timerRef.current = setInterval(() => {
        setCurrentTime((prev) => {
          const next = prev + stepSeconds;
          if (next >= totalDuration) {
            setIsPlaying(false);
            return 0;
          }
          return next;
        });
      }, 100);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isPlaying, speed, totalDuration]);

  function togglePlay() {
    setIsPlaying((prev) => !prev);
  }

  function cycleSpeed() {
    setSpeed((prev) => {
      if (prev === 1) return 1.5;
      if (prev === 1.5) return 2;
      return 1;
    });
  }

  function handleScrub(barIndex) {
    const fraction = barIndex / (WAVEFORM_BARS.length - 1);
    const newTime = Math.min(totalDuration, Math.max(0, fraction * totalDuration));
    setCurrentTime(newTime);
  }

  const progressFraction = Math.min(1, currentTime / totalDuration);

  function formatTime(sec) {
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  }

  return (
    <View className="flex-col gap-1 w-64 py-1" testID={`voice-note-${item.id}`}>
      <View className="flex-row items-center gap-2">
        <Pressable
          testID="voice-play-button"
          onPress={togglePlay}
          className={`w-9 h-9 rounded-full items-center justify-center ${isUser ? 'bg-white' : 'bg-green-600'}`}
        >
          <Text className={`text-xs font-bold ${isUser ? 'text-green-600' : 'text-white'}`}>
            {isPlaying ? '⏸' : '▶'}
          </Text>
        </Pressable>

        <View className="flex-1 flex-row items-center justify-between h-8 px-1" testID="waveform-scrubber">
          {WAVEFORM_BARS.map((height, idx) => {
            const barFraction = idx / (WAVEFORM_BARS.length - 1);
            const isPlayed = barFraction <= progressFraction;
            return (
              <Pressable
                key={idx}
                testID={`waveform-bar-${idx}`}
                onPress={() => handleScrub(idx)}
                className="py-1 px-0.5 justify-center"
              >
                <View
                  style={{ height }}
                  className={`w-1 rounded-full ${
                    isPlayed
                      ? isUser ? 'bg-white' : 'bg-green-600'
                      : isUser ? 'bg-green-200' : 'bg-gray-400'
                  }`}
                />
              </Pressable>
            );
          })}
        </View>

        <Pressable
          testID="voice-speed-pill"
          onPress={cycleSpeed}
          className={`px-2 py-1 rounded-full ${isUser ? 'bg-green-600 border border-white' : 'bg-gray-300'}`}
        >
          <Text className={`text-[10px] font-bold ${isUser ? 'text-white' : 'text-gray-800'}`}>
            {speed}x
          </Text>
        </Pressable>
      </View>

      <View className="flex-row justify-between items-center px-1">
        <Text className={`text-[10px] ${isUser ? 'text-green-100' : 'text-gray-600'}`} testID="voice-time-display">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </Text>
        <Text className={`text-[10px] font-medium ${isUser ? 'text-green-100' : 'text-gray-500'}`}>
          WhatsApp Audio Note
        </Text>
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

const SWIPE_REPLY_THRESHOLD = 56;
const MAX_SWIPE_DISTANCE = 96;

/**
 * Normalize a WhatsApp interactive list message out of a bot message, or
 * return null when the message isn't one.
 *
 * Accepted shapes, in order:
 *   - `message.interactive` — the WhatsApp Cloud API payload:
 *     `{ type: 'list', body: { text }, action: { button, sections } }`
 *   - `message.listMessage` — the same thing minus the Cloud API nesting:
 *     `{ body, buttonLabel, sections }`
 *   - `message.text` that *is* one of the above as a JSON string. The sim
 *     pipeline only carries reply strings (see sim.controller.js), so this is
 *     how a list message actually travels through the simulator today.
 *
 * The result is `{ body, buttonLabel, sections: [{ id, title, rows }] }` with
 * every row shaped `{ id, title, description }`. Sections without usable rows
 * are dropped; a list with no rows left is not a list message.
 */
export function parseListMessage(message) {
  if (!message || message.sender !== 'bot') return null;

  let source = null;
  if (message.interactive && typeof message.interactive === 'object') {
    source = message.interactive;
  } else if (message.listMessage && typeof message.listMessage === 'object') {
    source = { type: 'list', ...message.listMessage };
  } else {
    const text = String(message.text || '').trim();
    if (text.startsWith('{') && text.includes('sections')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          source = parsed.interactive && typeof parsed.interactive === 'object'
            ? parsed.interactive
            : parsed;
        }
      } catch {
        return null;
      }
    }
  }
  if (!source || (source.type && source.type !== 'list')) return null;

  const action = source.action && typeof source.action === 'object' ? source.action : source;
  const rawSections = Array.isArray(action.sections) ? action.sections : [];
  const sections = rawSections
    .map((section, sectionIndex) => ({
      id: `section-${sectionIndex}`,
      title: typeof section?.title === 'string' ? section.title : '',
      rows: (Array.isArray(section?.rows) ? section.rows : [])
        .map((row, rowIndex) => ({
          id: String(row?.id || `row-${sectionIndex}-${rowIndex}`),
          title: typeof row?.title === 'string' ? row.title : '',
          description: typeof row?.description === 'string' ? row.description : '',
        }))
        .filter((row) => row.title),
    }))
    .filter((section) => section.rows.length > 0);
  if (sections.length === 0) return null;

  const bodyText =
    typeof source.body === 'string' ? source.body : source.body?.text;
  return {
    body: typeof bodyText === 'string' ? bodyText : '',
    buttonLabel:
      (typeof action.button === 'string' && action.button) ||
      (typeof source.buttonLabel === 'string' && source.buttonLabel) ||
      'Menu',
    sections,
  };
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
function SwipeableBubble({ item, isUser, onReply, darkMode = false }) {
  const isVoice = item.type === 'voice' || item.isVoice;
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

  const hasMeta = Boolean(item.timestamp || (isUser && item.status));

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
          style={darkMode ? { backgroundColor: isUser ? '#005c4b' : '#202c33' } : undefined}
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
          {item.attachment && (
            <View testID="media-card" className="mb-2 rounded-lg overflow-hidden bg-black/10 p-1">
              {item.attachment.type === 'photo' && item.attachment.uri ? (
                <View testID="media-photo-container" className="rounded overflow-hidden">
                  {/* Thumbnail preview */}
                  <img
                    src={item.attachment.uri}
                    alt={item.attachment.name || 'Photo attachment'}
                    style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8 }}
                  />
                </View>
              ) : (
                <View testID="media-doc-container" className="flex-row items-center gap-2 p-2 bg-white/20 rounded">
                  <Text className="text-xl">📄</Text>
                  <View className="flex-1">
                    <Text
                      numberOfLines={1}
                      className={`text-xs font-semibold ${isUser ? 'text-white' : 'text-gray-900'}`}
                    >
                      {item.attachment.name || 'Document'}
                    </Text>
                    {item.attachment.size ? (
                      <Text className={`text-[10px] ${isUser ? 'text-white/80' : 'text-gray-600'}`}>
                        {item.attachment.size}
                      </Text>
                    ) : null}
                  </View>
                </View>
              )}
            </View>
          )}
          {isVoice ? (
            <VoiceBubble item={item} isUser={isUser} />
          ) : (
            Boolean(item.text) && (
              <Text
                style={darkMode ? { color: '#e9edef' } : undefined}
                className={isUser ? 'text-white' : 'text-gray-900'}
              >
                {item.text}
              </Text>
            )
          )}
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

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parses a message timestamp (ISO string or epoch ms). Returns null if unusable. */
function messageDate(message) {
  const raw = message?.timestamp ?? message?.createdAt;
  if (raw === undefined || raw === null || raw === '') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local calendar-day key, e.g. "2026-9-14" (month is zero-based; only used for equality). */
function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Label for a date separator pill: "Today", "Yesterday", or a full date such as
 * "October 14, 2026". Compares local calendar days, not 24h windows.
 */
export function formatDateHeader(date, now = new Date()) {
  if (dayKey(date) === dayKey(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Flattens messages into rows, inserting a date row before the first message of
 * each calendar day. Messages without a valid timestamp never start a new day and
 * get no header of their own.
 */
export function buildRows(messages, now = new Date()) {
  const rows = [];
  let lastKey = null;
  for (const message of messages) {
    const date = messageDate(message);
    if (date) {
      const key = dayKey(date);
      if (key !== lastKey) {
        rows.push({ type: 'date', id: `date-${key}`, label: formatDateHeader(date, now) });
        lastKey = key;
      }
    }
    rows.push({ type: 'message', id: message.id, message });
  }
  return rows;
}

export default function MessageList({
  messages,
  onQuickReply,
  onOpenList,
  disabledReplies = {},
  sending = false,
  onReply,
  now,
  darkMode = false,
}) {
  const rows = buildRows(messages, now);
  const stickyHeaderIndices = rows.reduce((acc, row, i) => (row.type === 'date' ? [...acc, i] : acc), []);

  return (
    <ScrollView
      contentContainerClassName="px-3 py-2 gap-2"
      stickyHeaderIndices={stickyHeaderIndices}
    >
      {rows.map((row) => {
        if (row.type === 'date') {
          return (
            <View key={row.id} testID="date-header" className="items-center py-1">
              <View className="bg-white/90 rounded-full px-3 py-1 shadow-sm border border-gray-200">
                <Text className="text-xs font-medium text-gray-600">{row.label}</Text>
              </View>
            </View>
          );
        }
        const item = row.message;
        const isUser = item.sender === 'user';
        const listMessage = !isUser ? parseListMessage(item) : null;
        // A list message's text is its payload, not a menu to regex-scan.
        const quickReplies = !isUser && !listMessage ? parseQuickReplies(item) : [];
        const isMsgDisabled = Boolean(disabledReplies[item.id]) || sending;

        const bubbleStyle = darkMode
          ? {
              backgroundColor: isUser ? '#005c4b' : '#202c33',
            }
          : undefined;

        const bubbleTextClass = darkMode
          ? 'text-[#e9edef]'
          : isUser
            ? 'text-white'
            : 'text-gray-900';

        return (
          <View key={item.id} className="gap-1.5">
            <View
              testID={`bubble-${item.sender}`}
              style={bubbleStyle}
              className={
                isUser
                  ? 'self-end bg-green-500 rounded-2xl px-3 py-2 max-w-[80%]'
                  : 'self-start bg-gray-200 rounded-2xl px-3 py-2 max-w-[80%]'
              }
            >
              {listMessage ? (
                <View className="gap-1.5">
                  <Text
                    style={darkMode ? { color: '#e9edef' } : undefined}
                    className="text-gray-900"
                  >
                    {listMessage.body || 'Choose an option'}
                  </Text>
                  <View className="border-t border-gray-300" />
                  <Pressable
                    testID={`list-message-button-${item.id}`}
                    accessibilityRole="button"
                    disabled={isMsgDisabled}
                    onPress={() => onOpenList && onOpenList(listMessage, item.id)}
                    className={`flex-row items-center justify-center gap-1.5 py-1 ${
                      isMsgDisabled ? 'opacity-50' : 'active:opacity-70'
                    }`}
                  >
                    <Text className="text-sm font-semibold text-sky-600">
                      ☰ {listMessage.buttonLabel}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text
                  style={darkMode ? { color: '#e9edef' } : undefined}
                  className={bubbleTextClass}
                >
                  {item.text}
                </Text>
              )}
            </View>
            <SwipeableBubble item={item} isUser={isUser} onReply={onReply} darkMode={darkMode} />

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
                      style={
                        darkMode && !isMsgDisabled
                          ? { backgroundColor: '#202c33', borderColor: '#00a884' }
                          : undefined
                      }
                      className={`px-3 py-1.5 rounded-full border shadow-sm ${
                        isMsgDisabled
                          ? isSelected
                            ? 'bg-emerald-600 border-emerald-700 opacity-90'
                            : 'bg-gray-100 border-gray-300 opacity-50'
                          : 'bg-emerald-50 border-emerald-500 active:bg-emerald-100'
                      }`}
                    >
                      <Text
                        style={darkMode && !isMsgDisabled ? { color: '#00a884' } : undefined}
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
