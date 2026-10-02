/**
 * Deterministic Payment State Machine Engine for Chat Simulator.
 * Models SendAm's WhatsApp payment lifecycle:
 * Idle -> ParsingVoice -> RateQuoted -> AwaitingPin -> SettlingStellar -> ReceiptDelivered -> Completed.
 *
 * Includes state timeline recording, rollback, state inspection, and event dispatching.
 */

export const PaymentState = {
  IDLE: "Idle",
  PARSING_VOICE: "ParsingVoice",
  RATE_QUOTED: "RateQuoted",
  AWAITING_PIN: "AwaitingPin",
  SETTLING_STELLAR: "SettlingStellar",
  RECEIPT_DELIVERED: "ReceiptDelivered",
  COMPLETED: "Completed",
  ERROR: "Error",
};

export const PaymentEvent = {
  START_VOICE_COMMAND: "START_VOICE_COMMAND",
  VOICE_PARSED: "VOICE_PARSED",
  PARSE_FAILED: "PARSE_FAILED",
  QUOTE_GENERATED: "QUOTE_GENERATED",
  SUBMIT_PIN: "SUBMIT_PIN",
  PIN_VALIDATED: "PIN_VALIDATED",
  PIN_INVALID: "PIN_INVALID",
  STELLAR_SUBMITTED: "STELLAR_SUBMITTED",
  STELLAR_SUCCESS: "STELLAR_SUCCESS",
  STELLAR_FAILED: "STELLAR_FAILED",
  RECEIPT_SENT: "RECEIPT_SENT",
  RESET: "RESET",
  ROLLBACK: "ROLLBACK",
};

export class PaymentStateMachine {
  constructor(initialContext = {}) {
    this.initialContext = {
      amount: null,
      asset: "USDC",
      recipient: null,
      recipientPhone: null,
      estimatedRate: null,
      fee: null,
      stellarTxHash: null,
      errorMessage: null,
      pinAttempts: 0,
      ...initialContext,
    };

    this.state = PaymentState.IDLE;
    this.context = { ...this.initialContext };
    this.history = [];
    this.listeners = new Set();
    this._recordSnapshot("INITIALIZE");
  }

  getState() {
    return this.state;
  }

  getContext() {
    return { ...this.context };
  }

  getHistory() {
    return [...this.history];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify(transitionInfo) {
    for (const listener of this.listeners) {
      try {
        listener({
          state: this.state,
          context: this.getContext(),
          history: this.getHistory(),
          transition: transitionInfo,
        });
      } catch (err) {
        console.error("Error in state machine listener:", err);
      }
    }
  }

  _recordSnapshot(action) {
    this.history.push({
      index: this.history.length,
      timestamp: Date.now(),
      action,
      state: this.state,
      context: { ...this.context },
    });
  }

  /**
   * Parse natural speech input like "Send 20 dollars to Ada" or "Transfer 50 USDC to +2348000000002"
   */
  parsePaymentIntent(voiceText) {
    if (!voiceText || typeof voiceText !== "string") {
      return null;
    }

    const cleanText = voiceText.trim();
    // Matches patterns like "Send 20 dollars to Ada", "Transfer 10.5 USD to John", "Pay 50 USDC to +2348012345678"
    const regex =
      /(?:send|transfer|pay|give)\s+([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z$]+)?\s+to\s+([+0-9a-zA-Z\s]+)/i;
    const match = cleanText.match(regex);

    if (match) {
      const amount = parseFloat(match[1]);
      let rawAsset = (match[2] || "USD").toUpperCase();
      if (rawAsset === "DOLLARS" || rawAsset === "DOLLAR" || rawAsset === "$")
        rawAsset = "USD";
      const recipient = match[3].trim();
      return {
        amount,
        asset: rawAsset,
        recipient,
      };
    }

    return null;
  }

  transition(event, payload = {}) {
    const prevState = this.state;
    let nextState = prevState;
    let updatedContext = { ...this.context };

    switch (this.state) {
      case PaymentState.IDLE:
        if (event === PaymentEvent.START_VOICE_COMMAND) {
          nextState = PaymentState.PARSING_VOICE;
          updatedContext = { ...updatedContext, errorMessage: null };
        } else if (event === PaymentEvent.QUOTE_GENERATED) {
          nextState = PaymentState.RATE_QUOTED;
          updatedContext = {
            ...updatedContext,
            ...payload,
            errorMessage: null,
          };
        }
        break;

      case PaymentState.PARSING_VOICE:
        if (event === PaymentEvent.VOICE_PARSED) {
          const parsed =
            payload.intent || this.parsePaymentIntent(payload.text);
          if (parsed && parsed.amount && parsed.recipient) {
            nextState = PaymentState.RATE_QUOTED;
            const rate =
              parsed.asset === "USD" || parsed.asset === "USDC" ? 1.0 : 0.5;
            const fee = (parsed.amount * 0.01).toFixed(2);
            updatedContext = {
              ...updatedContext,
              amount: parsed.amount,
              asset: parsed.asset,
              recipient: parsed.recipient,
              recipientPhone: parsed.recipient.startsWith("+")
                ? parsed.recipient
                : `+234${Math.floor(8000000000 + Math.random() * 999999999)}`,
              estimatedRate: rate,
              fee,
              errorMessage: null,
            };
          } else {
            nextState = PaymentState.ERROR;
            updatedContext.errorMessage =
              "Could not parse payment amount or recipient from voice input.";
          }
        } else if (event === PaymentEvent.PARSE_FAILED) {
          nextState = PaymentState.ERROR;
          updatedContext.errorMessage =
            payload.error || "Speech recognition parsing failed.";
        }
        break;

      case PaymentState.RATE_QUOTED:
        if (event === PaymentEvent.SUBMIT_PIN) {
          nextState = PaymentState.AWAITING_PIN;
        } else if (event === PaymentEvent.PIN_VALIDATED) {
          nextState = PaymentState.SETTLING_STELLAR;
          updatedContext.pinAttempts = 0;
        }
        break;

      case PaymentState.AWAITING_PIN:
        if (event === PaymentEvent.PIN_VALIDATED) {
          nextState = PaymentState.SETTLING_STELLAR;
          updatedContext.pinAttempts = 0;
        } else if (event === PaymentEvent.PIN_INVALID) {
          const attempts = (updatedContext.pinAttempts || 0) + 1;
          updatedContext.pinAttempts = attempts;
          if (attempts >= 3) {
            nextState = PaymentState.ERROR;
            updatedContext.errorMessage =
              "Too many invalid PIN attempts. Session locked.";
          } else {
            nextState = PaymentState.AWAITING_PIN;
            updatedContext.errorMessage = `Invalid PIN. ${3 - attempts} attempt(s) remaining.`;
          }
        }
        break;

      case PaymentState.SETTLING_STELLAR:
        if (event === PaymentEvent.STELLAR_SUCCESS) {
          nextState = PaymentState.RECEIPT_DELIVERED;
          updatedContext.stellarTxHash =
            payload.txHash || `stellar_tx_${Date.now().toString(16)}`;
          updatedContext.settledAt = new Date().toISOString();
        } else if (event === PaymentEvent.STELLAR_FAILED) {
          nextState = PaymentState.ERROR;
          updatedContext.errorMessage =
            payload.error || "Stellar settlement failed on ledger.";
        }
        break;

      case PaymentState.RECEIPT_DELIVERED:
        if (
          event === PaymentEvent.RECEIPT_SENT ||
          event === PaymentEvent.RESET
        ) {
          nextState = PaymentState.COMPLETED;
        }
        break;

      case PaymentState.COMPLETED:
      case PaymentState.ERROR:
        if (event === PaymentEvent.RESET) {
          nextState = PaymentState.IDLE;
          updatedContext = { ...this.initialContext };
        }
        break;

      default:
        break;
    }

    if (event === PaymentEvent.RESET) {
      nextState = PaymentState.IDLE;
      updatedContext = { ...this.initialContext };
    }

    this.state = nextState;
    this.context = updatedContext;
    this._recordSnapshot(event);

    const transitionInfo = {
      event,
      from: prevState,
      to: nextState,
      payload,
    };

    this._notify(transitionInfo);
    return transitionInfo;
  }

  /**
   * Rollback the state machine to a previous snapshot index in the timeline.
   */
  rollback(targetIndex) {
    if (targetIndex < 0 || targetIndex >= this.history.length) {
      throw new Error(`Invalid timeline rollback index: ${targetIndex}`);
    }

    const targetSnapshot = this.history[targetIndex];
    this.state = targetSnapshot.state;
    this.context = { ...targetSnapshot.context };

    // Truncate history up to target index + 1
    this.history = this.history.slice(0, targetIndex + 1);

    const transitionInfo = {
      event: PaymentEvent.ROLLBACK,
      from: "ROLLBACK",
      to: this.state,
      payload: { targetIndex },
    };

    this._notify(transitionInfo);
    return transitionInfo;
  }
}
