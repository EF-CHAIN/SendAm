import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi } from "vitest";
import GlobalSearchModal from "./GlobalSearchModal";

describe("GlobalSearchModal Component", () => {
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
});
