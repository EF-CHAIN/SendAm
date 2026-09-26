import "@testing-library/jest-dom";
import { afterEach, beforeAll, afterAll, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";
import { server } from "./mocks/server";

expect.extend(toHaveNoViolations);

// Setup Mock Service Worker (MSW) for API mocking
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  if (typeof window.URL.createObjectURL === "undefined") {
    window.URL.createObjectURL = () => "blob:mock-url";
  }
  if (typeof window.URL.revokeObjectURL === "undefined") {
    window.URL.revokeObjectURL = () => {};
  }
  if (!Blob.prototype.text) {
    Blob.prototype.text = function () {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsText(this);
      });
    };
  }
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
