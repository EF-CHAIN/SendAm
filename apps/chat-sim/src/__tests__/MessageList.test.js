import { act, create } from 'react-test-renderer';
import MessageList from '../MessageList';

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
});
