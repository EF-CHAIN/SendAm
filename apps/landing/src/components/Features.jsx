import { Wallet, Mic, ShieldCheck, MapPin, ArrowLeftRight, Network } from 'lucide-react';

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
    title: 'Protected escrow',
    desc: 'Lock funds, release on approval, refund after timeout, or escalate to an arbiter.',
    icon: ShieldCheck,
  },
  {
    title: 'Nearby cash-out',
    desc: 'Find verified agents for local cash-out while the backend handles ramp settlement.',
    icon: MapPin,
  },
  {
    title: 'Cross-border transfers',
    desc: 'Payments can move through corridor rails when a route needs international settlement.',
    icon: ArrowLeftRight,
  },
  {
    title: 'Multi-chain infrastructure',
    desc: 'Lisk is the primary settlement layer, with Stellar reserved for cross-border corridors.',
    icon: Network,
  },
];

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

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm transition-shadow hover:shadow-md sm:p-7"
            >
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-secondary text-primary">
                <Icon size={26} aria-hidden="true" />
              </div>
              <h3 className="mb-2 text-lg font-bold text-dark">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-600">{f.desc}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
