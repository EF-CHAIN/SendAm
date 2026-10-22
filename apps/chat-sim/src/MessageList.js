import { Pressable, ScrollView, Text, View } from 'react-native';

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
              {Boolean(item.text) && (
                <Text className={isUser ? 'text-white' : 'text-gray-900'}>{item.text}</Text>
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

