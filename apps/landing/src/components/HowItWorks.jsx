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

        <ol className="grid gap-6 md:grid-cols-3">
          {steps.map((s, index) => (
            <li
              key={s.n}
              className="relative rounded-2xl border border-slate-100 bg-white p-7 shadow-sm"
            >
              <div className="relative mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-primary font-bold text-white ring-4 ring-primary/15">
                <span aria-hidden="true" className="absolute -inset-1 rounded-full border border-primary/40 motion-safe:animate-pulse" />
                <span className="relative">{s.n}</span>
              </div>
              <h3 className="mb-2 text-lg font-bold text-dark">{s.title}</h3>
              <p className="mb-4 text-sm leading-relaxed text-slate-600">{s.desc}</p>
              <code className="inline-block rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-xs text-emerald-300">
                {s.command}
              </code>
              {index < steps.length - 1 && (
                <>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-6 left-1/2 z-10 h-6 w-px bg-primary/40 md:hidden"
                  >
                    <span className="absolute -bottom-px -left-[3px] h-1.5 w-1.5 rotate-45 border-b border-r border-primary/60" />
                  </span>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-6 top-12 z-10 hidden h-px w-6 bg-primary/40 md:block"
                  >
                    <span className="absolute -right-px -top-[3px] h-1.5 w-1.5 rotate-45 border-r border-t border-primary/60" />
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
