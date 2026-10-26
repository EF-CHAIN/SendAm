import { act, create } from 'react-test-renderer';
import { TextInput } from 'react-native';
import ChatScreen from '../ChatScreen';
import usePolling from '../usePolling';

// The drawer is pure frontend state; polling and the network are stubbed so
// the test drives the exact flow a user does: open menu → pick a row → Send.
jest.mock('../usePolling', () => jest.fn());

const listPayload = {
  type: 'list',
  body: { text: 'What would you like to do?' },
  action: {
    button: 'Main menu',
    sections: [
      {
        title: 'Payments',
        rows: [
          { id: 'send', title: 'Send money', description: 'Send XLM to a phone number' },
          { id: 'balance', title: 'Check balance', description: 'All wallet balances' },
        ],
      },
      {
        title: 'Account',
        rows: [{ id: 'history', title: 'Transaction history' }],
      },
    ],
  },
};

const listBotMessage = {
  id: 'bot-list-1',
  sender: 'bot',
  text: JSON.stringify(listPayload),
  timestamp: '2026-10-21T10:00:00.000Z',
};

async function renderChatWithListMessage() {
  let setMessagesFromPolling;
  usePolling.mockImplementation((phoneNumber, setMessages) => {
    if (phoneNumber) setMessagesFromPolling = setMessages;
  });

  let renderer;
  await act(async () => {
    renderer = create(<ChatScreen />);
  });

  // Start a session so the chat UI (and the drawer host) mounts.
  const phoneInput = renderer.root.findByType(TextInput);
  await act(async () => {
    phoneInput.props.onChangeText('+2348000000001');
  });
  await act(async () => {
    renderer.root.findByType(TextInput).props.onSubmitEditing();
  });

  await act(async () => {
    setMessagesFromPolling(() => [listBotMessage]);
  });

  return renderer;
}

describe('ChatScreen WhatsApp list-message drawer', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ replies: [] }),
    });
  });

  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  it('opens the drawer with formatted sections, descriptions and radios', async () => {
    const renderer = await renderChatWithListMessage();
    const root = renderer.root;

    expect(root.findAllByProps({ testID: 'list-drawer' })).toHaveLength(0);

    await act(async () => {
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.onPress();
    });

    expect(root.findAllByProps({ testID: 'list-drawer' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'list-section-section-0' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'list-section-section-1' }).length).toBeGreaterThan(0);
    for (const rowId of ['send', 'balance', 'history']) {
      expect(root.findAllByProps({ testID: `list-row-${rowId}` }).length).toBeGreaterThan(0);
    }
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Send XLM to a phone number');
    expect(rendered).toContain('What would you like to do?');

    // Nothing selected yet: no radio is marked selected, Send is disabled.
    const sendButton = root.findByProps({ testID: 'list-drawer-send' });
    expect(sendButton.props.disabled).toBe(true);
    const row = root.findByProps({ testID: 'list-row-send' });
    expect(row.props.accessibilityState).toEqual({ selected: false });
  });

  it('radio-selects a row, submits it as the reply and closes the drawer', async () => {
    const renderer = await renderChatWithListMessage();
    const root = renderer.root;

    await act(async () => {
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'list-row-balance' }).props.onPress();
    });

    expect(
      root.findByProps({ testID: 'list-row-balance' }).props.accessibilityState
    ).toEqual({ selected: true });
    expect(
      root.findByProps({ testID: 'list-row-send' }).props.accessibilityState
    ).toEqual({ selected: false });

    const sendButton = root.findByProps({ testID: 'list-drawer-send' });
    expect(sendButton.props.disabled).toBe(false);
    await act(async () => {
      sendButton.props.onPress();
    });

    // Drawer closed, the choice went out as the user's reply (row title), and
    // reopening is blocked exactly like a used quick reply.
    expect(root.findAllByProps({ testID: 'list-drawer' })).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toBe('Check balance');
    expect(
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.disabled
    ).toBe(true);
  });

  it('closes without submitting from the backdrop and the close button', async () => {
    const renderer = await renderChatWithListMessage();
    const root = renderer.root;

    await act(async () => {
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'list-drawer-backdrop' }).props.onPress();
    });
    expect(root.findAllByProps({ testID: 'list-drawer' })).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();

    // Reopen: the selection starts clean and the close button works too.
    await act(async () => {
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'list-row-history' }).props.onPress();
    });
    await act(async () => {
      root.findByProps({ testID: 'list-drawer-close' }).props.onPress();
    });
    expect(root.findAllByProps({ testID: 'list-drawer' })).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();

    await act(async () => {
      root.findByProps({ testID: 'list-message-button-bot-list-1' }).props.onPress();
    });
    expect(
      root.findByProps({ testID: 'list-row-history' }).props.accessibilityState
    ).toEqual({ selected: false });
  });

  it('suppresses the bottom quick-reply bar for a list message', async () => {
    const renderer = await renderChatWithListMessage();
    expect(
      renderer.root.findAllByProps({ testID: 'quick-replies-bottom-bar' })
    ).toHaveLength(0);
  });
});
