import { CheckCircle2, Clock, XCircle, HelpCircle } from 'lucide-react';

// Status is never conveyed by hue alone (WCAG 1.4.1 Use of Colour). Each state
// carries three redundant cues: the status word itself, a distinct glyph/icon, and
// the badge colour. The icon is aria-hidden so screen readers announce the
// word alone ("pending") rather than reading icon descriptions.
//
// Every colour pair below is verified at >= 7:1 against its own background —
// the WCAG 2.2 AAA enhanced-contrast threshold (1.4.6) — by
// apps/admin/src/test/a11y-audit.test.jsx. The 100-weight Tailwind backgrounds
// are kept light so the darker 900/800 foregrounds clear that bar; the earlier
// 700-weight text topped out at 4.6-5.3:1, which is AA at best.
const STATUS_STYLES = {
  success: {
    container: 'bg-green-100 dark:bg-green-950/50 text-green-900 dark:text-green-300',
    Icon: CheckCircle2,
    glyph: '\u2713',
  },
  pending: {
    container: 'bg-yellow-100 dark:bg-yellow-950/50 text-yellow-900 dark:text-yellow-300',
    Icon: Clock,
    glyph: '\u2026',
  },
  failed: {
    container: 'bg-red-100 dark:bg-red-950/50 text-red-900 dark:text-red-300',
    Icon: XCircle,
    glyph: '\u2715',
  },
};

const UNKNOWN_STYLE = {
  container: 'bg-gray-100 dark:bg-slate-800 text-gray-800 dark:text-gray-200',
  Icon: HelpCircle,
  glyph: '\u2013',
};

export default function StatusBadge({ status }) {
  const key = typeof status === 'string' && status ? status.toLowerCase() : undefined;
  const style = STATUS_STYLES[key] || UNKNOWN_STYLE;
  const Icon = style.Icon;

  return (
    <span
      aria-label={key || 'unknown'}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full capitalize ${style.container}`}
      data-status={key ?? 'unknown'}
    >
      <Icon size={12} aria-hidden="true" data-testid="status-icon" data-glyph={style.glyph} />
      {status || 'Unknown'}
    </span>
  );
}
