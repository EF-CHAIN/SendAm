import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  cloneElement,
  isValidElement,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Calculates optimal tooltip position with auto-flip and boundary collision clamping.
 */
function computeFloatingPosition({
  triggerRect,
  tooltipRect,
  preferredPlacement = 'top',
  offset = 8,
  padding = 8,
}) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

  let placement = preferredPlacement;

  // Collision detection and automated flip along the primary axis
  if (preferredPlacement === 'top') {
    const spaceAbove = triggerRect.top;
    const spaceBelow = viewportHeight - triggerRect.bottom;
    const requiredSpace = tooltipRect.height + offset + padding;

    if (spaceAbove < requiredSpace && spaceBelow > spaceAbove) {
      placement = 'bottom';
    }
  } else if (preferredPlacement === 'bottom') {
    const spaceAbove = triggerRect.top;
    const spaceBelow = viewportHeight - triggerRect.bottom;
    const requiredSpace = tooltipRect.height + offset + padding;

    if (spaceBelow < requiredSpace && spaceAbove > spaceBelow) {
      placement = 'top';
    }
  } else if (preferredPlacement === 'left') {
    const spaceLeft = triggerRect.left;
    const spaceRight = viewportWidth - triggerRect.right;
    const requiredSpace = tooltipRect.width + offset + padding;

    if (spaceLeft < requiredSpace && spaceRight > spaceLeft) {
      placement = 'right';
    }
  } else if (preferredPlacement === 'right') {
    const spaceLeft = triggerRect.left;
    const spaceRight = viewportWidth - triggerRect.right;
    const requiredSpace = tooltipRect.width + offset + padding;

    if (spaceRight < requiredSpace && spaceLeft > spaceRight) {
      placement = 'left';
    }
  }

  let top = 0;
  let left = 0;

  // Compute primary and cross-axis coordinates based on final placement
  if (placement === 'top') {
    top = triggerRect.top - tooltipRect.height - offset;
    left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    // Cross-axis boundary clamping
    left = Math.max(padding, Math.min(left, viewportWidth - tooltipRect.width - padding));
  } else if (placement === 'bottom') {
    top = triggerRect.bottom + offset;
    left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    // Cross-axis boundary clamping
    left = Math.max(padding, Math.min(left, viewportWidth - tooltipRect.width - padding));
  } else if (placement === 'left') {
    left = triggerRect.left - tooltipRect.width - offset;
    top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
    // Cross-axis boundary clamping
    top = Math.max(padding, Math.min(top, viewportHeight - tooltipRect.height - padding));
  } else if (placement === 'right') {
    left = triggerRect.right + offset;
    top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
    // Cross-axis boundary clamping
    top = Math.max(padding, Math.min(top, viewportHeight - tooltipRect.height - padding));
  }

  return { top, left, placement };
}

/**
 * Tooltip — Shared tooltip component with automated flip and collision detection.
 *
 * Acceptance Criteria:
 * - Stays fully visible regardless of scroll position or screen edge proximity
 * - Automatically flips (top/bottom/left/right) when space is constrained
 * - Fully accessible via keyboard focus (focus/blur) and hover (mouseenter/mouseleave)
 * - Dismissible via Escape key
 */
export default function Tooltip({
  content,
  children,
  placement: preferredPlacement = 'top',
  offset = 8,
  padding = 8,
  delay = 100,
  disabled = false,
  className = '',
  id: customId,
}) {
  const reactId = useId();
  const tooltipId = customId || `tooltip-${reactId.replace(/:/g, '')}`;

  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, placement: preferredPlacement });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);
  const showTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    const computed = computeFloatingPosition({
      triggerRect,
      tooltipRect,
      preferredPlacement,
      offset,
      padding,
    });

    setCoords(computed);
  }, [preferredPlacement, offset, padding]);

  const showTooltip = useCallback(() => {
    if (disabled || !content) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);

    if (delay > 0) {
      showTimerRef.current = setTimeout(() => {
        setIsVisible(true);
      }, delay);
    } else {
      setIsVisible(true);
    }
  }, [disabled, content, delay]);

  const hideTooltip = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    setIsVisible(false);
  }, []);

  // Recalculate position whenever tooltip becomes visible or viewport changes
  useEffect(() => {
    if (!isVisible) return;

    // Initial position calculation
    updatePosition();

    // Recompute on window scroll or resize
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isVisible, updatePosition]);

  // Handle Escape key to dismiss tooltip
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        hideTooltip();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVisible, hideTooltip]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (!isValidElement(children)) {
    return children;
  }

  const triggerProps = {
    ref: (node) => {
      triggerRef.current = node;
      const { ref: childRef } = children;
      if (typeof childRef === 'function') {
        childRef(node);
      } else if (childRef && typeof childRef === 'object') {
        childRef.current = node;
      }
    },
    'aria-describedby': isVisible && !disabled && content ? tooltipId : undefined,
    onMouseEnter: (e) => {
      showTooltip();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e) => {
      hideTooltip();
      children.props.onMouseLeave?.(e);
    },
    onFocus: (e) => {
      showTooltip();
      children.props.onFocus?.(e);
    },
    onBlur: (e) => {
      hideTooltip();
      children.props.onBlur?.(e);
    },
  };

  const clonedTrigger = cloneElement(children, triggerProps);

  const tooltipElement =
    isVisible && !disabled && content && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            data-placement={coords.placement}
            style={{
              position: 'fixed',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              pointerEvents: 'none',
              zIndex: 9999,
            }}
            className={`rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-md dark:bg-gray-100 dark:text-gray-900 animate-in fade-in zoom-in-95 duration-150 ${className}`}
          >
            {content}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      {clonedTrigger}
      {tooltipElement}
    </>
  );
}
