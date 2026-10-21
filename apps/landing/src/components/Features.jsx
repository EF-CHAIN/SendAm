import { useState, useRef } from 'react';
import { Wallet, Mic, ArrowLeftRight, Network } from 'lucide-react';

const features = [
  {
    title: 'Phone number wallet',
    desc: 'Every WhatsApp number maps to a managed wallet, with no seed phrase or browser extension.',
    icon: Wallet,
  },
  {
    title: 'Voice-to-cash',
    desc: 'Send a voice note, confirm with PIN, and SendAm turns the intent into a payment.',
    icon: Mic,
  },
  {
    title: 'Cross-border transfers',
    desc: 'Payments can move through corridor rails when a route needs international settlement.',
    icon: ArrowLeftRight,
  },
  {
    title: 'Multi-chain infrastructure',
    desc: 'Payments settle on Stellar — a network built for fast, low-cost cross-border money movement.',
    icon: Network,
  },
];

export function FeatureCard({ feature }) {
  const Icon = feature.icon;
  const cardRef = useRef(null);
  const [transform, setTransform] = useState('');
  const [glow, setGlow] = useState({ opacity: 0, x: 0, y: 0 });

  const handleMouseMove = (e) => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const isTouch =
        window.matchMedia('(hover: none)').matches ||
        window.matchMedia('(pointer: coarse)').matches;
      const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (isTouch || isReduced) {
        return;
      }
    }

    const card = cardRef.current;
    if (!card) return;

    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotateX = -((y - centerY) / (centerY || 1)) * 6;
    const rotateY = ((x - centerX) / (centerX || 1)) * 6;

    setTransform(`perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateZ(0)`);
    setGlow({ opacity: 1, x: Math.round(x), y: Math.round(y) });
  };

  const handleMouseLeave = () => {
    setTransform('');
    setGlow((prev) => ({ ...prev, opacity: 0 }));
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform: transform || undefined,
        transformStyle: 'preserve-3d',
      }}
      className="group relative overflow-hidden rounded-2xl border border-slate-100 bg-white p-6 shadow-sm transition duration-300 ease-out hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:p-7"
    >
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-secondary text-primary transition duration-300 ease-out group-hover:scale-110 group-hover:-rotate-6 group-hover:bg-primary group-hover:text-white motion-reduce:transition-none motion-reduce:group-hover:scale-100 motion-reduce:group-hover:rotate-0">
        <Icon size={26} aria-hidden="true" />
      </div>
      <h3 className="mb-2 text-lg font-bold text-dark">{feature.title}</h3>
      <p className="text-sm leading-relaxed text-slate-600">{feature.desc}</p>

      {/* Specular highlight overlay following cursor */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-300 motion-reduce:hidden"
        style={{
          opacity: glow.opacity,
          background: `radial-gradient(circle 220px at ${glow.x}px ${glow.y}px, rgba(16, 185, 129, 0.14), rgba(255, 255, 255, 0.35) 25%, transparent 75%)`,
        }}
        aria-hidden="true"
        data-testid="specular-highlight"
      />
    </div>
  );
}

export default function Features() {
  return (
    <section id="features" className="container mx-auto px-4 py-16 sm:px-6 lg:py-24">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-dark sm:text-4xl">
          Payments that feel like chat
        </h2>
        <p className="mt-4 text-slate-600">
          SendAm hides the payment rails and gives users familiar WhatsApp flows.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <FeatureCard key={f.title} feature={f} />
        ))}
      </div>
    </section>
  );
}
