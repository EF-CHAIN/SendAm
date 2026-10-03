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
  return (
    <section id="how-it-works" className="bg-secondary/50 py-16 lg:py-24">
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
            className="pointer-events-none absolute left-[16.67%] right-[16.67%] top-12 hidden h-0.5 -translate-y-1/2 bg-gradient-to-r from-primary/60 via-primary/30 to-primary/60 md:block"
          />
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
              {/* Mobile: a short vertical connector in the gap to the next step. */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  data-testid="step-connector"
                  className="absolute left-[47px] top-full block h-6 w-0.5 bg-primary/40 md:hidden"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
