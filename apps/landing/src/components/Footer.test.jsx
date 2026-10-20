import { describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import Footer from "./Footer.jsx";
import { ADMIN_URL, GITHUB_URL, STELLAR_URL, STELLAR_STATUS_URL } from "@/lib/links.js";

function renderFooter() {
  return render(<Footer />);
}

describe("Footer", () => {
  it("marks external links with an icon and a screen-reader new-window note", () => {
    renderFooter();

    for (const name of [/^GitHub/, /^Stellar/]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("target", "_blank");
      // External-tab links must carry noopener/noreferrer so the new tab
      // can't reach back into this page via window.opener.
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(link).toHaveAttribute(
        "rel",
        expect.stringContaining("noreferrer"),
      );
      // Screen readers announce the new-window behavior through the
      // visually-hidden text folded into the accessible name.
      expect(link).toHaveAccessibleName(/opens in new window/i);
      // The visual icon is decorative: hidden from assistive tech.
      const icon = link.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("points the external links at the configured destinations", () => {
    renderFooter();

    expect(screen.getByRole("link", { name: /^GitHub/ })).toHaveAttribute(
      "href",
      GITHUB_URL,
    );
    expect(screen.getByRole("link", { name: /^Stellar/ })).toHaveAttribute(
      "href",
      STELLAR_URL,
    );
  });

  it("keeps in-page links free of new-tab behavior and notes", () => {
    renderFooter();

    const features = screen.getByRole("link", { name: "Features" });
    expect(features).toHaveAttribute("href", "#features");
    expect(features).not.toHaveAttribute("target");
    expect(features).toHaveAccessibleName("Features");
    expect(features.querySelector("svg")).toBeNull();
  });

  it("links the admin dashboard at the configured admin URL in the same tab", () => {
    renderFooter();

    const admin = screen.getByRole("link", { name: "Admin dashboard" });
    expect(admin).toHaveAttribute("href", ADMIN_URL);
    expect(admin).not.toHaveAttribute("target");
    expect(admin.querySelector("svg")).toBeNull();
  });

  it("styles footer links with the shared hover and focus-visible tokens", () => {
    renderFooter();

    const developers = screen.getByText("Developers").closest("div");
    const links = within(developers).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toMatch(/hover:text-primary/);
      expect(link.className).toMatch(/focus-visible:outline/);
    }
  });

  it("renders the live Stellar network ping badge with pulsing dot and tooltip", () => {
    renderFooter();

    const badge = screen.getByRole("link", { name: /Stellar Mainnet/i });
    expect(badge).toHaveAttribute("href", STELLAR_STATUS_URL);
    expect(badge).toHaveAttribute("target", "_blank");
    expect(badge).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(badge).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(badge).toHaveAttribute("title", "View official Stellar network status page");
    expect(badge).toHaveAccessibleName(/Network status: Stellar Mainnet: Operational/i);

    // Verify pulsing dot structure
    const pingDot = badge.querySelector(".animate-ping");
    expect(pingDot).not.toBeNull();
    expect(pingDot.className).toContain("motion-reduce:hidden");
  });

  it("updates badge status when live network status API returns non-operational indicators", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: { indicator: "minor", description: "Degraded performance" },
      }),
    });

    try {
      renderFooter();
      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /Stellar Mainnet: Degraded/i })
        ).toBeInTheDocument();
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
