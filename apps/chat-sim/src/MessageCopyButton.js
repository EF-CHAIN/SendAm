import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, Text, View } from 'react-native';
import { copyMessageText } from './copyMessageText';

export default function MessageCopyButton({ text, isUser, visible = true }) {
  const [status, setStatus] = useState('idle');
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const timer = useRef(null);
  const request = useRef(0);
  const opacity = useRef(new Animated.Value(1)).current;
  const animation = useRef(null);
  const reduceMotion = useRef(true);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) reduceMotion.current = enabled;
    }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      reduceMotion.current = enabled;
      if (enabled) {
        animation.current?.stop();
        opacity.setValue(1);
      }
    });
    return () => { active = false; subscription.remove(); };
  }, [opacity]);

  useEffect(() => {
    opacity.setValue(1);
    setStatus('idle');
    return () => {
      // Ignore clipboard promises for a removed or changed message.
      request.current += 1;
      clearTimeout(timer.current);
      animation.current?.stop();
    };
  }, [text, opacity]);

  async function copyMessage() {
    const currentRequest = ++request.current;
    clearTimeout(timer.current);
    animation.current?.stop();
    opacity.setValue(1);
    setStatus('pending');
    try {
      await copyMessageText(text);
      if (request.current !== currentRequest) return;
      setStatus('copied');
      if (!reduceMotion.current) {
        opacity.setValue(0);
        animation.current = Animated.timing(opacity, {
          toValue: 1, duration: 120, useNativeDriver: true,
        });
        animation.current.start();
      }
      timer.current = setTimeout(() => setStatus('idle'), 1000);
    } catch {
      if (request.current === currentRequest) setStatus('error');
    }
  }

  const label = status === 'copied'
    ? 'Message copied'
    : status === 'error' ? 'Copy failed. Try again' : 'Copy message';

  return (
    <View className="self-end">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Copies the full message text to your clipboard"
        onPress={copyMessage}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={{
          borderRadius: 8,
          opacity: visible || focused || status !== 'idle' ? 1 : 0,
          minWidth: 44,
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: focused ? (isUser ? '#14532d' : '#166534') : 'transparent',
          backgroundColor: hovered || pressed ? (isUser ? '#bbf7d0' : '#d1d5db') : 'transparent',
        }}
      >
        <Animated.Text
          accessible={false}
          style={{ opacity, fontSize: 22, color: isUser ? '#14532d' : '#1f2937' }}
        >
          {status === 'copied' ? '✓' : '⧉'}
        </Animated.Text>
      </Pressable>
      <Text
        accessibilityLiveRegion="polite"
        style={{ minHeight: 16 }}
        className={isUser ? 'text-green-950 text-xs' : 'text-gray-900 text-xs'}
      >
        {status === 'error' ? 'Copy failed. Try again.' : status === 'copied' ? 'Copied!' : ''}
      </Text>
    </View>
  );
}
