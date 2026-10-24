import { Component, Suspense, useEffect, useRef, useState } from 'react';

// Distance before the viewport at which a section starts loading, so the
// chunk is usually ready by the time the user scrolls to it.
const DEFAULT_ROOT_MARGIN = '300px 0px';

function shouldLoadImmediately(id) {
  if (typeof window === 'undefined') return true;
  // Without IntersectionObserver there is no cheap visibility signal; load now.
  if (typeof window.IntersectionObserver !== 'function') return true;
  // A deep link such as /#calculator must render its target straight away.
  return Boolean(id) && window.location.hash === `#${id}`;
}

function Placeholder({ id, minHeight, label }) {
  return (
    <section id={id} aria-busy="true" aria-label={label} style={{ minHeight }} data-testid="lazy-section-placeholder" />
  );
}

/**
 * Keeps a chunk failure (for example a deploy that removed the old chunk, or
 * going offline before the section loaded) inside the section instead of
 * replacing the whole page with the app-level error screen.
 */
class SectionErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { id, minHeight, label } = this.props;
    return (
      <section id={id} role="alert" style={{ minHeight }} className="container mx-auto px-4 py-16 text-center text-slate-600">
        <p>{label} could not be loaded.</p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Try again
        </button>
      </section>
    );
  }
}

/**
 * Renders `children` (typically a `React.lazy` component) only once the
 * section is near the viewport, so its code is fetched on demand. Until then
 * an empty placeholder with the same `id` and a reserved height keeps anchor
 * links working and avoids layout shift.
 */
export default function LazySection({ id, label, minHeight = 480, rootMargin = DEFAULT_ROOT_MARGIN, children }) {
  const [visible, setVisible] = useState(() => shouldLoadImmediately(id));
  const ref = useRef(null);

  useEffect(() => {
    if (visible) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  const placeholder = <Placeholder id={id} minHeight={minHeight} label={`Loading ${label}`} />;

  if (!visible) {
    return <div ref={ref}>{placeholder}</div>;
  }

  return (
    <SectionErrorBoundary id={id} minHeight={minHeight} label={label}>
      <Suspense fallback={placeholder}>{children}</Suspense>
    </SectionErrorBoundary>
  );
}
