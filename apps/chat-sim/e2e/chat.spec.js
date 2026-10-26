import { test, expect } from '@playwright/test';

const PHONE = '+2348000000001';

// Scripted stand-in for POST /api/sim/message, keyed by what the user typed.
function botReplyFor(text) {
  if (/^(hi|hello)$/i.test(text)) {
    return ['Welcome to SendAm! You can say: balance, send, history.'];
  }
  if (/^send\s+\d+(\.\d+)?\s*\w*\s+to\s+/i.test(text)) {
    return ['Quote ready\nAda receives USDC value\nFee: 1%\nReply with your PIN to confirm.'];
  }
  if (/^\d{4,6}$/.test(text)) {
    return ['Payment sent.\nReceipt: SDA-9284\nYou can also say: balance, history.'];
  }
  return ['Sorry, I did not understand that.'];
}

/**
 * Mock the simulator API. Returns the list of message bodies the app posted so
 * specs can assert on what actually went over the wire.
 */
async function mockApi(page, { delayMs = 0, failWith = null } = {}) {
  const posted = [];
  await page.route('**/api/sim/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      // Polling endpoint: nothing async to deliver.
      return route.fulfill({ json: { messages: [] } });
    }
    const body = request.postDataJSON();
    posted.push(body);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failWith) {
      return route.fulfill({ status: failWith, json: { message: 'boom' } });
    }
    return route.fulfill({ json: { replies: botReplyFor(body.text) } });
  });
  return posted;
}

/**
 * Install a controllable SpeechRecognition before the app boots, so the
 * simulated voice note path runs without a microphone.
 */
async function installFakeSpeech(page, { transcript = '', error = null } = {}) {
  await page.addInitScript(
    ({ transcript: t, error: e }) => {
      window.__fakeVoice = { transcript: t, error: e };
      window.SpeechRecognition = class {
        start() {
          setTimeout(() => {
            if (window.__fakeVoice.error) {
              this.onerror?.({ error: window.__fakeVoice.error });
            } else {
              this.onresult?.({ results: [[{ transcript: window.__fakeVoice.transcript }]] });
            }
            this.onend?.();
          }, 50);
        }
        stop() {}
        abort() {}
      };
    },
    { transcript, error },
  );
}

async function startSession(page, phone = PHONE) {
  await page.goto('/');
  await page.getByPlaceholder('+2348000000001').fill(phone);
  await page.getByText('Start chatting').click();
  await expect(page.getByText(phone, { exact: true })).toBeVisible();
}

async function sendText(page, text) {
  const input = page.getByPlaceholder('Type a message or use speech');
  await input.fill(text);
  await page.getByTestId('send-button').click();
}

const badge = (page) => page.getByTestId('engine-state-badge');

test.describe('Chat simulator: text messaging and payment flow', () => {
  test('completes a payment conversation from greeting to confirmation', async ({ page }) => {
    const posted = await mockApi(page);
    await startSession(page);
    await expect(badge(page)).toHaveText('Idle');

    // 1. Greeting
    await sendText(page, 'hi');
    await expect(page.getByTestId('bubble-user').filter({ hasText: /^hi$/ })).toBeVisible();
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Welcome to SendAm' })).toBeVisible();
    await expect(badge(page)).toHaveText('Idle');

    // 2. Payment intent -> state machine quotes the rate
    await sendText(page, 'Send 25000 NGN to Ada');
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Reply with your PIN to confirm.' })).toBeVisible();
    await expect(badge(page)).toHaveText('RateQuoted');

    // 3. PIN -> settlement -> receipt
    await sendText(page, '1234');
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Payment sent.' })).toBeVisible();
    await expect(badge(page)).toHaveText('ReceiptDelivered');

    // 4. Confirmation message is the last bubble, and the wire traffic matches the conversation.
    await expect(page.getByTestId('bubble-bot').last()).toContainText('Receipt: SDA-9284');
    expect(posted.map((p) => p.text)).toEqual(['hi', 'Send 25000 NGN to Ada', '1234']);
    posted.forEach((p) => expect(p.phoneNumber).toBe(PHONE));
  });

  test('shows in-flight feedback until the reply is delivered', async ({ page }) => {
    await mockApi(page, { delayMs: 700 });
    await startSession(page);

    await sendText(page, 'hi');
    // Outgoing bubble is shown immediately, the composer is locked, typing indicator is up.
    await expect(page.getByTestId('bubble-user').filter({ hasText: /^hi$/ })).toBeVisible();
    await expect(page.getByText('SendAm is typing')).toBeVisible();
    await expect(page.getByTestId('send-button')).toContainText('...');

    // Delivery: indicator clears and the bot bubble lands.
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Welcome to SendAm' })).toBeVisible();
    await expect(page.getByText('SendAm is typing')).toBeHidden();
    await expect(page.getByTestId('send-button')).toContainText('Send');
  });

  test('surfaces a bot-side error bubble when the API fails', async ({ page }) => {
    await mockApi(page, { failWith: 500 });
    await startSession(page);

    await sendText(page, 'hi');
    await expect(
      page.getByTestId('bubble-bot').filter({ hasText: "Couldn't reach SendAm: Request failed with status 500" }),
    ).toBeVisible();
    // The composer recovers so the user can retry.
    await expect(page.getByText('SendAm is typing')).toBeHidden();
  });

  test('does not send blank messages', async ({ page }) => {
    const posted = await mockApi(page);
    await startSession(page);

    await page.getByPlaceholder('Type a message or use speech').fill('   ');
    await page.getByTestId('send-button').click({ force: true });
    await expect(page.getByTestId('bubble-user')).toHaveCount(0);
    expect(posted).toHaveLength(0);
  });

  test('a non-numeric reply while quoted does not advance the state machine', async ({ page }) => {
    await mockApi(page);
    await startSession(page);

    await sendText(page, 'Send 10 USD to Ada');
    await expect(badge(page)).toHaveText('RateQuoted');
    await sendText(page, 'maybe later');
    await expect(page.getByTestId('bubble-bot').last()).toContainText('did not understand');
    await expect(badge(page)).toHaveText('RateQuoted');
  });

  test('inspector exposes the engine context and can be toggled', async ({ page }) => {
    await mockApi(page);
    await startSession(page);

    await expect(page.getByTestId('dev-inspector')).toHaveCount(0);
    await page.getByTestId('toggle-dev-inspector').click();
    await expect(page.getByTestId('dev-inspector')).toBeVisible();

    await sendText(page, 'Send 10 USD to Ada');
    await expect(page.getByTestId('dev-inspector')).toContainText('"recipient":"Ada"');
    await page.getByTestId('toggle-dev-inspector').click();
    await expect(page.getByTestId('dev-inspector')).toHaveCount(0);
  });
});

test.describe('Chat simulator: simulated voice note dispatch', () => {
  test('dictated payment command fills the composer, quotes, and dispatches', async ({ page }) => {
    const posted = await mockApi(page);
    await installFakeSpeech(page, { transcript: 'Send 20 dollars to Ada' });
    await startSession(page);

    await page.getByTestId('mic-button').click();
    // Recognition result lands in the composer and the engine parses the intent.
    await expect(page.getByPlaceholder('Type a message or use speech')).toHaveValue('Send 20 dollars to Ada');
    await expect(badge(page)).toHaveText('RateQuoted');
    await expect(page.getByTestId('mic-button')).toContainText('MIC');

    // Dispatch the voice note as a message.
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('bubble-user').filter({ hasText: 'Send 20 dollars to Ada' })).toBeVisible();
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Quote ready' })).toBeVisible();
    expect(posted.map((p) => p.text)).toEqual(['Send 20 dollars to Ada']);
  });

  test('an unrecognised voice command moves the engine to Error without sending', async ({ page }) => {
    const posted = await mockApi(page);
    await installFakeSpeech(page, { transcript: 'what a lovely day' });
    await startSession(page);

    await page.getByTestId('mic-button').click();
    await expect(badge(page)).toHaveText('Error');
    expect(posted).toHaveLength(0);
  });

  test('silence (empty transcript) is treated as a failed parse', async ({ page }) => {
    await mockApi(page);
    await installFakeSpeech(page, { transcript: '' });
    await startSession(page);

    await page.getByTestId('mic-button').click();
    await expect(badge(page)).toHaveText('Error');
  });

  test('a recognition error (for example denied microphone) is handled', async ({ page }) => {
    await mockApi(page);
    await installFakeSpeech(page, { error: 'not-allowed' });
    await startSession(page);

    await page.getByTestId('mic-button').click();
    await expect(badge(page)).toHaveText('Error');
    await expect(page.getByTestId('mic-button')).toContainText('MIC');
  });
});

test.describe('Chat simulator: session handling', () => {
  test('requires a phone number before chatting', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByText('Start chatting').click({ force: true });
    await expect(page.getByText('Enter your phone number')).toBeVisible();

    await page.getByPlaceholder('+2348000000001').fill('   ');
    await page.getByText('Start chatting').click({ force: true });
    await expect(page.getByText('Enter your phone number')).toBeVisible();
  });

  test('Switch Account clears the conversation and returns to the phone prompt', async ({ page }) => {
    await mockApi(page);
    await startSession(page);

    await sendText(page, 'hi');
    await expect(page.getByTestId('bubble-bot').filter({ hasText: 'Welcome to SendAm' })).toBeVisible();

    await page.getByTestId('reset-session-button').click();
    await expect(page.getByText('Enter your phone number')).toBeVisible();

    // A fresh session starts with an empty transcript under the new identity.
    await startSession(page, '+2348000000002');
    await expect(page.getByTestId('bubble-user')).toHaveCount(0);
    await expect(page.getByTestId('bubble-bot')).toHaveCount(0);
  });
});
