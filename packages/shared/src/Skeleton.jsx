import React from 'react';

const SHIMMER_STYLE_ID = 'sendam-skeleton-shimmer-styles';

/**
 * Injects keyframe styles once into document head for the shimmer animation.
 */
function ensureShimmerStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SHIMMER_STYLE_ID)) return;

  const styleEl = document.createElement('style');
  styleEl.id = SHIMMER_STYLE_ID;
  styleEl.textContent = `
    @keyframes sendam-skeleton-shimmer {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(100%);
      }
    }
  `;
  document.head.appendChild(styleEl);
}

const VARIANT_STYLES = {
  text: 'rounded h-4 w-full my-1',
  circular: 'rounded-full w-10 h-10 shrink-0',
  rectangular: 'rounded-md w-full h-24',
};

/**
 * Skeleton — Shared skeleton placeholder component with configurable shimmer.
 *
 * Acceptance Criteria:
 * - Supports text, circular, and rectangular variants
 * - Configurable shimmer effect, pulse, or none
 * - Replaces custom loading placeholders across landing and admin
 * - Fully accessible with role="status", aria-busy="true"
 */
export default function Skeleton({
  variant = 'rectangular',
  animation = 'shimmer',
  width,
  height,
  count = 1,
  className = '',
  'aria-label': ariaLabel = 'Loading…',
  ...rest
}) {
  React.useEffect(() => {
    if (animation === 'shimmer') {
      ensureShimmerStyles();
    }
  }, [animation]);

  const baseVariantClass = VARIANT_STYLES[variant] || VARIANT_STYLES.rectangular;

  const inlineStyles = {};
  if (width !== undefined) {
    inlineStyles.width = typeof width === 'number' ? `${width}px` : width;
  }
  if (height !== undefined) {
    inlineStyles.height = typeof height === 'number' ? `${height}px` : height;
  }
  // For circular variant with only width or only height specified, keep 1:1 aspect
  if (variant === 'circular') {
    if (width !== undefined && height === undefined) {
      inlineStyles.height = inlineStyles.width;
    } else if (height !== undefined && width === undefined) {
      inlineStyles.width = inlineStyles.height;
    }
  }

  const isShimmer = animation === 'shimmer';
  const isPulse = animation === 'pulse';

  const animationClass = isPulse
    ? 'animate-pulse'
    : isShimmer
    ? 'relative overflow-hidden'
    : '';

  const renderSingleSkeleton = (key) => (
    <span
      key={key}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      data-variant={variant}
      data-animation={animation || 'none'}
      style={inlineStyles}
      className={`inline-block bg-gray-200 dark:bg-slate-700 select-none ${baseVariantClass} ${animationClass} ${className}`}
      {...rest}
    >
      {isShimmer && (
        <span
          aria-hidden="true"
          className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/50 dark:via-white/10 to-transparent pointer-events-none"
          style={{
            animation: 'sendam-skeleton-shimmer 1.5s infinite linear',
          }}
        />
      )}
    </span>
  );

  if (count > 1) {
    return (
      <div
        role="group"
        aria-busy="true"
        aria-label={ariaLabel}
        className="flex flex-col gap-2 w-full"
      >
        {Array.from({ length: count }, (_, i) => renderSingleSkeleton(i))}
      </div>
    );
  }

  return renderSingleSkeleton(0);
}
