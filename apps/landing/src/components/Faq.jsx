import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const faqs = [
  {
    q: 'Do users need to understand crypto?',
    a: 'No. Users interact through WhatsApp, phone numbers, contacts, receipts, PINs, and flows. The blockchain rail is selected by SendAm in the background.',
  },
  {
    q: 'Which blockchain does SendAm use?',
    a: 'Lisk is the primary settlement layer. Stellar is used only for cross-border corridors where it is the better payment rail.',
  },
  {
    q: 'How are wallets managed?',
    a: 'Every phone number maps to a managed wallet through a Wallet-as-a-Service provider such as Thirdweb Engine. The app talks only to SendAm wallet services.',
  },
  {
    q: 'Is this production-ready today?',
    a: 'The architecture is being upgraded for production, including KYC, PIN verification, queues, audit logs, and provider integrations. Live money movement should wait for credentials, contracts, compliance review, and monitoring.',
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-4 py-5 text-left text-base font-semibold text-dark transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {q}
          <ChevronDown
            size={20}
            aria-hidden="true"
            className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h3>
      {open && (
        <p className="pb-5 text-sm leading-relaxed text-slate-600">{a}</p>
      )}
    </div>
  );
}

export default function Faq() {
  return (
    <section id="faq" className="container mx-auto px-4 py-16 sm:px-6 lg:py-24">
      <div className="mx-auto max-w-3xl">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-dark sm:text-4xl">
            Frequently asked questions
          </h2>
        </div>
        <div>
          {faqs.map((f) => (
            <FaqItem key={f.q} {...f} />
          ))}
        </div>
      </div>
    </section>
  );
}
