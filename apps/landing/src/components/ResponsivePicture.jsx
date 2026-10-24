// Renders a <picture> with AVIF and WebP sources plus a plain fallback <img>.
// Variants follow the naming convention `<basePath>-<width>.<format>` and are
// described to the browser with width descriptors, so it can pick the 1x, 2x or
// 3x file for the device pixel ratio.

import { buildSrcSet } from '@/lib/srcset.js';

const MIME_TYPES = {
  avif: 'image/avif',
  webp: 'image/webp',
};

export default function ResponsivePicture({
  basePath,
  widths,
  formats = ['avif', 'webp'],
  fallbackSrc,
  sizes,
  alt = '',
  width,
  height,
  priority = false,
  className = '',
}) {
  const sources = formats
    .filter((format) => MIME_TYPES[format])
    .map((format) => ({ format, srcSet: buildSrcSet(basePath, widths, format) }))
    .filter((source) => source.srcSet);

  return (
    <picture>
      {sources.map(({ format, srcSet }) => (
        <source key={format} type={MIME_TYPES[format]} srcSet={srcSet} sizes={sizes} />
      ))}
      <img
        src={fallbackSrc}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding={priority ? 'sync' : 'async'}
        className={className}
      />
    </picture>
  );
}
