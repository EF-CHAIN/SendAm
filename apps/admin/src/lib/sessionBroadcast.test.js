import { describe, it, expect, beforeEach, vi } from "vitest";
import { sessionBroadcast, SessionEventType } from "./sessionBroadcast";

describe("sessionBroadcast multi-tab synchronization", () => {
  beforeEach(() => {
    sessionBroadcast.close();
  });

  it("allows subscribing and receiving broadcast events", () => {
    const listener = vi.fn();
    const unsubscribe = sessionBroadcast.subscribe(listener);

    sessionBroadcast._notify(SessionEventType.AUTH_LOGOUT, {
      reason: "session_expired",
    });

    expect(listener).toHaveBeenCalledWith(SessionEventType.AUTH_LOGOUT, {
      reason: "session_expired",
    });

    unsubscribe();
    sessionBroadcast._notify(SessionEventType.AUTH_LOGIN, {
      token: "new_token",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("broadcasts AUTH_LOGIN and AUTH_LOGOUT across channels", () => {
    // In node/JSDOM mock, verifying postMessage invocation
    const mockPostMessage = vi.fn();
    sessionBroadcast.channel = { postMessage: mockPostMessage, close: vi.fn() };

    sessionBroadcast.broadcast(SessionEventType.AUTH_LOGOUT);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SessionEventType.AUTH_LOGOUT,
        timestamp: expect.any(Number),
      }),
    );

    sessionBroadcast.broadcast(SessionEventType.AUTH_LOGIN, {
      token: "jwt_123",
    });
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SessionEventType.AUTH_LOGIN,
        payload: { token: "jwt_123" },
      }),
    );
  });
});
