import { act, create } from 'react-test-renderer';
import ChatScreen from '../ChatScreen';
import MessageList from '../MessageList';

// Mock API config and usePolling
jest.mock('../config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));
jest.mock('../usePolling', () => jest.fn());

describe('ChatScreen Attachment Picker and Media Preview', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ replies: ['Verified receipt!'] }),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders paperclip button and toggles attachment menu with Photo and Document options', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });

    const root = renderer.root;
    // Enter phone and click start
    const phoneInput = root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });

    const startButton = root.findAllByProps({ testID: 'start-button' }).find(
      (node) => typeof node.props.onPress === 'function'
    );
    await act(async () => {
      startButton.props.onPress();
    });

    // Check paperclip button exists
    const paperclip = root.findByProps({ testID: 'paperclip-button' });
    expect(paperclip).toBeDefined();

    // Menu should be closed initially
    expect(root.findAllByProps({ testID: 'attach-photo-button' })).toHaveLength(0);

    // Click paperclip
    await act(async () => {
      paperclip.props.onPress();
    });

    // Menu should be open with Photo and Document options
    const photoBtn = root.findByProps({ testID: 'attach-photo-button' });
    const docBtn = root.findByProps({ testID: 'attach-doc-button' });
    expect(photoBtn).toBeDefined();
    expect(docBtn).toBeDefined();
  });

  it('generates inline media preview bubble when photo is selected and allows caption input', async () => {
    let renderer;
    await act(async () => {
      renderer = create(<ChatScreen />);
    });

    const root = renderer.root;
    const phoneInput = root.findByProps({ placeholder: '+2348000000001' });
    await act(async () => {
      phoneInput.props.onChangeText('+2348000000001');
    });

    const startButton = root.findAllByProps({ testID: 'start-button' }).find(
      (node) => typeof node.props.onPress === 'function'
    );
    await act(async () => {
      startButton.props.onPress();
    });

    const paperclip = root.findByProps({ testID: 'paperclip-button' });
    await act(async () => {
      paperclip.props.onPress();
    });

    const photoBtn = root.findByProps({ testID: 'attach-photo-button' });
    await act(async () => {
      photoBtn.props.onPress();
    });

    // Preview bubble should appear
    const previewBubble = root.findByProps({ testID: 'attachment-preview-bubble' });
    expect(previewBubble).toBeDefined();

    // Caption input should be available
    const captionInput = root.findByProps({ testID: 'attachment-caption-input' });
    expect(captionInput).toBeDefined();

    await act(async () => {
      captionInput.props.onChangeText('My NIN verification card');
    });

    // Send button should be enabled
    const sendButton = root.findByProps({ testID: 'send-button' });
    expect(sendButton.props.disabled).toBe(false);

    await act(async () => {
      sendButton.props.onPress();
    });

    // Preview bubble should be cleared after send
    expect(root.findAllByProps({ testID: 'attachment-preview-bubble' })).toHaveLength(0);

    // Media card should be rendered in MessageList
    const mediaCards = root.findAllByProps({ testID: 'media-card' });
    expect(mediaCards.length).toBeGreaterThan(0);
  });

  it('renders document media card with file name in MessageList', async () => {
    const messages = [
      {
        id: 'u-101',
        sender: 'user',
        text: 'Proof of address document',
        attachment: {
          type: 'document',
          name: 'utility-bill.pdf',
          size: '142.5 KB',
        },
      },
    ];

    let renderer;
    await act(async () => {
      renderer = create(<MessageList messages={messages} />);
    });

    const root = renderer.root;
    const mediaCard = root.findByProps({ testID: 'media-card' });
    expect(mediaCard).toBeDefined();

    const docContainer = root.findByProps({ testID: 'media-doc-container' });
    expect(docContainer).toBeDefined();
  });
});
