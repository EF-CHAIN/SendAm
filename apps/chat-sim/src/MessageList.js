import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import MessageCopyButton from './MessageCopyButton';

function MessageBubble({ item, hoverOnly }) {
  const isUser = item.sender === 'user';
  const [hovered, setHovered] = useState(false);
  return (
    <View
      testID={`bubble-${item.sender}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={
        isUser
          ? 'self-end bg-green-500 rounded-2xl px-3 py-2 max-w-[80%]'
          : 'self-start bg-gray-200 rounded-2xl px-3 py-2 max-w-[80%]'
      }
    >
      <View className="flex-row items-start gap-2">
        <Text
          className={isUser ? 'text-white' : 'text-gray-900'}
          style={{ flexShrink: 1, minWidth: 0, paddingTop: 12 }}
        >
          {item.text}
        </Text>
        <MessageCopyButton text={item.text} isUser={isUser} visible={!hoverOnly || hovered} />
      </View>
    </View>
  );
}

export default function MessageList({ messages }) {
  const [hoverOnly, setHoverOnly] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setHoverOnly(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => <MessageBubble key={item.id} item={item} hoverOnly={hoverOnly} />)}
    </ScrollView>
  );
}
