import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import GlobalSearchModal from "./GlobalSearchModal";
import HighlightMatch from "./HighlightMatch";
import { getRecordCategory } from "@/lib/searchUtils";

describe("GlobalSearchModal Component", () => {
  const sampleResults = [
    {
      _id: "user-123",
      category: "Users",
      whatsappName: "Alice Crypto",
      phoneNumber: "+2348011223344",
      kycStatus: "VERIFIED",
    },
    {
      _id: "tx-456",
      category: "Transactions",
      amount: "150",
      asset: "USDC",
      status: "COMPLETED",
      txHash: "0xabcdef123456",
      phoneNumber: "+2348011223344",
    },
    {
      _id: "wallet-789",
      category: "Stellar Accounts",
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      network: "testnet",
      phoneNumber: "+2348099887766",
      label: "Escrow Operations Vault",
    },
  ];

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <MemoryRouter>
        <GlobalSearchModal isOpen={false} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders modal with input field when isOpen is true", () => {
    render(
      <MemoryRouter>
        <GlobalSearchModal isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("global-search-modal")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-input")).toBeInTheDocument();
  });

  it("calls onClose when Escape key is pressed", async () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <GlobalSearchModal isOpen={true} onClose={handleClose} />
      </MemoryRouter>,
    );

    const input = screen.getByTestId("global-search-input");
    await userEvent.type(input, "{Escape}");

    expect(handleClose).toHaveBeenCalled();
  });

  it("allows user to type into search input", async () => {
    render(
      <MemoryRouter>
        <GlobalSearchModal isOpen={true} onClose={vi.fn()} />
      </MemoryRouter>,
    );

    const input = screen.getByTestId("global-search-input");
    await userEvent.type(input, "USDC");

    expect(input).toHaveValue("USDC");
  });

  it("groups search results into titled sections with distinct iconography and category badges", () => {
    render(
      <MemoryRouter>
        <GlobalSearchModal
          isOpen={true}
          onClose={vi.fn()}
          initialResults={sampleResults}
        />
      </MemoryRouter>,
    );

    // Verify titled sections exist
    expect(screen.getByTestId("search-category-users")).toBeInTheDocument();
    expect(
      screen.getByTestId("search-category-transactions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("search-category-stellar-accounts"),
    ).toBeInTheDocument();

    // Verify section titles
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Stellar Accounts")).toBeInTheDocument();

    // Verify category badges
    expect(screen.getByTestId("badge-users")).toHaveTextContent("User");
    expect(screen.getByTestId("badge-transactions")).toHaveTextContent(
      "Transaction",
    );
    expect(screen.getByTestId("badge-stellar-accounts")).toHaveTextContent(
      "Stellar Account",
    );

    // Verify metadata snippets
    expect(screen.getByText("Alice Crypto")).toBeInTheDocument();
    expect(screen.getByText(/150 USDC/i)).toBeInTheDocument();
    expect(screen.getByText("Escrow Operations Vault")).toBeInTheDocument();
    expect(screen.getByText(/KYC: VERIFIED/i)).toBeInTheDocument();
  });

  it("highlights matching search query terms", async () => {
    render(
      <MemoryRouter>
        <GlobalSearchModal
          isOpen={true}
          onClose={vi.fn()}
          initialResults={sampleResults}
        />
      </MemoryRouter>,
    );

    const input = screen.getByTestId("global-search-input");
    await userEvent.type(input, "Alice");

    const marks = screen.getAllByText("Alice");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].tagName.toLowerCase()).toBe("mark");
  });

  describe("Helper units", () => {
    it("getRecordCategory infers correct category", () => {
      expect(getRecordCategory({ category: "Users" })).toBe("Users");
      expect(getRecordCategory({ category: "Transactions" })).toBe(
        "Transactions",
      );
      expect(getRecordCategory({ category: "Stellar Accounts" })).toBe(
        "Stellar Accounts",
      );
      expect(getRecordCategory({ publicKey: "GB..." })).toBe("Stellar Accounts");
      expect(getRecordCategory({ whatsappName: "Bob" })).toBe("Users");
      expect(getRecordCategory({ txHash: "0x123" })).toBe("Transactions");
    });

    it("HighlightMatch marks matched queries properly", () => {
      const { container } = render(
        <HighlightMatch text="Sender Alice Sent Funds" query="Alice" />,
      );
      const mark = container.querySelector("mark");
      expect(mark).toBeInTheDocument();
      expect(mark.textContent).toBe("Alice");
    });
  });
});
