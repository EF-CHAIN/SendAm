// Client-side downsampling for identity photos. Phone cameras produce 10MB+
// files that stall on slow 3G, so the photo is resized and re-encoded as JPEG
// in the browser before it is staged for upload.

export const MAX_UPLOAD_BYTES = 1024 * 1024;
// Long edge in pixels. Large enough that printed text stays legible for OCR.
export const MAX_IMAGE_DIMENSION = 2000;
// Tried in order until the output fits under the byte budget.
export const JPEG_QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5];

export class ImageCompressionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageCompressionError';
    this.code = code;
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new ImageCompressionError('decode', 'This file could not be read as an image.'));
      image.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageCompressionError('encode', 'Could not encode the photo.'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Returns a JPEG Blob no larger than `maxBytes`, or the original file when it
 * already fits. `onProgress` receives whole percentages from 0 to 100.
 *
 * `deps` lets tests supply decode and canvas behaviour; production uses the
 * browser defaults above.
 */
export async function compressImageForUpload(file, options = {}) {
  const {
    maxBytes = MAX_UPLOAD_BYTES,
    maxDimension = MAX_IMAGE_DIMENSION,
    qualitySteps = JPEG_QUALITY_STEPS,
    onProgress = () => {},
    deps = {},
  } = options;
  const decode = deps.decode ?? decodeImage;
  const makeCanvas = deps.createCanvas ?? createCanvas;
  const encode = deps.encode ?? canvasToJpeg;

  if (!file || !String(file.type).startsWith('image/')) {
    throw new ImageCompressionError('type', 'Please choose a photo file.');
  }
  onProgress(0);
  if (file.size <= maxBytes) {
    onProgress(100);
    return file;
  }

  const image = await decode(file);
  try {
    onProgress(20);
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const canvas = makeCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha channel; a transparent PNG would otherwise come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    onProgress(50);

    for (let i = 0; i < qualitySteps.length; i += 1) {
      const blob = await encode(canvas, qualitySteps[i]);
      onProgress(50 + Math.round(((i + 1) / qualitySteps.length) * 50));
      if (blob.size <= maxBytes) return blob;
    }
    throw new ImageCompressionError('too-large', 'This photo is too detailed to shrink below 1 MB. Try a closer crop.');
  } finally {
    image.close();
  }
}
