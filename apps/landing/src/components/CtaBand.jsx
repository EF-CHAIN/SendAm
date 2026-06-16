import { MessageCircle } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';

export default function CtaBand() {
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
          href={whatsappUrl('create wallet')}
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
