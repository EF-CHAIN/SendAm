import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Faq from './Faq.jsx';

describe('Faq', () => {
  it('renders every question collapsed by default', () => {
    render(<Faq />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
    expect(
      screen.queryByText(/no\. users interact through whatsapp/i)
    ).not.toBeInTheDocument();
  });

  it('reveals the answer on click and updates aria-expanded', async () => {
    const user = userEvent.setup();
    render(<Faq />);

    const question = screen.getByRole('button', { name: /do users need to understand crypto/i });
    await user.click(question);

    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/no\. users interact through whatsapp/i)).toBeInTheDocument();

    await user.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByText(/no\. users interact through whatsapp/i)
    ).not.toBeInTheDocument();
  });

  it('is keyboard-operable: Enter and Space toggle the answer', async () => {
    const user = userEvent.setup();
    render(<Faq />);

    await user.tab();
    const firstQuestion = screen.getByRole('button', {
      name: /do users need to understand crypto/i,
    });
    expect(firstQuestion).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(firstQuestion).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard(' ');
    expect(firstQuestion).toHaveAttribute('aria-expanded', 'false');
  });

  it('wraps each question in a heading for screen-reader navigation', () => {
    render(<Faq />);
    expect(screen.getByRole('heading', { name: /which blockchain does sendam use/i })).toBeInTheDocument();
  });
});
