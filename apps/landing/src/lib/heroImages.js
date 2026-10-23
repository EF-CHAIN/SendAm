// Hero graphics. The variants live in public/img and are generated from
// public/whatsapp-bg.png (see apps/landing/README.md, "Image pipeline").
//
// The wallpaper is shown with object-fit: cover inside a phone frame that is
// 600 CSS px tall, so the browser needs a ~600px-wide source at 1x, 1200px at
// 2x and 1800px at 3x.
export const HERO_WALLPAPER = {
  basePath: '/img/hero-wallpaper',
  widths: [600, 1200, 1800],
  formats: ['avif', 'webp'],
  sizes: '600px',
  fallbackSrc: '/whatsapp-bg.png',
  width: 600,
  height: 600,
};
