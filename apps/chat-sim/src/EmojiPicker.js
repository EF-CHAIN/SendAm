import { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

// A small local catalogue keeps the simulator offline and dependency-free.
const CATEGORIES = [
  { name: 'Smileys', entries: [
    ['😀', 'Grinning face', 'happy smile'], ['😊', 'Smiling face', 'happy blush'],
    ['😂', 'Face with tears of joy', 'laugh funny'], ['😍', 'Heart eyes', 'love'],
    ['😎', 'Sunglasses face', 'cool'], ['🤔', 'Thinking face', 'hmm'],
    ['😢', 'Crying face', 'sad'], ['😭', 'Loudly crying face', 'sad'],
    ['👍', 'Thumbs up', 'yes okay approve'], ['👎', 'Thumbs down', 'no reject'],
    ['👋', 'Waving hand', 'hello goodbye'], ['🙏', 'Folded hands', 'thanks please'],
  ] },
  { name: 'Currency', entries: [
    ['💵', 'Dollar banknote', 'usd money cash'], ['💷', 'Pound banknote', 'gbp money cash'],
    ['💶', 'Euro banknote', 'eur money cash'], ['💴', 'Yen banknote', 'jpy money cash'],
    ['💰', 'Money bag', 'cash savings'], ['💸', 'Money with wings', 'send payment'],
    ['💳', 'Credit card', 'pay bank'], ['🪙', 'Coin', 'money change'],
    ['₦', 'Naira symbol', 'ngn nigeria currency'], ['$', 'Dollar symbol', 'usd currency'],
    ['€', 'Euro symbol', 'eur currency'], ['£', 'Pound symbol', 'gbp currency'],
    ['¥', 'Yen symbol', 'jpy currency'], ['₵', 'Cedi symbol', 'ghs ghana currency'],
  ] },
  { name: 'Flags', entries: [
    ['🇳🇬', 'Nigeria flag', 'ng nigerian'], ['🇬🇭', 'Ghana flag', 'gh ghanaian'],
    ['🇰🇪', 'Kenya flag', 'ke kenyan'], ['🇿🇦', 'South Africa flag', 'za south african'],
    ['🇺🇬', 'Uganda flag', 'ug ugandan'], ['🇹🇿', 'Tanzania flag', 'tz tanzanian'],
    ['🇷🇼', 'Rwanda flag', 'rw rwandan'], ['🇸🇳', 'Senegal flag', 'sn senegalese'],
    ['🇺🇸', 'United States flag', 'us usa american'], ['🇬🇧', 'United Kingdom flag', 'gb uk british'],
    ['🇪🇺', 'European Union flag', 'eu europe'], ['🇨🇦', 'Canada flag', 'ca canadian'],
  ] },
];

export default function EmojiPicker({ onSelect, onClose, bottom, maxHeight }) {
  const [category, setCategory] = useState('Smileys');
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const search = query.trim().toLowerCase();
  const entries = (search ? CATEGORIES : CATEGORIES.filter(group => group.name === category))
    .flatMap(group => group.entries)
    .filter(entry => !search || entry.join(' ').toLowerCase().includes(search));

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    const escape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    // React Native Web's TextInput stops bubbling keyboard events.
    if (Platform.OS === 'web') document.addEventListener('keydown', escape, true);
    return () => {
      back.remove();
      if (Platform.OS === 'web') document.removeEventListener('keydown', escape, true);
    };
  }, [onClose]);

  return (
    <View
      testID="emoji-picker"
      {...(Platform.OS === 'web' ? { role: 'dialog', 'aria-label': 'Emoji picker' } : {})}
      className="bg-white border border-gray-300 rounded-xl"
      style={{ position: 'absolute', bottom, left: 12, right: 12, maxWidth: 360, maxHeight, marginBottom: 8, elevation: 8, zIndex: 3 }}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12 }}>
        <View className="flex-row items-center justify-between mb-2">
          <Text className="font-semibold text-gray-900">Emoji picker</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close emoji picker" onPress={onClose}
            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text className="text-gray-600 text-xl">×</Text>
          </Pressable>
        </View>
        <TextInput ref={searchRef} accessibilityLabel="Search emojis" placeholder="Search all emojis"
          value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none"
          className="border border-gray-300 rounded-lg px-3 py-2 text-base mb-2" />
        <View accessibilityRole="tablist" className="flex-row gap-1 mb-2">
          {CATEGORIES.map(group => (
            <Pressable key={group.name} accessibilityRole="tab" accessibilityLabel={group.name}
              accessibilityState={{ selected: !search && group.name === category }}
              onPress={() => { setCategory(group.name); setQuery(''); }}
              className={`flex-1 rounded-lg items-center justify-center ${!search && group.name === category ? 'bg-green-100' : 'bg-gray-100'}`}
              style={{ minHeight: 44 }}>
              <Text className="text-sm font-semibold text-gray-800">{group.name}</Text>
            </Pressable>
          ))}
        </View>
        <View className="flex-row flex-wrap">
          {entries.map(([emoji, name]) => (
            <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`Insert ${name}`}
              onPress={() => onSelect(emoji)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 24 }}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
        {entries.length === 0 && <Text accessibilityLiveRegion="polite" className="text-gray-600 py-4">No emojis found</Text>}
      </ScrollView>
    </View>
  );
}
