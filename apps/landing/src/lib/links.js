// Central place for outbound links so the WhatsApp number / admin URL are set
// once (via env) and reused across the nav, hero, and CTAs.

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || '';

const ADMIN_FALLBACK_URL = 'http://localhost:3001';

// An env var that is unset, empty, or only whitespace means "not configured"
// (plain `||` would let a whitespace-only value through as a broken href).
export const normalizeAdminUrl = (value) =>
  value && value.trim() ? value.trim() : ADMIN_FALLBACK_URL;

export const ADMIN_URL = normalizeAdminUrl(import.meta.env.VITE_ADMIN_URL);
export const GITHUB_URL = 'https://github.com/Gozirimdev/SendAm';
export const STELLAR_URL = 'https://stellar.org';

// Build a wa.me deep link that opens WhatsApp with a prefilled command.
// Without a configured number it falls back to wa.me/ (lets the user pick the
// chat) so the button is never broken in local/dev.
export const whatsappUrl = (message = 'create wallet') => {
  const base = WHATSAPP_NUMBER ? `https://wa.me/${WHATSAPP_NUMBER}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
};
