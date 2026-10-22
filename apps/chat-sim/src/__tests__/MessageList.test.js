import { act, create } from 'react-test-renderer';
import MessageCopyButton from '../MessageCopyButton';
import * as Clipboard from 'expo-clipboard';
import MessageList, { parseQuickReplies } from '../MessageList';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));

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
    const speedLabel = () => findByTestID(renderer.toJSON(), 'voice-speed-pill').children[0].children.join('');

    await act(async () => {
      speedPill.props.onPress();
    });
    const speedPill15 = root.findByProps({ testID: 'voice-speed-pill' });
    expect(speedLabel()).toBe('1.5x');

    await act(async () => {
      speedPill15.props.onPress();
    });
    const speedPill20 = root.findByProps({ testID: 'voice-speed-pill' });
    expect(speedLabel()).toBe('2x');

    await act(async () => {
      speedPill20.props.onPress();
    });
    expect(speedLabel()).toBe('1x');

    // Test scrubbing on a waveform bar
    const bar = root.findByProps({ testID: 'waveform-bar-5' });
    await act(async () => {
      bar.props.onPress();
    });
    const timeDisplay = root.findByProps({ testID: 'voice-time-display' });
    expect(timeDisplay).toBeTruthy();
    act(() => renderer.unmount());
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
  expect(copies.map((copy) => copy.props.text)).toEqual(fixedMessages.filter((message) => !message.isVoice).map((message) => message.text));
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
  const renderers = [];

  afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  });

  async function renderList(props = {}) {
    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={messages} {...props} />);
    });
    renderers.push(renderer);
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
    renderers.push(renderer);
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

describe('copy and swipe interaction', () => {
  let renderer;
  const message = {
    id: 'quoted-reply',
    text: 'Sending now\nReference: 你好 💸  ',
    sender: 'user',
    replyTo: { id: 'original', text: 'Please send 5 XLM', sender: 'bot' },
  };

  beforeEach(() => Clipboard.setStringAsync.mockClear());
  afterEach(() => act(() => renderer?.unmount()));

  async function renderReply(onReply) {
    await act(async () => {
      renderer = create(<MessageList messages={[message]} onReply={onReply} />);
    });
    const copy = renderer.root.findByType(MessageCopyButton);
    return copy.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0];
  }

  it('copies only the message text, not its quoted preview, without starting a reply', async () => {
    const onReply = jest.fn();
    const button = await renderReply(onReply);
    const row = findByTestID(renderer.toJSON(), 'swipe-row-quoted-reply');
    row.props.onTouchStart(touchAt(100, 80));
    expect(row.props.onMoveShouldSetResponder(touchAt(102, 81))).toBe(false);

    await act(async () => { await button.props.onPress(); });

    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
    expect(button.props.accessibilityLabel).toBe('Message copied');
    expect(onReply).not.toHaveBeenCalled();
  });

  it('keeps swipe-to-reply independent from copying and preserves the copy control afterward', async () => {
    const onReply = jest.fn();
    const button = await renderReply(onReply);
    await act(async () => {
      const row = findByTestID(renderer.toJSON(), 'swipe-row-quoted-reply');
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(180, 80));
      row.props.onResponderRelease();
    });

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(message);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(findByTestID(renderer.toJSON(), 'reply-icon-quoted-reply')).toBeNull();

    await act(async () => { await button.props.onPress(); });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('records a mouse press without claiming it or treating a small movement as a swipe', async () => {
    const onReply = jest.fn();
    const button = await renderReply(onReply);
    const row = findByTestID(renderer.toJSON(), 'swipe-row-quoted-reply');
    const mouseAt = (pageX, pageY) => ({ nativeEvent: { pageX, pageY } });

    expect(row.props.onStartShouldSetResponderCapture(mouseAt(600, 200))).toBe(false);
    expect(row.props.onMoveShouldSetResponder(mouseAt(601, 201))).toBe(false);
    await act(async () => { await button.props.onPress(); });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
    expect(onReply).not.toHaveBeenCalled();

    expect(row.props.onStartShouldSetResponderCapture(mouseAt(600, 200))).toBe(false);
    expect(row.props.onMoveShouldSetResponder(mouseAt(670, 201))).toBe(true);
    await act(async () => {
      row.props.onResponderMove(mouseAt(670, 201));
      row.props.onResponderRelease();
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
  });
});

describe('copy, swipe and attachment integration', () => {
  let renderer;
  const attachments = [
    { type: 'photo', name: 'receipt.png', uri: 'data:image/png;base64,AA==' },
    { type: 'document', name: 'receipt.pdf', size: '142.5 KB' },
  ];

  beforeEach(() => Clipboard.setStringAsync.mockClear());
  afterEach(() => act(() => renderer?.unmount()));

  function nodesMatching(node, predicate) {
    if (Array.isArray(node)) return node.flatMap((child) => nodesMatching(child, predicate));
    if (!node || typeof node !== 'object') return [];
    return [
      ...(predicate(node) ? [node] : []),
      ...(node.children ?? []).flatMap((child) => nodesMatching(child, predicate)),
    ];
  }

  it.each(attachments)('renders one $type bubble and copies only its exact caption', async (attachment) => {
    const message = {
      id: `caption-${attachment.type}`,
      sender: attachment.type === 'photo' ? 'user' : 'bot',
      text: 'My receipt\nReference: 你好 💸  ',
      attachment,
      replyTo: { id: 'original', text: 'Please upload your receipt', sender: 'bot' },
    };
    const onReply = jest.fn();
    await act(async () => {
      renderer = create(<MessageList messages={[message]} onReply={onReply} />);
    });

    const tree = renderer.toJSON();
    expect(nodesMatching(tree, (node) => node.props?.testID === `bubble-${message.sender}`)).toHaveLength(1);
    expect(nodesMatching(tree, (node) => node.type === 'Text' && node.children?.[0] === message.text)).toHaveLength(1);
    const row = findByTestID(tree, `swipe-row-${message.id}`);
    expect(findByTestID(row, 'media-card')).not.toBeNull();
    expect(findByTestID(row, attachment.type === 'photo' ? 'media-photo-container' : 'media-doc-container')).not.toBeNull();
    if (attachment.type === 'photo') {
      const image = renderer.root.findByType('img');
      expect(image.props.src).toBe(attachment.uri);
      expect(image.props.alt).toBe(attachment.name);
      expect(image.props.draggable).toBe(false);
    } else {
      expect(nodesMatching(row, (node) => node.type === 'Text' && node.children?.[0] === attachment.name)).toHaveLength(1);
      expect(nodesMatching(row, (node) => node.type === 'Text' && node.children?.[0] === attachment.size)).toHaveLength(1);
    }

    const copy = renderer.root.findByType(MessageCopyButton);
    const button = copy.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0];
    await act(async () => { await button.props.onPress(); });
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
    expect(onReply).not.toHaveBeenCalled();

    await act(async () => {
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(180, 80));
      row.props.onResponderRelease();
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(message);
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(findByTestID(renderer.toJSON(), 'media-card')).not.toBeNull();
  });

  it.each(attachments)('keeps captionless $type messages swipeable without an empty copy action', async (attachment) => {
    const message = { id: `no-caption-${attachment.type}`, sender: 'user', text: '', attachment };
    const onReply = jest.fn();
    await act(async () => {
      renderer = create(<MessageList messages={[message]} onReply={onReply} />);
    });
    expect(renderer.root.findAllByType(MessageCopyButton)).toHaveLength(0);
    expect(nodesMatching(renderer.toJSON(), (node) => node.props?.testID === 'bubble-user')).toHaveLength(1);
    const row = findByTestID(renderer.toJSON(), `swipe-row-${message.id}`);
    expect(findByTestID(row, 'media-card')).not.toBeNull();

    await act(async () => {
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(180, 80));
      row.props.onResponderRelease();
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(message);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });
});

describe('voice controls and swipe integration', () => {
  let renderer;

  beforeEach(() => {
    jest.useFakeTimers();
    Clipboard.setStringAsync.mockClear();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  it.each([{ type: 'voice' }, { isVoice: true }])('keeps voice playback controls independent of copying and replying: %j', async (voiceFlag) => {
    const message = { id: 'voice', sender: 'user', duration: 5, text: '🎤 Voice note (0:05)', ...voiceFlag };
    const onReply = jest.fn();
    await act(async () => {
      renderer = create(<MessageList messages={[message]} onReply={onReply} />);
    });

    const row = findByTestID(renderer.toJSON(), 'swipe-row-voice');
    expect(findByTestID(row, 'voice-note-voice')).not.toBeNull();
    expect(renderer.root.findAllByProps({ className: 'relative self-end max-w-[85%]' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType(MessageCopyButton)).toHaveLength(0);
    const timeDisplay = () => findByTestID(renderer.toJSON(), 'voice-time-display').children.join('');
    expect(timeDisplay()).toBe('0:00 / 0:05');

    expect(row.props.onStartShouldSetResponderCapture({ nativeEvent: { pageX: 100, pageY: 80 } })).toBe(false);
    expect(row.props.onMoveShouldSetResponder({ nativeEvent: { pageX: 101, pageY: 80 } })).toBe(false);
    await act(async () => renderer.root.findByProps({ testID: 'voice-play-button' }).props.onPress());
    await act(async () => jest.advanceTimersByTime(1100));
    expect(timeDisplay()).toBe('0:01 / 0:05');

    await act(async () => renderer.root.findByProps({ testID: 'voice-play-button' }).props.onPress());
    await act(async () => jest.advanceTimersByTime(1100));
    expect(timeDisplay()).toBe('0:01 / 0:05');
    await act(async () => renderer.root.findByProps({ testID: 'waveform-bar-9' }).props.onPress());
    expect(timeDisplay()).toBe('0:02 / 0:05');
    expect(onReply).not.toHaveBeenCalled();
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();

    await act(async () => {
      row.props.onTouchStart(touchAt(100, 80));
      row.props.onResponderMove(touchAt(180, 80));
      row.props.onResponderRelease();
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(message);
    expect(timeDisplay()).toBe('0:02 / 0:05');
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });
});
