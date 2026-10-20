import { act, create } from 'react-test-renderer';
import MessageList, { parseQuickReplies } from '../MessageList';

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

