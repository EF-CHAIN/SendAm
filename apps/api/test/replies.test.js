'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { replies, STRINGS, TEMPLATES, shortenPublicKey, chainLabel } = require('../src/services/agent/replies');

describe('agent/replies', () => {
  it('exposes defined string and template constants', () => {
    assert.ok(STRINGS);
    assert.ok(TEMPLATES);
    assert.equal(typeof STRINGS.HELP, 'string');
    assert.equal(typeof STRINGS.UNKNOWN, 'string');
    assert.equal(typeof STRINGS.RATE_LIMITED, 'string');
    assert.equal(typeof TEMPLATES.GREETING, 'function');
    assert.equal(typeof TEMPLATES.CONFIRM_TRANSFER, 'function');
  });

  it('formats shortenPublicKey and chainLabel correctly', () => {
    assert.equal(chainLabel(), 'Stellar');
    assert.equal(shortenPublicKey('GABC1234567890XYZW'), 'GABC1234...XYZW');
  });

  it('formats greeting reply with name fallback', () => {
    assert.equal(
      replies.greeting('Ada'),
      "Hello Ada! Welcome to SendAm. Reply with 'help' to see available commands."
    );
    assert.equal(
      replies.greeting(''),
      "Hello there! Welcome to SendAm. Reply with 'help' to see available commands."
    );
  });

  it('formats help and static replies', () => {
    assert.ok(replies.help().includes('Available commands:'));
    assert.equal(replies.unknown(), "Sorry, I didn't understand that. Reply with 'help' to see what I can do.");
    assert.equal(replies.rateLimited(), "You're sending messages too quickly. Please wait a moment and try again.");
    assert.equal(replies.creatingWallet(), 'Creating your Stellar wallet...');
    assert.equal(replies.noWallet(), "You don't have a wallet yet. Send 'create wallet' first.");
  });

  it('formats walletStatusLines and wallet status replies', () => {
    const wallets = [
      { chain: 'stellar', funded: true, publicKey: 'G_FUNDED' },
      { chain: 'stellar', funded: false, manual: true, publicKey: 'G_MANUAL', instructions: 'Deposit 1 XLM' },
      { chain: 'stellar', funded: false, manual: false, publicKey: 'G_FAILED' },
    ];

    const readyText = replies.walletsReady(wallets);
    assert.ok(readyText.includes('Wallet setup complete.'));
    assert.ok(readyText.includes('Stellar: funded.\nG_FUNDED'));
    assert.ok(readyText.includes('Stellar: created, not yet funded.\nG_MANUAL\nDeposit 1 XLM'));
    assert.ok(readyText.includes("Stellar: funding failed. Reply 'fund' to retry.\nG_FAILED"));

    assert.ok(replies.walletsExist(wallets).includes('You already have wallets.'));
    assert.ok(replies.allWalletsFunded(wallets).includes('All your wallets are already funded.'));
  });

  it('formats balances with error, unverified, and standard asset rows', () => {
    const wallets = [
      { chain: 'stellar', error: 'Horizon down' },
      {
        chain: 'stellar',
        assets: [
          { asset: 'XLM', value: '10.5', trusted: true },
          { asset: 'USDC', value: '50.0', trusted: false },
        ],
      },
    ];

    const text = replies.balances(wallets);
    assert.ok(text.includes('Stellar: unavailable (Horizon down)'));
    assert.ok(text.includes('XLM: 10.5'));
    assert.ok(text.includes('USDC: 50.0 (unverified issuer — not trusted USDC)'));
  });

  it('formats transfer and contact replies', () => {
    assert.equal(
      replies.contactSaved('ada', 'GABC1234567890XYZW', 'stellar'),
      'Saved ada (Stellar) as GABC1234...XYZW.\n\nYou can now send with: send 5 xlm ada'
    );
    assert.equal(
      replies.contactList([{ alias: 'bob', chain: 'stellar', publicKey: 'GABC1234567890XYZW' }]),
      'bob (Stellar): GABC1234...XYZW'
    );
    assert.equal(
      replies.confirmTransfer('5', 'XLM', 'Ada', 'GABC...', 'stellar'),
      'Confirm transfer on Stellar:\n\nAmount: 5 XLM\nTo: Ada\nAddress: GABC...\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.'
    );
    assert.equal(
      replies.transferSuccess('5', 'XLM', 'Ada', '0xabc', 'https://stellar.expert/...'),
      'Transfer successful.\n\nSent: 5 XLM\nTo: Ada\nTransaction: 0xabc\nReceipt: https://stellar.expert/...'
    );
    assert.equal(replies.transferCancelled(), 'Transfer cancelled.');
    assert.equal(replies.noActiveTransfer(), 'No active transfer to confirm. Send a new command like: send 5 xlm GABC...');
  });
});
