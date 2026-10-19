import { act, create } from 'react-test-renderer';
import MessageCopyButton from '../MessageCopyButton';
import * as Clipboard from 'expo-clipboard';
import MessageList, { parseQuickReplies } from '../MessageList';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));

const fixedMessages = [
  { id: '1', text: 'balance', sender: 'user' },
  { id: '2', text: 'Your SendAm balances: 10 XLM', sender: 'bot' },
  { id: '3', text: 'send 5 xlm +2348000000002', sender: 'user' },
];

describe('MessageList', () => {
  it('renders inbound and outbound bubbles with the right alignment', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={fixedMessages} />);
    });
    const tree = renderer.toJSON();
    const flatList = Array.isArray(tree) ? tree[0] : tree;
    const bubbleTestIds = [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.props?.testID?.startsWith('bubble-')) {
        bubbleTestIds.push(node.props.testID);
      }
      (node.children ?? []).forEach(walk);
    }
    walk(flatList);

    expect(bubbleTestIds).toEqual(['bubble-user', 'bubble-bot', 'bubble-user']);
  });

  it('parses quick-reply options from bot message text', () => {
    const botMsg = {
      id: 'bot-1',
      sender: 'bot',
      text: 'Please select an option:\n1: Check Balance\n2: Send Money',
    };
    const replies = parseQuickReplies(botMsg);
    expect(replies).toHaveLength(2);
    expect(replies[0].label).toBe('1: Check Balance');
    expect(replies[0].payload).toBe('1: Check Balance');
    expect(replies[1].label).toBe('2: Send Money');
  });

  it('renders interactive pill buttons and invokes onQuickReply', async () => {
    let clickedPayload = null;
    const botMsg = {
      id: 'bot-1',
      sender: 'bot',
      text: 'Options:\n1: Check Balance\n2: Send Money',
    };
    let renderer;
    await act(async () => {
      renderer = create(
        <MessageList
          messages={[botMsg]}
          onQuickReply={(payload) => {
            clickedPayload = payload;
          }}
          disabledReplies={{}}
        />
      );
    });

    const root = renderer.root;
    const button0 = root.findByProps({ testID: 'quick-reply-0' });
    expect(button0).toBeDefined();

    await act(async () => {
      button0.props.onPress();
    });

    expect(clickedPayload).toBe('1: Check Balance');
  });
});


it('provides independent copy actions for both user and bot messages', async () => {
  let renderer;
  await act(async () => { renderer = create(<MessageList messages={fixedMessages} />); });
  const copies = renderer.root.findAllByType(MessageCopyButton);
  expect(copies.map((copy) => copy.props.text)).toEqual(fixedMessages.map((message) => message.text));
  const buttons = copies.map((copy) => copy.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0]);
  await act(async () => { await buttons[0].props.onPress(); });
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(fixedMessages[0].text);
  expect(buttons[0].props.accessibilityLabel).toBe('Message copied');
  expect(buttons[1].props.accessibilityLabel).toBe('Copy message');
  await act(async () => { await buttons[1].props.onPress(); });
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(fixedMessages[1].text);
  expect(buttons[0].props.accessibilityLabel).toBe('Message copied');
  expect(buttons[1].props.accessibilityLabel).toBe('Message copied');
  act(() => renderer.unmount());
});


it('allows long unbroken message text to shrink alongside the copy action', async () => {
  let renderer;
  const text = 'G'.repeat(56);
  await act(async () => { renderer = create(<MessageList messages={[{ id: 'long', text, sender: 'bot' }]} />); });
  const messageText = renderer.root.findAll((node) => node.props.children === text && node.props.style?.flexShrink === 1)[0];
  expect(messageText.props.style.minWidth).toBe(0);
  act(() => renderer.unmount());
});


it.each([
  { disabledReplies: { menu: '1: Balance' }, sending: false },
  { disabledReplies: {}, sending: true },
])('keeps copy independent when quick replies are disabled: %j', async (state) => {
  const text = 'Options:\n1: Balance\n2: Deposit';
  const onQuickReply = jest.fn();
  let renderer;
  await act(async () => {
    renderer = create(<MessageList messages={[{ id: 'menu', sender: 'bot', text }]}
      onQuickReply={onQuickReply} {...state} />);
  });
  expect(renderer.root.findByProps({ testID: 'quick-reply-0' }).props.disabled).toBe(true);
  const copy = renderer.root.findByType(MessageCopyButton);
  const button = copy.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0];
  await act(async () => { await button.props.onPress(); });
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(text);
  expect(button.props.accessibilityLabel).toBe('Message copied');
  expect(onQuickReply).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
