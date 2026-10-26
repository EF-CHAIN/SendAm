import { afterEach, describe, expect, it, vi } from 'vitest';
import { swUpdate } from './swUpdate.js';

afterEach(() => swUpdate.reset());

describe('swUpdate', () => {
  it('flags a waiting update and notifies subscribers', () => {
    const listener = vi.fn();
    swUpdate.subscribe(listener);
    swUpdate.needRefresh(vi.fn());
    expect(swUpdate.getState().needRefresh).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ needRefresh: true }));
  });

  it('activates the waiting worker with reload=true when asked', async () => {
    const updateSW = vi.fn().mockResolvedValue(undefined);
    swUpdate.needRefresh(updateSW);
    await expect(swUpdate.reload()).resolves.toBe(true);
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('does nothing when no update is waiting', async () => {
    await expect(swUpdate.reload()).resolves.toBe(false);
  });

  it('can be dismissed and unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = swUpdate.subscribe(listener);
    swUpdate.offlineReady();
    expect(swUpdate.getState().offlineReady).toBe(true);
    unsubscribe();
    swUpdate.needRefresh(vi.fn());
    swUpdate.dismiss();
    expect(swUpdate.getState()).toEqual({ needRefresh: false, offlineReady: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
