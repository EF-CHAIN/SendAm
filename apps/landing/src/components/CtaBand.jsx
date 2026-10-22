import { MessageCircle } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';
import { CORRIDORS } from '@/lib/corridors.js';

function getCorridorGreeting(corridor) {
  if (!corridor) return 'create wallet';

  if (typeof corridor === 'string') {
    const trimmed = corridor.trim();
    if (!trimmed) return 'create wallet';

    const match = CORRIDORS.find(
      (c) =>
        c.id.toLowerCase() === trimmed.toLowerCase() ||
        c.to.country.toLowerCase() === trimmed.toLowerCase() ||
        c.to.name.toLowerCase().includes(trimmed.toLowerCase()) ||
        c.to.id.toLowerCase() === trimmed.toLowerCase()
    );
    const destination = match ? match.to.country : trimmed;
    return `Hello SendAm, I want to send money to ${destination}`;
  }

  const destination =
    corridor.to?.country || corridor.country || corridor.destination || corridor.name;
  if (destination) {
    return `Hello SendAm, I want to send money to ${destination}`;
  }

  return 'create wallet';
}

export default function CtaBand({ corridor }) {
  const greeting = getCorridorGreeting(corridor);

  return (
    <section className="container mx-auto px-4 pb-16 sm:px-6 lg:pb-24">
      <div className="relative overflow-hidden rounded-3xl bg-dark px-6 py-14 text-center sm:px-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl"
        />
        <h2 className="relative text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Try your first transfer in 60 seconds
        </h2>
        <p className="relative mx-auto mt-4 max-w-xl text-slate-300">
          It's free on testnet. Send one message and watch a Stellar payment
          settle in seconds.
        </p>
        <a
          href={whatsappUrl(greeting)}
          target="_blank"
          rel="noopener noreferrer"
          className="relative mt-8 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-8 py-4 font-semibold text-white shadow-lg shadow-primary/30 transition-all hover:-translate-y-0.5 hover:bg-whatsapp focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <MessageCircle size={20} aria-hidden="true" />
          Start on WhatsApp
        </a>
      </div>
    </section>
  );
}
