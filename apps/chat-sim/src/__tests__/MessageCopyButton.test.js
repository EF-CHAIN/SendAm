import { AccessibilityInfo, Animated } from 'react-native';
import { act, create } from 'react-test-renderer';
import * as Clipboard from 'expo-clipboard';
import MessageCopyButton from '../MessageCopyButton';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const text = 'Deposit: GABC123\nReference: 你好 💸  ';
let renderer;
const button = () => renderer.root.findAll((node) => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')[0];
const label = () => button().props.accessibilityLabel;
const press = () => act(async () => { await button().props.onPress(); });
const advance = (ms) => act(() => jest.advanceTimersByTime(ms));

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true);
  await act(async () => { renderer = create(<MessageCopyButton text={text} />); });
});
afterEach(() => {
  act(() => renderer.unmount());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('copies the exact full text and shows success for exactly one second', async () => {
  await press();
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(text);
  expect(label()).toBe('Message copied');
  advance(999);
  expect(label()).toBe('Message copied');
  advance(1);
  expect(label()).toBe('Copy message');
});

it('restarts feedback after repeated successful clicks', async () => {
  await press();
  advance(700);
  await press();
  advance(300);
  expect(label()).toBe('Message copied');
  advance(700);
  expect(label()).toBe('Copy message');
});

it.each(['false', 'reject', 'unavailable'])('reports %s failure without success and permits retry', async (failure) => {
  if (failure === 'false') Clipboard.setStringAsync.mockResolvedValueOnce(false);
  if (failure === 'reject') Clipboard.setStringAsync.mockRejectedValueOnce(new Error('Denied'));
  if (failure === 'unavailable') Clipboard.setStringAsync.mockImplementationOnce(() => { throw new Error('Unavailable'); });
  await press();
  expect(label()).toBe('Copy failed. Try again');
  expect(jest.getTimerCount()).toBe(0);
  await press();
  expect(label()).toBe('Message copied');
});

it('does not show success before the clipboard resolves', async () => {
  let resolve;
  Clipboard.setStringAsync.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  let pending;
  act(() => { pending = button().props.onPress(); });
  expect(label()).toBe('Copy message');
  await act(async () => { resolve(true); await pending; });
  expect(label()).toBe('Message copied');
});

it('ignores stale resolutions after a newer copy', async () => {
  let resolve;
  Clipboard.setStringAsync.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  let pending;
  act(() => { pending = button().props.onPress(); });
  Clipboard.setStringAsync.mockResolvedValueOnce(false);
  await press();
  await act(async () => { resolve(true); await pending; });
  expect(label()).toBe('Copy failed. Try again');
  expect(jest.getTimerCount()).toBe(0);
});

it('clears feedback timers when unmounted', async () => {
  await press();
  expect(jest.getTimerCount()).toBe(1);
  act(() => renderer.unmount());
  expect(jest.getTimerCount()).toBe(0);
});

it('does not schedule feedback after unmount during a pending write', async () => {
  let resolve;
  Clipboard.setStringAsync.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  let pending;
  act(() => { pending = button().props.onPress(); });
  act(() => renderer.unmount());
  await act(async () => { resolve(true); await pending; });
  expect(jest.getTimerCount()).toBe(0);
});

it('resets feedback and invalidates pending work when text changes', async () => {
  await press();
  await act(async () => renderer.update(<MessageCopyButton text="New text" />));
  expect(label()).toBe('Copy message');
  expect(jest.getTimerCount()).toBe(0);
  await press();
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('New text');
});

it('reveals a hidden desktop action on keyboard focus', () => {
  act(() => renderer.update(<MessageCopyButton text={text} visible={false} />));
  expect(button().props.style.opacity).toBe(0);
  act(() => button().props.onFocus());
  expect(button().props.style.opacity).toBe(1);
  expect(button().props.accessibilityRole).toBe('button');
  act(() => button().props.onBlur());
  expect(button().props.style.opacity).toBe(0);
});


it('animates successful feedback and stops the animation on unmount', async () => {
  act(() => renderer.unmount());
  AccessibilityInfo.isReduceMotionEnabled.mockResolvedValue(false);
  const start = jest.fn();
  const stop = jest.fn();
  const timing = jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop });
  await act(async () => { renderer = create(<MessageCopyButton text={text} />); });
  await press();
  expect(timing).toHaveBeenCalledWith(expect.anything(), {
    toValue: 1, duration: 120, useNativeDriver: true,
  });
  expect(start).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
  expect(stop).toHaveBeenCalled();
});

it('respects reduced motion while retaining one-second success feedback', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  await press();
  expect(timing).not.toHaveBeenCalled();
  expect(label()).toBe('Message copied');
  advance(1000);
  expect(label()).toBe('Copy message');
});


it('ignores a pending clipboard completion after message text changes', async () => {
  let resolve;
  Clipboard.setStringAsync.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  let pending;
  act(() => { pending = button().props.onPress(); });
  await act(async () => renderer.update(<MessageCopyButton text="Replacement" />));
  await act(async () => { resolve(true); await pending; });
  expect(label()).toBe('Copy message');
  expect(jest.getTimerCount()).toBe(0);
});


it('passes concrete sizing and interaction styles through NativeWind', () => {
  expect(typeof button().props.style).toBe('object');
  expect(button().props.style.minWidth).toBe(44);
  expect(button().props.style.minHeight).toBe(44);
  expect(button().props.style.backgroundColor).toBe('transparent');
  act(() => button().props.onHoverIn());
  expect(button().props.style.backgroundColor).toBe('#d1d5db');
  act(() => button().props.onHoverOut());
  expect(button().props.style.backgroundColor).toBe('transparent');
  act(() => button().props.onPressIn());
  expect(button().props.style.backgroundColor).toBe('#d1d5db');
  act(() => button().props.onPressOut());
  expect(button().props.style.backgroundColor).toBe('transparent');
  act(() => button().props.onFocus());
  expect(button().props.style.borderColor).toBe('#166534');
});
