import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

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
        {/* Play/Pause Button */}
        <Pressable
          testID="voice-play-button"
          onPress={togglePlay}
          className={`w-9 h-9 rounded-full items-center justify-center ${isUser ? 'bg-white' : 'bg-green-600'}`}
        >
          <Text className={`text-xs font-bold ${isUser ? 'text-green-600' : 'text-white'}`}>
            {isPlaying ? '⏸' : '▶'}
          </Text>
        </Pressable>

        {/* Waveform Scrubber */}
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

        {/* Playback Speed Pill */}
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

      {/* Timestamp & Indicator */}
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

export default function MessageList({ messages }) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
        const isVoice = item.type === 'voice' || item.isVoice;
        return (
          <View
            key={item.id}
            testID={`bubble-${item.sender}`}
            className={
              isUser
                ? 'self-end bg-green-500 rounded-2xl px-3 py-2 max-w-[85%]'
                : 'self-start bg-gray-200 rounded-2xl px-3 py-2 max-w-[85%]'
            }
          >
            {isVoice ? (
              <VoiceBubble item={item} isUser={isUser} />
            ) : (
              <Text className={isUser ? 'text-white' : 'text-gray-900'}>{item.text}</Text>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
