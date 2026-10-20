import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, ScrollView, Text, View } from 'react-native';

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

export default function MessageList({ messages }) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
        const hasMeta = Boolean(item.timestamp || (isUser && item.status));

        return (
          <View
            key={item.id}
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
                    {item.timestamp}
                  </Text>
                ) : null}
                {isUser && item.status ? <ReceiptStatus status={item.status} /> : null}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
