import { act, create } from 'react-test-renderer';
import { ScrollView } from 'react-native';
import MessageList, { buildRows, formatDateHeader } from '../MessageList';

// Local noon avoids timezone edge cases around midnight.
const at = (y, m, d, h = 12) => new Date(y, m, d, h, 0, 0).toISOString();
const NOW = new Date(2026, 9, 20, 15, 0, 0); // 20 Oct 2026

describe('formatDateHeader', () => {
  it('labels the current calendar day as Today', () => {
    expect(formatDateHeader(new Date(2026, 9, 20, 0, 5), NOW)).toBe('Today');
    expect(formatDateHeader(new Date(2026, 9, 20, 23, 59), NOW)).toBe('Today');
  });

  it('labels the previous calendar day as Yesterday, even less than 24h ago', () => {
    const justAfterMidnight = new Date(2026, 9, 20, 0, 30);
    expect(formatDateHeader(new Date(2026, 9, 19, 23, 50), justAfterMidnight)).toBe('Yesterday');
  });

  it('uses a full date for older days', () => {
    expect(formatDateHeader(new Date(2026, 9, 14, 12), NOW)).toBe('October 14, 2026');
    expect(formatDateHeader(new Date(2025, 11, 31, 12), NOW)).toBe('December 31, 2025');
  });

  it('handles month boundaries when computing Yesterday', () => {
    const firstOfMonth = new Date(2026, 10, 1, 9);
    expect(formatDateHeader(new Date(2026, 9, 31, 20), firstOfMonth)).toBe('Yesterday');
  });
});

describe('buildRows', () => {
  it('inserts one header per calendar day, before that day\'s first message', () => {
    const messages = [
      { id: 'a', sender: 'user', text: 'old', timestamp: at(2026, 9, 14, 9) },
      { id: 'b', sender: 'bot', text: 'old reply', timestamp: at(2026, 9, 14, 10) },
      { id: 'c', sender: 'user', text: 'yesterday', timestamp: at(2026, 9, 19) },
      { id: 'd', sender: 'user', text: 'today', timestamp: at(2026, 9, 20, 9) },
      { id: 'e', sender: 'bot', text: 'today reply', timestamp: at(2026, 9, 20, 10) },
    ];
    const rows = buildRows(messages, NOW);
    expect(rows.map((r) => (r.type === 'date' ? r.label : r.id))).toEqual([
      'October 14, 2026', 'a', 'b',
      'Yesterday', 'c',
      'Today', 'd', 'e',
    ]);
  });

  it('accepts createdAt and epoch-millisecond timestamps', () => {
    const rows = buildRows(
      [
        { id: 'a', sender: 'bot', text: 'x', createdAt: at(2026, 9, 19) },
        { id: 'b', sender: 'bot', text: 'y', timestamp: new Date(2026, 9, 20, 9).getTime() },
      ],
      NOW
    );
    expect(rows.filter((r) => r.type === 'date').map((r) => r.label)).toEqual(['Yesterday', 'Today']);
  });

  it('adds no headers for messages without a usable timestamp', () => {
    const rows = buildRows(
      [
        { id: 'a', sender: 'user', text: 'no ts' },
        { id: 'b', sender: 'bot', text: 'bad ts', timestamp: 'not-a-date' },
      ],
      NOW
    );
    expect(rows.every((r) => r.type === 'message')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('does not repeat a header when an untimed message sits between same-day messages', () => {
    const rows = buildRows(
      [
        { id: 'a', sender: 'user', text: '1', timestamp: at(2026, 9, 20, 9) },
        { id: 'b', sender: 'bot', text: 'untimed' },
        { id: 'c', sender: 'user', text: '2', timestamp: at(2026, 9, 20, 11) },
      ],
      NOW
    );
    expect(rows.filter((r) => r.type === 'date')).toHaveLength(1);
  });
});

describe('MessageList date headers', () => {
  const collect = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    (node.children ?? []).forEach((child) => collect(child, predicate, out));
    return out;
  };

  const textOf = (node) =>
    (node.children ?? []).map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

  it('renders a pill per day and marks them as sticky headers', async () => {
    const messages = [
      { id: 'a', sender: 'user', text: 'old', timestamp: at(2026, 9, 14) },
      { id: 'b', sender: 'bot', text: 'yesterday', timestamp: at(2026, 9, 19) },
      { id: 'c', sender: 'user', text: 'today', timestamp: at(2026, 9, 20, 9) },
    ];
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={messages} now={NOW} />);
    });

    const pills = collect(renderer.toJSON(), (n) => n.props?.testID === 'date-header').map(textOf);
    expect(pills).toEqual(['October 14, 2026', 'Yesterday', 'Today']);

    const scroll = renderer.root.findByType(ScrollView);
    expect(scroll.props.stickyHeaderIndices).toEqual([0, 2, 4]);
  });

  it('renders no pills for the existing timestamp-less messages', async () => {
    let renderer;
    await act(async () => {
      renderer = create(
        <MessageList
          messages={[
            { id: '1', text: 'balance', sender: 'user' },
            { id: '2', text: 'ok', sender: 'bot' },
          ]}
        />
      );
    });
    expect(collect(renderer.toJSON(), (n) => n.props?.testID === 'date-header')).toHaveLength(0);
  });
});
