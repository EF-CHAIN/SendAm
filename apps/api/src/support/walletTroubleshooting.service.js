/**
 * Service: Wallet Troubleshooting Workflow & Support Template Service (#338)
 *
 * Evaluates backend wallet states, trustlines, XLM balances, and pending transactions
 * to diagnose root causes and output customer-facing & agent support templates.
 */

const TROUBLESHOOTING_SCENARIOS = {
  UNFUNDED_ACCOUNT: {
    code: 'UNFUNDED_ACCOUNT',
    name: 'Unfunded Stellar Account',
    description: 'Account balance is 0 XLM. Stellar accounts require a minimum balance (1 XLM) to exist on-chain.',
    agentAction: 'Instruct customer to deposit minimum 1.5 XLM into their wallet address.',
    customerMessageTemplate: (data) =>
      `Hello ${data.customerName || 'Valued Customer'}, your wallet address (${data.walletAddress}) needs a minimum reserve of 1.5 XLM to become active on the Stellar network. Please send at least 1.5 XLM to activate your account.`,
  },
  MISSING_TRUSTLINE: {
    code: 'MISSING_TRUSTLINE',
    name: 'Missing Asset Trustline',
    description: 'Customer wallet does not have an established trustline for the requested asset (e.g. USDC).',
    agentAction: 'Verify asset issuer address and guide customer to add trustline via WhatsApp or wallet app.',
    customerMessageTemplate: (data) =>
      `Hello ${data.customerName || 'Valued Customer'}, to receive ${data.assetCode || 'USDC'}, your wallet needs an active trustline for asset issuer ${data.assetIssuer || 'USDC Issuer'}. Reply "ADD TRUSTLINE ${data.assetCode}" in WhatsApp to enable it automatically.`,
  },
  INSUFFICIENT_FEE_BALANCE: {
    code: 'INSUFFICIENT_FEE_BALANCE',
    name: 'Insufficient XLM for Gas/Fee',
    description: 'Wallet XLM balance is below the minimum reserve threshold required to pay transaction network fees.',
    agentAction: 'Advise customer to top up at least 0.5 XLM for transaction fees.',
    customerMessageTemplate: (data) =>
      `Hello ${data.customerName || 'Valued Customer'}, your transaction requires a tiny network fee (0.00001 XLM). Your available XLM balance is currently too low. Please top up your XLM balance to complete your payment.`,
  },
  INVALID_MEMO: {
    code: 'INVALID_MEMO',
    name: 'Missing or Invalid Transaction Memo',
    description: 'Destination requires a memo (e.g. exchange deposit), but no memo was supplied.',
    agentAction: 'Ask customer for their exchange deposit memo and retry payment instruction.',
    customerMessageTemplate: (data) =>
      `Hello ${data.customerName || 'Valued Customer'}, the destination wallet requires a Memo ID for routing. Please provide your Memo ID so we can process your transfer accurately.`,
  },
  HEALTHY: {
    code: 'HEALTHY',
    name: 'Wallet State Normal',
    description: 'Wallet account and trustlines are fully operational.',
    agentAction: 'Check transaction status or network status on Horizon/Soroban RPC.',
    customerMessageTemplate: (data) =>
      `Hello ${data.customerName || 'Valued Customer'}, your wallet is fully active and ready to send/receive funds.`,
  },
};

class WalletTroubleshootingService {
  /**
   * Evaluates wallet state and returns a structured diagnosis and agent/customer template.
   */
  diagnoseWalletState(walletState) {
    const {
      customerName = 'Customer',
      walletAddress,
      xlmBalance = 0,
      hasAccount = false,
      trustlines = [],
      requestedAsset = 'USDC',
      requestedAssetIssuer,
      requiresMemo = false,
      providedMemo = null,
    } = walletState;

    if (!hasAccount || Number(xlmBalance) <= 0) {
      return this.formatDiagnosis(TROUBLESHOOTING_SCENARIOS.UNFUNDED_ACCOUNT, {
        customerName,
        walletAddress,
      });
    }

    if (Number(xlmBalance) < 0.5) {
      return this.formatDiagnosis(TROUBLESHOOTING_SCENARIOS.INSUFFICIENT_FEE_BALANCE, {
        customerName,
        xlmBalance,
      });
    }

    if (requiresMemo && !providedMemo) {
      return this.formatDiagnosis(TROUBLESHOOTING_SCENARIOS.INVALID_MEMO, {
        customerName,
      });
    }

    if (requestedAsset !== 'XLM') {
      const hasTrustline = trustlines.some((t) => t.assetCode === requestedAsset);
      if (!hasTrustline) {
        return this.formatDiagnosis(TROUBLESHOOTING_SCENARIOS.MISSING_TRUSTLINE, {
          customerName,
          assetCode: requestedAsset,
          assetIssuer: requestedAssetIssuer,
        });
      }
    }

    return this.formatDiagnosis(TROUBLESHOOTING_SCENARIOS.HEALTHY, { customerName });
  }

  formatDiagnosis(scenario, data) {
    return {
      code: scenario.code,
      scenarioName: scenario.name,
      description: scenario.description,
      agentAction: scenario.agentAction,
      customerTemplate: scenario.customerMessageTemplate(data),
      timestamp: new Date().toISOString(),
    };
  }
}

const walletTroubleshootingService = new WalletTroubleshootingService();

module.exports = {
  TROUBLESHOOTING_SCENARIOS,
  WalletTroubleshootingService,
  walletTroubleshootingService,
};
