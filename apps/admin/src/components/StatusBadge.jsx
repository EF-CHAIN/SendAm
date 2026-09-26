// Status is never conveyed by hue alone (WCAG 1.4.1 Use of Colour). Each state
// carries three redundant cues: the status word itself, a distinct glyph, and
// the badge colour. The glyph is aria-hidden so screen readers announce the
// word alone ("pending") rather than "horizontal ellipsis, pending".
//
// Every colour pair below is verified at >= 7:1 against its own background —
// the WCAG 2.2 AAA enhanced-contrast threshold (1.4.6) — by
// apps/admin/src/test/a11y-audit.test.jsx. The 100-weight Tailwind backgrounds
// are kept light so the darker 900/800 foregrounds clear that bar; the earlier
// 700-weight text topped out at 4.6-5.3:1, which is AA at best.
const STATUS_STYLES = {
  success: { container: 'bg-green-100 text-green-900', glyph: '\u2713' },
  pending: { container: 'bg-yellow-100 text-yellow-900', glyph: '\u2026' },
  failed: { container: 'bg-red-100 text-red-900', glyph: '\u2715' },
};

const UNKNOWN_STYLE = { container: 'bg-gray-100 text-gray-800', glyph: '\u2013' };

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status?.toLowerCase()] || UNKNOWN_STYLE;

  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full ${style.container}`}>
      <span aria-hidden="true">{style.glyph}</span>
      <span className="capitalize">{status || 'Unknown'}</span>
    </span>
  );
}
