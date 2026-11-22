import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('*/api/compliance/onboarding', () => {
    return HttpResponse.json({
      success: true,
      data: {
        stage: 'in_progress',
        percentComplete: 67,
        checkpoints: [
          {
            id: 'account_created',
            label: 'Account created',
            description: 'Your WhatsApp account is registered.',
            complete: true,
          },
          {
            id: 'wallet_ready',
            label: 'Wallet ready',
            description: 'Your Stellar wallet has been funded and is ready to send and receive.',
            complete: true,
          },
          {
            id: 'pin_set',
            label: 'PIN set',
            description: 'A 4-digit PIN protects your payment confirmations.',
            complete: true,
          },
          {
            id: 'kyc_started',
            label: 'Identity verification started',
            description: 'You have initiated the identity verification process.',
            complete: true,
          },
          {
            id: 'kyc_approved',
            label: 'Identity verified',
            description: 'Your identity has been verified and your payment limits have been upgraded.',
            complete: false,
          },
          {
            id: 'account_active',
            label: 'Account in good standing',
            description: 'Your account has no compliance or security holds.',
            complete: true,
          },
        ],
        nextStep: {
          action: 'await_review',
          message: "Your identity verification is under review. We'll notify you when it's approved.",
        },
        blockers: [],
        kyc: { status: 'pending', tier: 0, sanctionsStatus: 'cleared' },
        wallet: {
          publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ',
          funded: true,
          fundingState: 'succeeded',
          trustlineState: 'succeeded',
          network: 'testnet',
        },
        accountActive: true,
        computedAt: '2026-01-05T10:00:00.000Z',
      },
    });
  }),
];
