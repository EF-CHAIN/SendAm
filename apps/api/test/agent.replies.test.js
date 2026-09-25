const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  replies,
  shortenPublicKey,
  chainLabel,
  MESSAGES,
  CHAIN_LABEL_STELLAR,
  UNKNOWN_MESSAGE,
  RATE_LIMITED_MESSAGE,
  GREETING_MESSAGE,
  HELP_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  CREATING_WALLET_MESSAGE,
  WALLETS_READY_MESSAGE,
  WALLETS_EXIST_MESSAGE,
  NO_WALLET_MESSAGE,
  FUNDING_WALLETS_MESSAGE,
  ALL_WALLETS_FUNDED_MESSAGE,
  WALLET_STATUS_FUNDED,
  WALLET_STATUS_MANUAL,
  WALLET_STATUS_FAILED,
  BALANCE_UNAVAILABLE_LINE,
  BALANCE_UNVERIFIED_ASSET_LINE,
  BALANCE_ASSET_LINE,
  BALANCES_MESSAGE,
  BALANCE_ERROR_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  INVALID_ADDRESS_MESSAGE,
  CONTACT_SAVED_MESSAGE,
  CONTACT_SAVE_ERROR_MESSAGE,
  NO_CONTACTS_MESSAGE,
  CONTACT_LIST_ITEM,
  INVALID_SEND_FORMAT_MESSAGE,
  INVALID_SAVE_FORMAT_MESSAGE,
  RECIPIENT_NOT_FOUND_MESSAGE,
  CONFIRM_TRANSFER_MESSAGE,
  PREPARE_ERROR_MESSAGE,
  PROCESSING_TRANSFER_MESSAGE,
  TRANSFER_SUCCESS_MESSAGE,
  TRANSFER_FAILED_MESSAGE,
  NO_ACTIVE_TRANSFER_MESSAGE,
  TRANSFER_CANCELLED_MESSAGE,
  NO_TRANSFER_TO_CANCEL_MESSAGE,
} = require('../src/services/agent/replies');

test('helpers produce expected values', () => {
  assert.equal(chainLabel(), 'Stellar');
  assert.equal(chainLabel(), CHAIN_LABEL_STELLAR);
  assert.equal(shortenPublicKey('GABCD1234567890XYZW'), 'GABCD123...XYZW');
});

test('general system replies match named constants', () => {
  assert.equal(replies.greeting('Alice'), GREETING_MESSAGE('Alice'));
  assert.equal(
    replies.greeting('Alice'),
    "Hello Alice! Welcome to SendAm. Reply with 'help' to see available commands."
  );
  assert.equal(replies.greeting(), GREETING_MESSAGE());
  assert.equal(
    replies.greeting(),
    "Hello there! Welcome to SendAm. Reply with 'help' to see available commands."
  );

  assert.equal(replies.help(), HELP_MESSAGE);
  assert.ok(replies.help().includes('Available commands:'));
  assert.ok(replies.help().includes('- create wallet: Create your Stellar wallet'));

  assert.equal(replies.unknown(), UNKNOWN_MESSAGE);
  assert.equal(replies.unknown(), "Sorry, I didn't understand that. Reply with 'help' to see what I can do.");

  assert.equal(replies.genericError('timeout'), GENERIC_ERROR_MESSAGE('timeout'));
  assert.equal(replies.genericError('timeout'), 'Sorry, an error occurred: timeout');

  assert.equal(replies.rateLimited(), RATE_LIMITED_MESSAGE);
  assert.equal(
    replies.rateLimited(),
    "You're sending messages too quickly. Please wait a moment and try again."
  );
});

test('wallet replies match named constants', () => {
  assert.equal(replies.creatingWallet(), CREATING_WALLET_MESSAGE);
  assert.equal(replies.noWallet(), NO_WALLET_MESSAGE);
  assert.equal(replies.fundingWallets(), FUNDING_WALLETS_MESSAGE);

  const mockWallets = [
    { chain: 'stellar', funded: true, publicKey: 'G_FUNDED_KEY' },
    { chain: 'stellar', manual: true, publicKey: 'G_MANUAL_KEY', instructions: 'Deposit 2 XLM' },
    { chain: 'stellar', funded: false, manual: false, publicKey: 'G_FAILED_KEY' },
  ];

  const expectedStatusLines = [
    'Stellar: funded.\nG_FUNDED_KEY',
    'Stellar: created, not yet funded.\nG_MANUAL_KEY\nDeposit 2 XLM',
    "Stellar: funding failed. Reply 'fund' to retry.\nG_FAILED_KEY",
  ].join('\n\n');

  assert.equal(
    WALLET_STATUS_FUNDED('Stellar', 'G_FUNDED_KEY'),
    'Stellar: funded.\nG_FUNDED_KEY'
  );
  assert.equal(
    WALLET_STATUS_MANUAL('Stellar', 'G_MANUAL_KEY', 'Deposit 2 XLM'),
    'Stellar: created, not yet funded.\nG_MANUAL_KEY\nDeposit 2 XLM'
  );
  assert.equal(
    WALLET_STATUS_FAILED('Stellar', 'G_FAILED_KEY'),
    "Stellar: funding failed. Reply 'fund' to retry.\nG_FAILED_KEY"
  );

  assert.equal(replies.walletsReady(mockWallets), WALLETS_READY_MESSAGE(expectedStatusLines));
  assert.equal(replies.walletsExist(mockWallets), WALLETS_EXIST_MESSAGE(expectedStatusLines));
  assert.equal(replies.allWalletsFunded(mockWallets), ALL_WALLETS_FUNDED_MESSAGE(expectedStatusLines));
});

test('balance replies match named constants', () => {
  const wallets = [
    {
      chain: 'stellar',
      assets: [
        { asset: 'XLM', value: '100.5' },
        { asset: 'USDC', value: '50', trusted: false },
      ],
    },
    {
      chain: 'stellar',
      error: 'Horizon network error',
    },
  ];

  const expectedBalanceOutput = [
    'Your balances:',
    '',
    'XLM: 100.5',
    'USDC: 50 (unverified issuer — not trusted USDC)',
    'Stellar: unavailable (Horizon network error)',
  ].join('\n');

  assert.equal(replies.balances(wallets), expectedBalanceOutput);
  assert.equal(
    BALANCE_UNAVAILABLE_LINE('Stellar', 'Horizon network error'),
    'Stellar: unavailable (Horizon network error)'
  );
  assert.equal(
    BALANCE_UNVERIFIED_ASSET_LINE('USDC', '50'),
    'USDC: 50 (unverified issuer — not trusted USDC)'
  );
  assert.equal(BALANCE_ASSET_LINE('XLM', '100.5'), 'XLM: 100.5');

  assert.equal(BALANCES_MESSAGE(['XLM: 100']), 'Your balances:\n\nXLM: 100');
  assert.equal(replies.balanceError('rpc timeout'), BALANCE_ERROR_MESSAGE('rpc timeout'));
  assert.equal(replies.balanceError('rpc timeout'), 'Error getting balance: rpc timeout');

  assert.equal(
    replies.insufficientBalance('stellar', '10 XLM', '50', 'XLM'),
    INSUFFICIENT_BALANCE_MESSAGE('Stellar', '10 XLM', '50', 'XLM')
  );
  assert.equal(
    replies.insufficientBalance('stellar', '10 XLM', '50', 'XLM'),
    "Insufficient balance. You're trying to send 50 XLM but your Stellar balance is 10 XLM."
  );
});

test('contacts replies match named constants', () => {
  assert.equal(replies.invalidAddress(), INVALID_ADDRESS_MESSAGE);
  assert.equal(
    replies.invalidAddress(),
    'That is not a valid Stellar address. Please check it and try again.'
  );

  assert.equal(
    replies.contactSaved('ada', 'GABC1234567890XYZW', 'stellar'),
    CONTACT_SAVED_MESSAGE('ada', 'Stellar', 'GABC1234...XYZW')
  );
  assert.equal(
    replies.contactSaved('ada', 'GABC1234567890XYZW', 'stellar'),
    'Saved ada (Stellar) as GABC1234...XYZW.\n\nYou can now send with: send 5 xlm ada'
  );

  assert.equal(
    replies.contactSaveError('duplicate'),
    CONTACT_SAVE_ERROR_MESSAGE('duplicate')
  );
  assert.equal(replies.contactSaveError('duplicate'), 'Could not save contact: duplicate');

  assert.equal(replies.noContacts(), NO_CONTACTS_MESSAGE);
  assert.equal(
    replies.noContacts(),
    'You do not have saved contacts yet.\n\nUse: save <name> <address>'
  );

  const contacts = [
    { alias: 'ada', chain: 'stellar', publicKey: 'GABC1234567890XYZW' },
    { alias: 'bob', chain: 'stellar', publicKey: 'GDEF1234567890WXYZ' },
  ];
  assert.equal(
    CONTACT_LIST_ITEM('ada', 'Stellar', 'GABC1234...XYZW'),
    'ada (Stellar): GABC1234...XYZW'
  );
  assert.equal(
    replies.contactList(contacts),
    'ada (Stellar): GABC1234...XYZW\nbob (Stellar): GDEF1234...WXYZ'
  );
});

test('send replies match named constants', () => {
  assert.equal(replies.invalidSendFormat(), INVALID_SEND_FORMAT_MESSAGE);
  assert.equal(replies.invalidSaveFormat(), INVALID_SAVE_FORMAT_MESSAGE);

  assert.equal(
    replies.recipientNotFound('Ada'),
    RECIPIENT_NOT_FOUND_MESSAGE('Ada')
  );
  assert.equal(
    replies.recipientNotFound('Ada'),
    'I could not find "Ada" in your contacts, and it is not a valid Stellar address.\n\nUse: save ada <address>'
  );

  assert.equal(
    replies.confirmTransfer('5', 'XLM', 'ada', 'GABC...', 'stellar'),
    CONFIRM_TRANSFER_MESSAGE('Stellar', '5', 'XLM', 'ada', 'GABC...')
  );
  assert.equal(
    replies.confirmTransfer('5', 'XLM', 'ada', 'GABC...', 'stellar'),
    'Confirm transfer on Stellar:\n\nAmount: 5 XLM\nTo: ada\nAddress: GABC...\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.'
  );

  assert.equal(replies.prepareError('failed'), PREPARE_ERROR_MESSAGE('failed'));
  assert.equal(replies.processingTransfer('5', 'XLM'), PROCESSING_TRANSFER_MESSAGE('5', 'XLM'));
  assert.equal(
    replies.transferSuccess('5', 'XLM', 'ada', '0xabc', 'https://stellar.expert/0xabc'),
    TRANSFER_SUCCESS_MESSAGE('5', 'XLM', 'ada', '0xabc', 'https://stellar.expert/0xabc')
  );
  assert.equal(replies.transferFailed('rejected'), TRANSFER_FAILED_MESSAGE('rejected'));
  assert.equal(replies.noActiveTransfer(), NO_ACTIVE_TRANSFER_MESSAGE);
  assert.equal(replies.transferCancelled(), TRANSFER_CANCELLED_MESSAGE);
  assert.equal(replies.noTransferToCancel(), NO_TRANSFER_TO_CANCEL_MESSAGE);
});

test('MESSAGES object groups all constants', () => {
  assert.equal(MESSAGES.UNKNOWN, UNKNOWN_MESSAGE);
  assert.equal(MESSAGES.RATE_LIMITED, RATE_LIMITED_MESSAGE);
  assert.equal(MESSAGES.HELP, HELP_MESSAGE);
  assert.equal(MESSAGES.NO_WALLET, NO_WALLET_MESSAGE);
  assert.equal(MESSAGES.CREATING_WALLET, CREATING_WALLET_MESSAGE);
  assert.equal(MESSAGES.NO_CONTACTS, NO_CONTACTS_MESSAGE);
  assert.equal(MESSAGES.TRANSFER_CANCELLED, TRANSFER_CANCELLED_MESSAGE);
});
