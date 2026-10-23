import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

/**
 * Trend style matrix ensuring WCAG 2.2 AAA color contrast compliance (>= 7:1)
 * across both light and dark themes. Redundant cues (color, icon, screen-reader text)
 * satisfy WCAG 1.4.1 (Use of Color).
 */
const TREND_STYLES = {
  positive: {
    container: 'bg-green-100 dark:bg-green-950/60 text-green-900 dark:text-green-300',
    Icon: TrendingUp,
    defaultPrefix: 'Increased by ',
  },
  negative: {
    container: 'bg-red-100 dark:bg-red-950/60 text-red-900 dark:text-red-300',
    Icon: TrendingDown,
    defaultPrefix: 'Decreased by ',
  },
  neutral: {
    container: 'bg-gray-100 dark:bg-slate-800 text-gray-800 dark:text-gray-200',
    Icon: Minus,
    defaultPrefix: 'Unchanged at ',
  },
};

/**
 * Normalizes trend inputs (structured object or raw number/string) into a predictable shape.
 *
 * @param {object|number|string|null|undefined} trend
 * @returns {{ direction: 'positive'|'negative'|'neutral', formattedValue: string, period?: string } | null}
 */
function parseTrend(trend) {
  if (trend === null || trend === undefined) return null;

  let rawValue;
  let isPositive;
  let period;

  if (typeof trend === 'object') {
    rawValue = trend.value;
    isPositive = trend.isPositive;
    period = trend.period;
  } else {
    rawValue = trend;
  }

  if (rawValue === null || rawValue === undefined || rawValue === '') return null;

  const numericValue = typeof rawValue === 'number'
    ? rawValue
    : parseFloat(String(rawValue).replace(/[^0-9.-]/g, ''));
  const isNumeric = Number.isFinite(numericValue);

  // Direction resolution: explicit isPositive flag takes precedence over sign inference
  let direction = 'neutral';
  if (typeof isPositive === 'boolean') {
    direction = isPositive ? 'positive' : 'negative';
  } else if (isNumeric) {
    if (numericValue > 0) direction = 'positive';
    else if (numericValue < 0) direction = 'negative';
    else direction = 'neutral';
  }

  // Percentage formatting
  let formattedValue;
  if (typeof rawValue === 'string' && rawValue.trim().endsWith('%')) {
    formattedValue = rawValue.trim().replace(/^[+-]/, '');
  } else if (isNumeric) {
    const absVal = Math.abs(numericValue);
    formattedValue = Number.isInteger(absVal) ? `${absVal}%` : `${absVal.toFixed(1)}%`;
  } else {
    formattedValue = String(rawValue);
  }

  return {
    direction,
    formattedValue,
    period,
  };
}

export default function StatCard({
  title,
  value,
  icon: Icon,
  colorClass = 'text-primary',
  trend = null,
}) {
  const trendInfo = parseTrend(trend);
  const trendStyle = trendInfo ? TREND_STYLES[trendInfo.direction] : null;
  const TrendIcon = trendStyle ? trendStyle.Icon : null;
  const ariaLabel = trendInfo
    ? `${trendStyle.defaultPrefix}${trendInfo.formattedValue}${trendInfo.period ? ` ${trendInfo.period}` : ''}`
    : undefined;

  return (
    <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 dark:border-slate-800 flex items-center gap-4 hover:shadow-md transition-shadow min-w-0">
      <div className={`p-3 sm:p-4 rounded-full bg-opacity-10 dark:bg-opacity-20 ${colorClass.replace('text-', 'bg-')} ${colorClass} shrink-0`}>
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">{title}</p>
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-2xl font-bold text-dark dark:text-white break-words">{value}</p>
          {trendInfo && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full ${trendStyle.container}`}
              aria-label={ariaLabel}
              data-testid="trend-badge"
              data-direction={trendInfo.direction}
            >
              <TrendIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" data-testid="trend-icon" />
              <span>{trendInfo.formattedValue}</span>
            </span>
          )}
        </div>
        {trendInfo?.period && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{trendInfo.period}</p>
        )}
      </div>
    </div>
  );
}

