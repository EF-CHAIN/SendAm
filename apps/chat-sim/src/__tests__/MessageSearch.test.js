import { act, create } from 'react-test-renderer';
import ChatScreen from '../ChatScreen';
import MessageList, { findMessageMatches, splitForHighlight } from '../MessageList';
import usePolling from '../usePolling';

jest.mock('../usePolling', () => jest.fn());

const MESSAGES = [
  { id: 'm1', sender: 'user', text: 'send 5 xlm to +234', timestamp: '2026-10-22T10:00:00Z' },
  { id: 'm2', sender: 'bot', text: 'Transaction confirmed: TX-991', timestamp: '2026-10-22T10:00:01Z' },
  { id: 'm3', sender: 'user', text: 'balance', timestamp: '2026-10-22T10:00:02Z' },
  { id: 'm4', sender: 'bot', text: 'Second transaction pending', timestamp: '2026-10-22T10:00:03Z' },
];

describe('search helpers (#786)', () => {
  it('finds matching message ids case-insensitively, in order', () => {
    expect(findMessageMatches(MESSAGES, 'TRANSACTION')).toEqual(['m2', 'm4']);
    expect(findMessageMatches(MESSAGES, 'tx-991')).toEqual(['m2']);
    expect(findMessageMatches(MESSAGES, '')).toEqual([]);
    expect(findMessageMatches(MESSAGES, '  ')).toEqual([]);
    expect(findMessageMatches(MESSAGES, 'nothing-here')).toEqual([]);
  });

  it('splits text into highlightable segments around every occurrence', () => {
    expect(splitForHighlight('Transaction confirmed: TX-991', 'transaction')).toEqual([
      { text: 'Transaction', match: true },
      { text: ' confirmed: TX-991', match: false },
    ]);
    expect(splitForHighlight('aXbXc', 'x')).toEqual([
      { text: 'a', match: false },
      { text: 'X', match: true },
      { text: 'b', match: false },
      { text: 'X', match: true },
      { text: 'c', match: false },
    ]);
    expect(splitForHighlight('plain', '')).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('MessageList highlighting (#786)', () => {
  it('marks matched segments yellow and the active match distinctly', async () => {
    let renderer;
    await act(async () => {
      renderer = create(
        <MessageList messages={MESSAGES} searchQuery="transaction" activeMatchId="m2" />
      );
    });
    const root = renderer.root;
    const active = root.findAllByProps({ testID: 'match-active' });
    const passive = root.findAllByProps({ testID: 'match' });
    expect(active.length).toBeGreaterThan(0);
    expect(passive.length).toBeGreaterThan(0);
    expect(active[0].props.style.backgroundColor).toBe('#facc15');
    expect(passive[0].props.style.backgroundColor).toBe('#fde047');
    expect(root.findAllByProps({ testID: 'active-match-row-m2' }).length).toBeGreaterThan(0);
  });

  it('renders no highlights without a query', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={MESSAGES} />);
    });
    expect(renderer.root.findAllByProps({ testID: 'match' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'match-active' })).toHaveLength(0);
  });
});

describe('ChatScreen search bar (#786)', () => {
  async function renderWithMessages() {
    let setMessagesFromPolling;
    usePolling.mockImplementation((phoneNumber, setMessages) => {
      if (phoneNumber) setMessagesFromPolling = setMessages;
    });
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });
    const phoneInput = renderer.root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });
    await act(async () => {
      renderer.root.findByProps({ placeholder: '+2348000000001' }).props.onSubmitEditing();
    });
    await act(async () => {
      setMessagesFromPolling(() => MESSAGES);
    });
    return renderer;
  }

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ replies: [] }) });
  });
  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  it('shows the counter and walks matches with Up/Down, wrapping at the ends', async () => {
    const renderer = await renderWithMessages();
    const root = renderer.root;

    expect(root.findAllByProps({ testID: 'search-bar' })).toHaveLength(0);
    await act(async () => {
      root.findByProps({ testID: 'search-toggle-button' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'search-input' }).props.onChangeText('transaction');
    });

    const counterText = () =>
      root.findByProps({ testID: 'search-counter' }).props.children;
    expect(counterText()).toBe('1 of 2');
    // The first match is active in the list.
    expect(root.findAllByProps({ testID: 'active-match-row-m2' }).length).toBeGreaterThan(0);

    await act(async () => {
      root.findByProps({ testID: 'search-down-button' }).props.onPress();
    });
    expect(counterText()).toBe('2 of 2');
    expect(root.findAllByProps({ testID: 'active-match-row-m4' }).length).toBeGreaterThan(0);

    // Down past the last wraps to the first; Up from the first wraps to the last.
    await act(async () => {
      root.findByProps({ testID: 'search-down-button' }).props.onPress();
    });
    expect(counterText()).toBe('1 of 2');
    await act(async () => {
      root.findByProps({ testID: 'search-up-button' }).props.onPress();
    });
    expect(counterText()).toBe('2 of 2');
  });

  it('says No matches, and close clears the query and highlights', async () => {
    const renderer = await renderWithMessages();
    const root = renderer.root;
    await act(async () => {
      root.findByProps({ testID: 'search-toggle-button' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'search-input' }).props.onChangeText('zzz-not-there');
    });
    expect(root.findByProps({ testID: 'search-counter' }).props.children).toBe('No matches');
    expect(root.findByProps({ testID: 'search-up-button' }).props.disabled).toBe(true);

    await act(async () => {
      root.findByProps({ testID: 'search-close-button' }).props.onPress();
    });
    expect(root.findAllByProps({ testID: 'search-bar' })).toHaveLength(0);
    expect(root.findAllByProps({ testID: 'match' })).toHaveLength(0);
  });
});
