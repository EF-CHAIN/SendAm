import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy } from 'react';
import LazySection from './LazySection.jsx';

let observers;
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.disconnect = vi.fn();
    observers.push(this);
  }
  observe(node) {
    this.node = node;
  }
  enter() {
    act(() => this.callback([{ isIntersecting: true, target: this.node }]));
  }
}

const deferredComponent = () => {
  let resolve;
  const loader = vi.fn(() => new Promise((r) => { resolve = r; }));
  const Component = lazy(loader);
  return { loader, Component, resolve: (el) => resolve({ default: () => el }) };
};

beforeEach(() => {
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('LazySection', () => {
  it('does not load the chunk until the section nears the viewport', async () => {
    const { loader, Component, resolve } = deferredComponent();
    render(
      <LazySection id="calculator" label="Currency calculator" minHeight={700}>
        <Component />
      </LazySection>,
    );
    const placeholder = screen.getByTestId('lazy-section-placeholder');
    expect(placeholder).toHaveAttribute('id', 'calculator');
    expect(placeholder).toHaveStyle({ minHeight: '700px' });
    expect(loader).not.toHaveBeenCalled();
    expect(observers[0].options.rootMargin).toBe('300px 0px');

    observers[0].enter();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnect).toHaveBeenCalled();
    await act(async () => resolve(<p>Loaded calculator</p>));
    expect(await screen.findByText('Loaded calculator')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-section-placeholder')).not.toBeInTheDocument();
  });

  it('loads immediately when the URL targets the section', async () => {
    window.history.replaceState(null, '', '/#calculator');
    const { loader, Component } = deferredComponent();
    render(
      <LazySection id="calculator" label="Currency calculator">
        <Component />
      </LazySection>,
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(0);
  });

  it('loads immediately when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { loader, Component } = deferredComponent();
    render(
      <LazySection id="geo" label="Payment corridors">
        <Component />
      </LazySection>,
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('contains a failed chunk load to the section and allows a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let chunkAvailable = false;
    const Flaky = () => {
      if (!chunkAvailable) throw new Error('chunk failed');
      return <p>Recovered</p>;
    };
    vi.stubGlobal('IntersectionObserver', undefined);
    render(
      <LazySection id="geo" label="Payment corridors">
        <Flaky />
      </LazySection>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Payment corridors could not be loaded.');
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'geo');
    chunkAvailable = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });
});
