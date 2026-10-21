import { useEffect, useRef, useState } from 'react';

const steps = [
  {
    n: '1',
    title: 'Chat or speak',
    desc: 'Send a message or voice note for balance, payment, or receipt.',
    command: 'Send 25000 NGN to Ada',
  },
  {
    n: '2',
    title: 'Review the quote',
    desc: 'SendAm shows the live rate, fees, recipient, and confirmation flow before funds move.',
    command: 'Confirm with PIN',
  },
  {
    n: '3',
    title: 'Settle quietly',
    desc: 'The orchestrator settles the payment on Stellar while the user sees one clean receipt.',
    command: 'Receipt ready',
  },
];

export default function HowItWorks() {
  const sectionRef = useRef(null);
  const [scrollProgress, setScrollProgress] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      return 1;
    }
    return 0;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      return;
    }

    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (!sectionRef.current) {
            ticking = false;
            return;
          }
          const rect = sectionRef.current.getBoundingClientRect();
          const windowHeight = window.innerHeight || 800;
          const totalDistance = rect.height + windowHeight * 0.5;
          const currentDistance = windowHeight - rect.top;
          const rawProgress = currentDistance / totalDistance;
          const clamped = Math.max(0, Math.min(1, rawProgress));

          setScrollProgress(clamped);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  return (
    <section ref={sectionRef} id="how-it-works" className="bg-secondary/50 py-16 lg:py-24">
      <div className="container mx-auto px-4 sm:px-6">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-dark sm:text-4xl">
            How it works
          </h2>
          <p className="mt-4 text-slate-600">
            One WhatsApp experience, with routing, compliance, and settlement handled behind the scenes.
          </p>
        </div>

        <ol role="list" className="relative grid gap-6 md:grid-cols-3">
          {/* Desktop progress track: runs through the centre of the step badges. */}
          <li
            aria-hidden="true"
            data-testid="step-track"
            className="pointer-events-none absolute left-[16.67%] right-[16.67%] top-12 hidden h-1 -translate-y-1/2 overflow-hidden rounded-full bg-slate-200/80 md:block"
          >
            <svg
              className="h-full w-full"
              preserveAspectRatio="none"
              viewBox="0 0 100 4"
              fill="none"
            >
              <line
                x1="0"
                y1="2"
                x2="100"
                y2="2"
                stroke="currentColor"
                strokeWidth="4"
                strokeDasharray="4 2"
                className="text-primary/20"
              />
              <line
                x1="0"
                y1="2"
                x2="100"
                y2="2"
                stroke="url(#desktop-track-gradient)"
                strokeWidth="4"
                strokeDasharray="4 2"
                style={{
                  strokeDashoffset: `${(1 - scrollProgress) * 100}`,
                  transition: 'stroke-dashoffset 0.1s ease-out',
                }}
              />
              <defs>
                <linearGradient id="desktop-track-gradient" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#059669" />
                  <stop offset="0.5" stopColor="#10b981" />
                  <stop offset="1" stopColor="#34d399" />
                </linearGradient>
              </defs>
            </svg>
          </li>
          {steps.map((s, i) => (
            <li
              key={s.n}
              className="relative z-10 rounded-2xl border border-slate-100 bg-white p-7 shadow-sm"
            >
              <div className="relative mb-4 h-10 w-10">
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-primary/30 motion-safe:animate-ping motion-safe:[animation-duration:2.4s]"
                />
                <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary font-bold text-white ring-4 ring-primary/20">
                  <span className="sr-only">Step </span>
                  {s.n}
                </span>
              </div>
              <h3 className="mb-2 text-lg font-bold text-dark">{s.title}</h3>
              <p className="mb-4 text-sm leading-relaxed text-slate-600">{s.desc}</p>
              <code className="inline-block rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-xs text-emerald-300">
                {s.command}
              </code>
              {/* Mobile: an animated vertical dashed SVG connector in the gap to the next step. */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  data-testid="step-connector"
                  className="absolute left-[47px] top-full block h-6 w-1 -translate-x-1/2 overflow-hidden md:hidden"
                >
                  <svg
                    className="h-full w-full"
                    preserveAspectRatio="none"
                    viewBox="0 0 4 24"
                    fill="none"
                  >
                    <line
                      x1="2"
                      y1="0"
                      x2="2"
                      y2="24"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeDasharray="3 3"
                      className="text-primary/20"
                    />
                    <line
                      x1="2"
                      y1="0"
                      x2="2"
                      y2="24"
                      stroke="url(#mobile-connector-gradient)"
                      strokeWidth="2"
                      strokeDasharray="3 3"
                      style={{
                        strokeDashoffset: `${Math.max(0, (1 - (scrollProgress - i * 0.3) / 0.35) * 24)}`,
                        transition: 'stroke-dashoffset 0.1s ease-out',
                      }}
                    />
                    <defs>
                      <linearGradient id="mobile-connector-gradient" x1="0" y1="0" x2="0" y2="24" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#059669" />
                        <stop offset="1" stopColor="#34d399" />
                      </linearGradient>
                    </defs>
                  </svg>
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
