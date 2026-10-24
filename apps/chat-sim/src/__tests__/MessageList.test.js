import { act, create } from 'react-test-renderer';
import MessageList, { parseListMessage, parseQuickReplies } from '../MessageList';

const fixedMessages = [
  { id: '1', text: 'balance', sender: 'user' },
  { id: '2', text: 'Your SendAm balances: 10 XLM', sender: 'bot' },
  { id: '3', text: 'send 5 xlm +2348000000002', sender: 'user' },
  {
    id: '4',
    sender: 'user',
    type: 'voice',
    isVoice: true,
    duration: 5,
    text: '🎤 Voice note (0:05)',
  },
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

    expect(bubbleTestIds).toEqual([
      'bubble-user',
      'bubble-bot',
      'bubble-user',
      'bubble-user',
    ]);
  });

  it('renders interactive voice note bubble with play button, waveform scrubber, and speed pill', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={[fixedMessages[3]]} />);
    });
    const root = renderer.root;

    // Verify play button exists
    const playBtn = root.findByProps({ testID: 'voice-play-button' });
    expect(playBtn).toBeTruthy();

    // Verify waveform scrubber exists and has scrubber bars
    const scrubber = root.findByProps({ testID: 'waveform-scrubber' });
    expect(scrubber).toBeTruthy();

    // Verify speed toggle pill exists and cycles 1x -> 1.5x -> 2x -> 1x
    const speedPill = root.findByProps({ testID: 'voice-speed-pill' });
    expect(speedPill).toBeTruthy();

    await act(async () => {
      speedPill.props.onPress();
    });
    const speedPill15 = root.findByProps({ testID: 'voice-speed-pill' });
    expect(JSON.stringify(speedPill15)).toContain('1.5x');

    await act(async () => {
      speedPill15.props.onPress();
    });
    const speedPill20 = root.findByProps({ testID: 'voice-speed-pill' });
    expect(JSON.stringify(speedPill20)).toContain('2x');

    await act(async () => {
      speedPill20.props.onPress();
    });
    const speedPill10 = root.findByProps({ testID: 'voice-speed-pill' });
    expect(JSON.stringify(speedPill10)).toContain('1x');

    // Test scrubbing on a waveform bar
    const bar = root.findByProps({ testID: 'waveform-bar-5' });
    await act(async () => {
      bar.props.onPress();
    });
    const timeDisplay = root.findByProps({ testID: 'voice-time-display' });
    expect(timeDisplay).toBeTruthy();
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

describe('parseListMessage', () => {
  const cloudApiPayload = {
    type: 'list',
    body: { text: 'What would you like to do?' },
    action: {
      button: 'Main menu',
      sections: [
        {
          title: 'Payments',
          rows: [
            { id: 'send', title: 'Send money', description: 'Send XLM to a phone number' },
            { id: 'balance', title: 'Check balance' },
          ],
        },
        {
          title: 'Account',
          rows: [{ id: 'history', title: 'Transaction history', description: 'Last 10 payments' }],
        },
      ],
    },
  };

  it('normalizes a Cloud API interactive payload on the message', () => {
    const list = parseListMessage({ id: 'b1', sender: 'bot', interactive: cloudApiPayload });
    expect(list.body).toBe('What would you like to do?');
    expect(list.buttonLabel).toBe('Main menu');
    expect(list.sections).toHaveLength(2);
    expect(list.sections[0].title).toBe('Payments');
    expect(list.sections[0].rows[0]).toEqual({
      id: 'send',
      title: 'Send money',
      description: 'Send XLM to a phone number',
    });
    expect(list.sections[0].rows[1].description).toBe('');
  });

  it('parses the same payload carried as a JSON reply string', () => {
    const list = parseListMessage({
      id: 'b1',
      sender: 'bot',
      text: JSON.stringify(cloudApiPayload),
    });
    expect(list).not.toBeNull();
    expect(list.buttonLabel).toBe('Main menu');
    expect(list.sections[1].rows[0].id).toBe('history');
  });

  it('returns null for user messages, plain text and empty lists', () => {
    expect(parseListMessage({ id: 'u1', sender: 'user', interactive: cloudApiPayload })).toBeNull();
    expect(parseListMessage({ id: 'b1', sender: 'bot', text: 'hello' })).toBeNull();
    expect(parseListMessage({ id: 'b1', sender: 'bot', text: '{"not":"json' })).toBeNull();
    expect(
      parseListMessage({
        id: 'b1',
        sender: 'bot',
        interactive: { type: 'list', action: { button: 'Menu', sections: [{ title: 'x', rows: [] }] } },
      })
    ).toBeNull();
  });

  it('renders a list bubble with the menu opener instead of raw JSON', async () => {
    const opened = [];
    const botMsg = { id: 'b1', sender: 'bot', text: JSON.stringify(cloudApiPayload) };
    let renderer;
    await act(async () => {
      renderer = create(
        <MessageList messages={[botMsg]} onOpenList={(list, id) => opened.push([list, id])} />
      );
    });

    const root = renderer.root;
    const opener = root.findByProps({ testID: 'list-message-button-b1' });
    await act(async () => {
      opener.props.onPress();
    });

    expect(opened).toHaveLength(1);
    expect(opened[0][0].buttonLabel).toBe('Main menu');
    expect(opened[0][1]).toBe('b1');
    // The bubble shows the body text, never the JSON payload.
    expect(JSON.stringify(renderer.toJSON())).not.toContain('"sections"');
    // And its JSON text must not leak numbered quick-reply pills.
    expect(root.findAllByProps({ testID: 'quick-replies-container' })).toHaveLength(0);
  });
});

function findByTestID(tree, testID) {
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const found = findByTestID(node, testID);
      if (found) return found;
    }
    return null;
  }
  if (!tree || typeof tree !== 'object') return null;
  if (tree.props?.testID === testID) return tree;
  for (const child of tree.children ?? []) {
    const found = findByTestID(child, testID);
    if (found) return found;
  }
  return null;
}

function touchAt(pageX, pageY) {
  return { nativeEvent: { touches: [{ pageX, pageY }] } };
}

describe('MessageList swipe to reply', () => {
  const messages = [{ id: '1', text: 'Your balance is 10 XLM', sender: 'bot' }];

  async function renderList(props = {}) {
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={messages} {...props} />);
    });
    return renderer;
  }

  it('shows a reply icon only while the bubble is dragged right', async () => {
    const renderer = await renderList();
    expect(findByTestID(renderer.toJSON(), 'reply-icon-1')).toBeNull();

    const row = findByTestID(renderer.toJSON(), 'swipe-row-1');
    expect(row).not.toBeNull();

    await act(async () => {
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(160, 82));
    });

    expect(findByTestID(renderer.toJSON(), 'reply-icon-1')).not.toBeNull();
  });

  it('calls onReply and hides the icon when released past the threshold', async () => {
    const onReply = jest.fn();
    const renderer = await renderList({ onReply });

    await act(async () => {
      const row = findByTestID(renderer.toJSON(), 'swipe-row-1');
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(180, 80));
    });

    expect(onReply).not.toHaveBeenCalled();

    await act(async () => {
      findByTestID(renderer.toJSON(), 'swipe-row-1').props.onResponderRelease();
    });

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(messages[0]);
    expect(findByTestID(renderer.toJSON(), 'reply-icon-1')).toBeNull();
  });

  it('does not reply for a swipe shorter than the threshold', async () => {
    const onReply = jest.fn();
    const renderer = await renderList({ onReply });

    await act(async () => {
      const row = findByTestID(renderer.toJSON(), 'swipe-row-1');
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(130, 80));
    });

    await act(async () => {
      findByTestID(renderer.toJSON(), 'swipe-row-1').props.onResponderRelease();
    });

    expect(onReply).not.toHaveBeenCalled();
  });

  it('only claims gestures that are clearly horizontal swipes to the right', async () => {
    const renderer = await renderList();
    const row = findByTestID(renderer.toJSON(), 'swipe-row-1');
    row.props.onTouchStart(touchAt(100, 80));

    expect(row.props.onMoveShouldSetResponder(touchAt(90, 80))).toBe(false);
    expect(row.props.onMoveShouldSetResponder(touchAt(120, 150))).toBe(false);
    expect(row.props.onMoveShouldSetResponder(touchAt(150, 82))).toBe(true);
  });

  it('renders the quoted message above the reply text', async () => {
    let renderer;
    await act(async () => {
      renderer = create(
        <MessageList
          messages={[
            {
              id: '4',
              text: 'Sure, sending now',
              sender: 'user',
              replyTo: { id: '2', text: 'Your SendAm balances: 10 XLM', sender: 'bot' },
            },
          ]}
        />
      );
    });

    const quoted = findByTestID(renderer.toJSON(), 'bubble-user');
    expect(quoted).not.toBeNull();

    const texts = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Text') texts.push(node.children?.[0]);
      (node.children ?? []).forEach(walk);
    })(renderer.toJSON());

    expect(texts).toContain('SendAm');
    expect(texts).toContain('Your SendAm balances: 10 XLM');
    expect(texts).toContain('Sure, sending now');
  });
});

