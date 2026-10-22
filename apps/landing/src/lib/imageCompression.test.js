import { describe, expect, it, vi } from 'vitest';
import { compressImageForUpload, ImageCompressionError } from './imageCompression.js';

const bytes = (size) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
const photo = (size) => new File([new Uint8Array(size)], 'id.jpg', { type: 'image/jpeg' });

function fakeCanvasDeps({ width = 4000, height = 3000, encodedSizes }) {
  const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvases = [];
  const close = vi.fn();
  const encode = vi.fn(async () => {
    const index = encode.mock.calls.length - 1;
    return bytes(encodedSizes[Math.min(index, encodedSizes.length - 1)]);
  });
  return {
    ctx,
    close,
    encode,
    canvases,
    deps: {
      decode: vi.fn(async () => ({ source: {}, width, height, close })),
      createCanvas: vi.fn((w, h) => {
        const canvas = { width: w, height: h, getContext: () => ctx };
        canvases.push(canvas);
        return canvas;
      }),
      encode,
    },
  };
}

describe('compressImageForUpload', () => {
  it('returns the original file untouched when it is already under budget', async () => {
    const file = photo(500);
    const decode = vi.fn();
    const result = await compressImageForUpload(file, { maxBytes: 1000, deps: { decode } });

    expect(result).toBe(file);
    expect(decode).not.toHaveBeenCalled();
  });

  it('rejects files that are not images', async () => {
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await expect(compressImageForUpload(text)).rejects.toMatchObject({ code: 'type' });
  });

  it('downsamples oversized photos to the long-edge limit and encodes JPEG under budget', async () => {
    const { deps, canvases, ctx, encode, close } = fakeCanvasDeps({ encodedSizes: [1500, 900] });
    const progress = [];

    const result = await compressImageForUpload(photo(5000), {
      maxBytes: 1000,
      maxDimension: 2000,
      qualitySteps: [0.9, 0.8, 0.7],
      onProgress: (p) => progress.push(p),
      deps,
    });

    expect(canvases[0]).toMatchObject({ width: 2000, height: 1500 });
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 2000, 1500);
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(encode.mock.calls.map(([, quality]) => quality)).toEqual([0.9, 0.8]);
    expect(result.size).toBe(900);
    expect(close).toHaveBeenCalledTimes(1);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBeGreaterThan(50);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('keeps images already within the long-edge limit at native size', async () => {
    const { deps, canvases } = fakeCanvasDeps({ width: 800, height: 600, encodedSizes: [400] });
    await compressImageForUpload(photo(5000), { maxBytes: 1000, deps });
    expect(canvases[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('fails with a clear error when no quality step fits the budget', async () => {
    const { deps, close } = fakeCanvasDeps({ encodedSizes: [5000] });

    const error = await compressImageForUpload(photo(5000), {
      maxBytes: 1000,
      qualitySteps: [0.9, 0.5],
      deps,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ImageCompressionError);
    expect(error.code).toBe('too-large');
    expect(error.message).toMatch(/1 MB/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
