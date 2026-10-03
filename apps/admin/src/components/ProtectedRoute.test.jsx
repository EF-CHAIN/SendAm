import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ProtectedRoute from "./ProtectedRoute";
import { describe, it, expect, beforeEach } from "vitest";
import { setToken, removeToken } from "../lib/auth";
import { adminLogin } from "../lib/adminApi"; // Ensures interceptor is attached
import { server } from "../mocks/server";
import { http, HttpResponse } from "msw";

const TestDashboard = () => <div data-testid="dashboard">Dashboard</div>;
const TestLogin = () => <div data-testid="login-page">Login Page</div>;

const renderApp = (initialRoute = "/") => {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Routes>
        <Route path="/login" element={<TestLogin />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <TestDashboard />
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
};

describe("ProtectedRoute & Session Expiry", () => {
  beforeEach(() => {
    removeToken();
  });

  it("redirects to login if not authenticated", () => {
    renderApp();
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });

  it("renders children if authenticated", () => {
    setToken("valid_token");
    renderApp();
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("login-page")).not.toBeInTheDocument();
  });

  it("handles session expiry (401 from API) via adminApi interceptor", async () => {
    setToken("expired_token");

    server.use(
      http.post("*/api/admin/login", () => {
        return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
      }),
    );

    try {
      await adminLogin("operator@example.com", "wrong");
    } catch (e) {
      console.log("CAUGHT ERROR", e.message, e.response?.status);
    }

    expect(localStorage.getItem("adminToken")).toBeNull();
  });

  it("triggers immediate redirect to login when AUTH_LOGOUT is received via BroadcastChannel", async () => {
    setToken("valid_token");
    const { sessionBroadcast, SessionEventType } =
      await import("../lib/sessionBroadcast");

    renderApp();
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();

    // Simulate incoming cross-tab logout broadcast
    sessionBroadcast._notify(SessionEventType.AUTH_LOGOUT);

    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeInTheDocument();
      expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
    });
  });
});
