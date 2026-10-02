import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import Footer from "./Footer.jsx";
import { ADMIN_URL, GITHUB_URL, STELLAR_URL } from "@/lib/links.js";

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
});
