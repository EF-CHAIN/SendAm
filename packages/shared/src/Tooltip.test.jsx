import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Tooltip from './Tooltip.jsx';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default viewport mock
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders children trigger normally and does not show tooltip initially', () => {
    render(
      <Tooltip content="Helper text">
        <button>Trigger</button>
      </Tooltip>
    );

    const button = screen.getByText('Trigger');
    expect(button).toBeDefined();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('shows tooltip on mouseEnter and hides on mouseLeave', () => {
    render(
      <Tooltip content="Helper text" delay={0}>
        <button>Hover me</button>
      </Tooltip>
    );

    const button = screen.getByText('Hover me');

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeDefined();
    expect(tooltip.textContent).toBe('Helper text');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);

    act(() => {
      fireEvent.mouseLeave(button);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('is accessible via keyboard focus (shows on focus, hides on blur)', () => {
    render(
      <Tooltip content="Keyboard accessible" delay={0}>
        <button>Focus me</button>
      </Tooltip>
    );

    const button = screen.getByText('Focus me');

    act(() => {
      fireEvent.focus(button);
    });

    expect(screen.getByRole('tooltip')).toBeDefined();
    expect(screen.getByRole('tooltip').textContent).toBe('Keyboard accessible');

    act(() => {
      fireEvent.blur(button);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses tooltip when Escape key is pressed', () => {
    render(
      <Tooltip content="Press ESC to close" delay={0}>
        <button>Trigger</button>
      </Tooltip>
    );

    const button = screen.getByText('Trigger');

    act(() => {
      fireEvent.focus(button);
    });

    expect(screen.getByRole('tooltip')).toBeDefined();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not display tooltip when disabled is true', () => {
    render(
      <Tooltip content="Disabled info" disabled={true} delay={0}>
        <button>Disabled</button>
      </Tooltip>
    );

    const button = screen.getByText('Disabled');

    act(() => {
      fireEvent.mouseEnter(button);
      fireEvent.focus(button);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('respects delay before displaying tooltip', () => {
    render(
      <Tooltip content="Delayed tooltip" delay={300}>
        <button>Hover</button>
      </Tooltip>
    );

    const button = screen.getByText('Hover');

    act(() => {
      fireEvent.mouseEnter(button);
    });

    // Not yet visible before delay
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByRole('tooltip')).toBeDefined();
  });

  it('automatically flips from top to bottom when colliding with top screen boundary', () => {
    render(
      <Tooltip content="Flipped" placement="top" delay={0}>
        <button>Top edge button</button>
      </Tooltip>
    );

    const button = screen.getByText('Top edge button');

    // Mock button near top edge: top = 10px, bottom = 40px
    button.getBoundingClientRect = () => ({
      top: 10,
      bottom: 40,
      left: 100,
      right: 200,
      width: 100,
      height: 30,
    });

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    tooltip.getBoundingClientRect = () => ({
      top: 0,
      bottom: 30,
      left: 0,
      right: 120,
      width: 120,
      height: 30,
    });

    // Trigger update
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(tooltip.getAttribute('data-placement')).toBe('bottom');
  });

  it('automatically flips from bottom to top when colliding with bottom screen boundary', () => {
    window.innerHeight = 500;

    render(
      <Tooltip content="Bottom to Top" placement="bottom" delay={0}>
        <button>Bottom edge button</button>
      </Tooltip>
    );

    const button = screen.getByText('Bottom edge button');

    // Mock button near bottom edge: top = 480, bottom = 495 (in 500px window)
    button.getBoundingClientRect = () => ({
      top: 480,
      bottom: 495,
      left: 100,
      right: 200,
      width: 100,
      height: 15,
    });

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    tooltip.getBoundingClientRect = () => ({
      top: 0,
      bottom: 30,
      left: 0,
      right: 120,
      width: 120,
      height: 30,
    });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(tooltip.getAttribute('data-placement')).toBe('top');
  });

  it('automatically flips from left to right when colliding with left screen boundary', () => {
    render(
      <Tooltip content="Left to Right" placement="left" delay={0}>
        <button>Left edge button</button>
      </Tooltip>
    );

    const button = screen.getByText('Left edge button');

    // Mock button near left edge: left = 5, right = 45
    button.getBoundingClientRect = () => ({
      top: 100,
      bottom: 130,
      left: 5,
      right: 45,
      width: 40,
      height: 30,
    });

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    tooltip.getBoundingClientRect = () => ({
      top: 0,
      bottom: 30,
      left: 0,
      right: 120,
      width: 120,
      height: 30,
    });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(tooltip.getAttribute('data-placement')).toBe('right');
  });

  it('automatically flips from right to left when colliding with right screen boundary', () => {
    window.innerWidth = 800;

    render(
      <Tooltip content="Right to Left" placement="right" delay={0}>
        <button>Right edge button</button>
      </Tooltip>
    );

    const button = screen.getByText('Right edge button');

    // Mock button near right edge: left = 750, right = 795 (in 800px window)
    button.getBoundingClientRect = () => ({
      top: 100,
      bottom: 130,
      left: 750,
      right: 795,
      width: 45,
      height: 30,
    });

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    tooltip.getBoundingClientRect = () => ({
      top: 0,
      bottom: 30,
      left: 0,
      right: 120,
      width: 120,
      height: 30,
    });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(tooltip.getAttribute('data-placement')).toBe('left');
  });

  it('clamps cross-axis coordinates to keep tooltip within viewport margins', () => {
    window.innerWidth = 500;

    render(
      <Tooltip content="Clamped Tooltip" placement="top" padding={10} delay={0}>
        <button>Edge button</button>
      </Tooltip>
    );

    const button = screen.getByText('Edge button');

    // Button near far left edge: center alignment would calculate negative left
    button.getBoundingClientRect = () => ({
      top: 200,
      bottom: 230,
      left: 0,
      right: 30,
      width: 30,
      height: 30,
    });

    act(() => {
      fireEvent.mouseEnter(button);
    });

    const tooltip = screen.getByRole('tooltip');
    tooltip.getBoundingClientRect = () => ({
      top: 0,
      bottom: 30,
      left: 0,
      right: 150,
      width: 150,
      height: 30,
    });

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    // Without clamping: left = 0 + (30 - 150) / 2 = -60px.
    // Clamped with padding=10: should be >= 10px.
    const leftVal = parseFloat(tooltip.style.left);
    expect(leftVal).toBe(10);
  });
});
