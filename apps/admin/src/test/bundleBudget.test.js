import { describe, it, expect, vi } from 'vitest';
import { enforceEntryChunkBudget, splitVendorChunks } from '../../../../scripts/vite-bundle-budget.mjs';

describe('enforceEntryChunkBudget Vite plugin', () => {
  it('passes when all entry chunks are within the 250 KB budget', () => {
    const plugin = enforceEntryChunkBudget({ maxEntryKb: 250 });
    const ctx = { error: vi.fn() };

    plugin.generateBundle.call(ctx, {}, {
      'assets/index.js': {
        type: 'chunk',
        isEntry: true,
        fileName: 'assets/index.js',
        code: 'a'.repeat(120 * 1024),
      },
      'assets/lazy.js': {
        type: 'chunk',
        isEntry: false,
        fileName: 'assets/lazy.js',
        code: 'b'.repeat(800 * 1024),
      },
      'assets/style.css': {
        type: 'asset',
        fileName: 'assets/style.css',
        source: 'body{}',
      },
    });

    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('fails the build when an initial entry chunk exceeds the 250 KB budget', () => {
    const plugin = enforceEntryChunkBudget({ maxEntryKb: 250 });
    const ctx = { error: vi.fn() };

    plugin.generateBundle.call(ctx, {}, {
      'assets/index.js': {
        type: 'chunk',
        isEntry: true,
        fileName: 'assets/index.js',
        code: 'x'.repeat(260 * 1024),
      },
    });

    expect(ctx.error).toHaveBeenCalledTimes(1);
    expect(ctx.error.mock.calls[0][0]).toMatch(/assets\/index\.js/);
    expect(ctx.error.mock.calls[0][0]).toMatch(/250 KB budget/);
  });
});

describe('splitVendorChunks', () => {
  it('splits React framework libraries into vendor-react and leaves app code undefined', () => {
    expect(splitVendorChunks('/repo/node_modules/react/index.js')).toBe('vendor-react');
    expect(splitVendorChunks('/repo/node_modules/react-dom/client.js')).toBe('vendor-react');
    expect(splitVendorChunks('/repo/node_modules/react-router-dom/index.js')).toBe('vendor-react');
    expect(splitVendorChunks('/repo/apps/admin/src/App.jsx')).toBeUndefined();
  });
});
