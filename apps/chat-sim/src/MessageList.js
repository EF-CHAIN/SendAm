import { ScrollView, Text, View } from 'react-native';

export default function MessageList({ messages }) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
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
          </View>
        );
      })}
    </ScrollView>
  );
}
