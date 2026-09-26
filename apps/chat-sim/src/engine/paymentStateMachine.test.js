import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaymentStateMachine,
  PaymentState,
  PaymentEvent,
} from "./paymentStateMachine";

const mockFn = typeof vi !== "undefined" ? vi.fn : jest.fn;

describe("PaymentStateMachine Engine", () => {
  let sm;

  beforeEach(() => {
    sm = new PaymentStateMachine();
  });

  it("initializes in IDLE state with default context", () => {
    expect(sm.getState()).toBe(PaymentState.IDLE);
    expect(sm.getContext()).toMatchObject({
      amount: null,
      asset: "USDC",
      recipient: null,
      errorMessage: null,
    });
    expect(sm.getHistory()).toHaveLength(1);
    expect(sm.getHistory()[0].action).toBe("INITIALIZE");
  });

  it("correctly parses natural voice payment intent strings", () => {
    const intent1 = sm.parsePaymentIntent("Send 20 dollars to Ada");
    expect(intent1).toEqual({
      amount: 20,
      asset: "USD",
      recipient: "Ada",
    });

    const intent2 = sm.parsePaymentIntent(
      "Transfer 100 USDC to +2348012345678",
    );
    expect(intent2).toEqual({
      amount: 100,
      asset: "USDC",
      recipient: "+2348012345678",
    });

    const intent3 = sm.parsePaymentIntent("Pay 50.5 XLM to Chinedu");
    expect(intent3).toEqual({
      amount: 50.5,
      asset: "XLM",
      recipient: "Chinedu",
    });
  });

  it("transitions deterministically through the complete voice-to-settlement lifecycle", () => {
    // 1. Start Voice Command
    sm.transition(PaymentEvent.START_VOICE_COMMAND);
    expect(sm.getState()).toBe(PaymentState.PARSING_VOICE);

    // 2. Voice Parsed -> RateQuoted
    sm.transition(PaymentEvent.VOICE_PARSED, {
      text: "Send 25 dollars to Ada",
    });
    expect(sm.getState()).toBe(PaymentState.RATE_QUOTED);
    expect(sm.getContext().amount).toBe(25);
    expect(sm.getContext().recipient).toBe("Ada");

    // 3. User submits PIN -> AwaitingPin
    sm.transition(PaymentEvent.SUBMIT_PIN);
    expect(sm.getState()).toBe(PaymentState.AWAITING_PIN);

    // 4. PIN Validated -> SettlingStellar
    sm.transition(PaymentEvent.PIN_VALIDATED);
    expect(sm.getState()).toBe(PaymentState.SETTLING_STELLAR);

    // 5. Stellar Success -> ReceiptDelivered
    sm.transition(PaymentEvent.STELLAR_SUCCESS, { txHash: "0xstellar_abc123" });
    expect(sm.getState()).toBe(PaymentState.RECEIPT_DELIVERED);
    expect(sm.getContext().stellarTxHash).toBe("0xstellar_abc123");

    // 6. Receipt Sent -> Completed
    sm.transition(PaymentEvent.RECEIPT_SENT);
    expect(sm.getState()).toBe(PaymentState.COMPLETED);
  });

  it("handles invalid PIN attempts and locks after 3 tries", () => {
    sm.transition(PaymentEvent.QUOTE_GENERATED, {
      amount: 50,
      recipient: "Bob",
    });
    sm.transition(PaymentEvent.SUBMIT_PIN);
    expect(sm.getState()).toBe(PaymentState.AWAITING_PIN);

    sm.transition(PaymentEvent.PIN_INVALID);
    expect(sm.getState()).toBe(PaymentState.AWAITING_PIN);
    expect(sm.getContext().pinAttempts).toBe(1);

    sm.transition(PaymentEvent.PIN_INVALID);
    expect(sm.getContext().pinAttempts).toBe(2);

    sm.transition(PaymentEvent.PIN_INVALID);
    expect(sm.getState()).toBe(PaymentState.ERROR);
    expect(sm.getContext().errorMessage).toContain(
      "Too many invalid PIN attempts",
    );
  });

  it("supports rollback to previous snapshots in the timeline", () => {
    sm.transition(PaymentEvent.START_VOICE_COMMAND);
    sm.transition(PaymentEvent.VOICE_PARSED, {
      text: "Send 10 dollars to Ada",
    });
    expect(sm.getState()).toBe(PaymentState.RATE_QUOTED);

    sm.transition(PaymentEvent.SUBMIT_PIN);
    expect(sm.getState()).toBe(PaymentState.AWAITING_PIN);

    // Rollback to index 2 (RATE_QUOTED)
    sm.rollback(2);
    expect(sm.getState()).toBe(PaymentState.RATE_QUOTED);
    expect(sm.getContext().amount).toBe(10);
    expect(sm.getHistory()).toHaveLength(3);
  });

  it("notifies subscribers on state transitions", () => {
    const listener = mockFn();
    const unsubscribe = sm.subscribe(listener);

    sm.transition(PaymentEvent.START_VOICE_COMMAND);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        state: PaymentState.PARSING_VOICE,
        transition: expect.objectContaining({
          event: PaymentEvent.START_VOICE_COMMAND,
          from: PaymentState.IDLE,
          to: PaymentState.PARSING_VOICE,
        }),
      }),
    );

    unsubscribe();
    sm.transition(PaymentEvent.RESET);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
