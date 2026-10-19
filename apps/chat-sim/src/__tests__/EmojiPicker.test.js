import { act, create } from 'react-test-renderer';
import { BackHandler } from 'react-native';
import ChatScreen from '../ChatScreen';
import EmojiPicker from '../EmojiPicker';

jest.mock('../usePolling', () => () => {});
jest.mock('../MessageList', () => () => null);
jest.mock('../engine/voiceService', () => ({
  voiceService: { speak: jest.fn(), isSpeechRecognitionSupported: () => false },
}));

let renderer;
const byLabel = label => renderer.root.findByProps({ accessibilityLabel: label });
const press = async label => { await act(async () => byLabel(label).props.onPress()); };
const pickerIsOpen = () => renderer.root.findAllByType(EmojiPicker).length > 0;

beforeEach(async () => {
  await act(async () => { renderer = create(<ChatScreen />); });
  await act(async () => renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onChangeText('+2348000000001'));
  await act(async () => renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onSubmitEditing());
});
afterEach(async () => { await act(async () => renderer.unmount()); jest.restoreAllMocks(); });

async function draft(text, start = text.length, end = start) {
  await act(async () => byLabel('Message').props.onChangeText(text));
  await act(async () => byLabel('Message').props.onSelectionChange({ nativeEvent: { selection: { start, end } } }));
}

it('toggles the popover and switches between the three categories', async () => {
  expect(pickerIsOpen()).toBe(false);
  await press('Choose emoji');
  expect(pickerIsOpen()).toBe(true);
  expect(byLabel('Smileys').props.accessibilityState.selected).toBe(true);
  expect(byLabel('Insert Thumbs up')).toBeTruthy();
  await press('Currency');
  expect(byLabel('Insert Dollar banknote')).toBeTruthy();
  expect(byLabel('Insert Naira symbol')).toBeTruthy();
  await press('Flags');
  expect(byLabel('Insert Nigeria flag')).toBeTruthy();
  await press('Choose emoji');
  expect(pickerIsOpen()).toBe(false);
});

it('searches all categories by name, keyword or symbol and shows an empty state', async () => {
  await press('Choose emoji');
  for (const [query, result] of [[' NIGERIA ', 'Nigeria flag'], ['cash', 'Dollar banknote'], ['👍', 'Thumbs up']]) {
    await act(async () => byLabel('Search emojis').props.onChangeText(query));
    expect(byLabel(`Insert ${result}`)).toBeTruthy();
  }
  await act(async () => byLabel('Search emojis').props.onChangeText('nothing-matches'));
  expect(renderer.root.findAll(node => node.props.children === 'No emojis found').length).toBeGreaterThan(0);
  await press('Flags');
  expect(byLabel('Search emojis').props.value).toBe('');
  expect(byLabel('Insert Nigeria flag')).toBeTruthy();
});

it.each([
  ['', 0, 0, '👍'], ['hello', 0, 0, '👍hello'],
  ['hello', 2, 2, 'he👍llo'], ['hello', 5, 5, 'hello👍'],
  ['hello', 1, 4, 'h👍o'],
])('inserts at the selected range in %p (%i, %i)', async (text, start, end, expected) => {
  await draft(text, start, end);
  await press('Choose emoji');
  await press('Insert Thumbs up');
  expect(byLabel('Message').props.value).toBe(expected);
  expect(byLabel('Message').props.selection).toEqual({ start: start + '👍'.length, end: start + '👍'.length });
  expect(pickerIsOpen()).toBe(false);
});

it('preserves the message selection while searching and advances past an entire flag', async () => {
  await draft('pay here', 4, 8);
  await press('Choose emoji');
  await act(async () => byLabel('Search emojis').props.onChangeText('nigeria'));
  await press('Insert Nigeria flag');
  expect(byLabel('Message').props.value).toBe('pay 🇳🇬');
  expect(byLabel('Message').props.selection).toEqual({ start: 8, end: 8 });
  await press('Choose emoji');
  await press('Currency');
  await press('Insert Dollar banknote');
  expect(byLabel('Message').props.value).toBe('pay 🇳🇬💵');
});

it('dismisses without changing the draft via close, outside press and Android back', async () => {
  await draft('keep me', 3);
  await press('Choose emoji');
  await press('Close emoji picker');
  expect(pickerIsOpen()).toBe(false);
  await press('Choose emoji');
  await press('Dismiss emoji picker');
  expect(pickerIsOpen()).toBe(false);
  const remove = jest.fn();
  const back = jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove });
  await press('Choose emoji');
  await act(async () => expect(back.mock.calls.at(-1)[1]()).toBe(true));
  expect(pickerIsOpen()).toBe(false);
  expect(remove).toHaveBeenCalled();
  expect(byLabel('Message').props.value).toBe('keep me');
});

it('clears the picker and selection when switching accounts', async () => {
  await draft('old draft');
  await press('Choose emoji');
  await act(async () => renderer.root.findByProps({ testID: 'reset-session-button' }).props.onPress());
  expect(pickerIsOpen()).toBe(false);
  await act(async () => renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onChangeText('+2348000000002'));
  await act(async () => renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onSubmitEditing());
  expect(byLabel('Message').props.value).toBe('');
  expect(byLabel('Message').props.selection).toEqual({ start: 0, end: 0 });
});

it('sends the inserted emoji and disables the picker while the request is pending', async () => {
  let finish;
  const originalFetch = global.fetch;
  global.fetch = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  try {
    await draft('hello ');
    await press('Choose emoji');
    await press('Insert Thumbs up');
    await act(async () => { renderer.root.findByProps({ testID: 'send-button' }).props.onPress(); });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).text).toBe('hello 👍');
    expect(byLabel('Choose emoji').props.disabled).toBe(true);
    expect(byLabel('Message').props.value).toBe('');
    await act(async () => finish({ ok: true, json: async () => ({ replies: [] }) }));
    expect(byLabel('Choose emoji').props.disabled).toBe(false);
  } finally { global.fetch = originalFetch; }
});
