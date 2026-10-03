import { useState, useId } from 'react';
import { ArrowRight, CheckCircle2, TrendingDown, RefreshCw, Zap } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';
import {
  EXCHANGE_RATES,
  SOURCE_CURRENCIES,
  TARGET_CURRENCIES,
  PRESET_AMOUNTS,
} from '@/lib/currencyConstants.js';

export default function CurrencyCalculator() {
  const [amount, setAmount] = useState('100');
  const [sourceCurrency, setSourceCurrency] = useState('USD');
  const [targetCurrency, setTargetCurrency] = useState('NGN');

  const inputId = useId();
  const sourceSelectId = useId();
  const targetSelectId = useId();

  const parsedAmount = Math.max(0, parseFloat(amount) || 0);

  // SendAm fee is flat 1%
  const sendAmFeePercent = 1;
  const sendAmFee = parsedAmount * 0.01;
  const netSendAmount = Math.max(0, parsedAmount - sendAmFee);

  // Traditional bank wire / money transfer fees typically range from 6% to 8%
  const traditionalFeePercent = 7;
  const traditionalFee = parsedAmount * 0.07;

  // Rate lookup
  const currentRate = EXCHANGE_RATES[sourceCurrency]?.[targetCurrency] || 1;
  const receivedAmount = netSendAmount * currentRate;

  // Estimated savings
  const estimatedSavings = Math.max(0, traditionalFee - sendAmFee);
  const estimatedSavingsInTarget = estimatedSavings * currentRate;

  const currentSource = SOURCE_CURRENCIES.find((c) => c.code === sourceCurrency) || SOURCE_CURRENCIES[0];
  const currentTarget = TARGET_CURRENCIES.find((c) => c.code === targetCurrency) || TARGET_CURRENCIES[0];

  const handleAmountChange = (e) => {
    const val = e.target.value;
    if (val === '' || /^\d*\.?\d{0,2}$/.test(val)) {
      setAmount(val);
    }
  };

  const handleCorridorSwitch = (src, tgt) => {
    setSourceCurrency(src);
    setTargetCurrency(tgt);
  };

  return (
    <section id="calculator" className="container mx-auto px-4 py-16 sm:px-6 lg:py-24">
      <div className="mx-auto max-w-3xl text-center mb-12">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-secondary text-primary text-xs font-semibold uppercase tracking-wider mb-4">
          <Zap size={14} aria-hidden="true" />
          Transparent Pricing
        </div>
        <h2 className="text-3xl font-extrabold tracking-tight text-dark sm:text-4xl">
          See how much your recipient gets
        </h2>
        <p className="mt-4 text-base text-slate-600 sm:text-lg">
          No hidden bank spreads or surprise wire charges. Pay a flat 1% SendAm fee and settle in seconds on Stellar.
        </p>
      </div>

      {/* Corridor Quick Tabs */}
      <div className="mx-auto max-w-3xl mb-6 flex flex-wrap justify-center gap-2">
        {TARGET_CURRENCIES.map((tgt) => {
          const isActive = targetCurrency === tgt.code;
          return (
            <button
              key={tgt.code}
              type="button"
              onClick={() => handleCorridorSwitch(sourceCurrency, tgt.code)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-primary text-white shadow-md shadow-primary/20'
                  : 'bg-white border border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span>{tgt.flag}</span>
              <span>Send to {tgt.country} ({tgt.code})</span>
            </button>
          );
        })}
      </div>

      {/* Main Card */}
      <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8 md:p-10">
        <div className="grid gap-6 md:grid-cols-2 md:gap-8 items-center">
          {/* Source Input Column */}
          <div className="space-y-4">
            <div>
              <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                You Send
              </label>
              <div className="relative flex rounded-2xl border-2 border-slate-200 bg-white p-2 transition-within focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={handleAmountChange}
                  placeholder="0.00"
                  aria-label={`Send amount in ${sourceCurrency}`}
                  className="w-full bg-transparent px-3 py-2 text-2xl font-bold text-dark outline-none sm:text-3xl"
                />
                <div className="flex items-center gap-1 border-l border-slate-200 pl-3 pr-2">
                  <label htmlFor={sourceSelectId} className="sr-only">Source Currency</label>
                  <select
                    id={sourceSelectId}
                    value={sourceCurrency}
                    onChange={(e) => setSourceCurrency(e.target.value)}
                    className="bg-transparent text-sm font-semibold text-dark outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-primary rounded"
                  >
                    {SOURCE_CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Presets */}
            <div>
              <span className="block text-xs text-slate-400 mb-2">Quick amounts:</span>
              <div className="flex gap-2">
                {PRESET_AMOUNTS.map((preset) => {
                  const isSelected = parsedAmount === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAmount(String(preset))}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition ${
                        isSelected
                          ? 'border-primary bg-secondary text-primary'
                          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {currentSource.symbol}{preset}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Exchange rate display */}
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 bg-slate-50 rounded-xl p-3 border border-slate-100">
              <RefreshCw size={14} className="text-primary shrink-0" aria-hidden="true" />
              <span>
                1 {sourceCurrency} = {currentRate.toLocaleString()} {targetCurrency}
              </span>
            </div>
          </div>

          {/* Target Column */}
          <div className="space-y-4">
            <div>
              <label htmlFor={targetSelectId} className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                Recipient Gets (Est.)
              </label>
              <div className="relative flex rounded-2xl border-2 border-emerald-100 bg-emerald-50/50 p-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
                <div className="w-full px-3 py-2 text-2xl font-extrabold text-emerald-800 sm:text-3xl truncate">
                  {currentTarget.symbol} {receivedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="flex items-center gap-1 border-l border-emerald-200 pl-3 pr-2">
                  <select
                    id={targetSelectId}
                    value={targetCurrency}
                    onChange={(e) => setTargetCurrency(e.target.value)}
                    className="bg-transparent text-sm font-semibold text-emerald-900 outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                  >
                    {TARGET_CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Breakdown summary */}
            <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3.5 space-y-2 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>SendAm Fee ({sendAmFeePercent}%)</span>
                <span className="font-semibold text-slate-800">{currentSource.symbol}{sendAmFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Traditional Wire (~{traditionalFeePercent}%)</span>
                <span className="line-through text-slate-400">{currentSource.symbol}{traditionalFee.toFixed(2)}</span>
              </div>
              <div className="pt-2 border-t border-slate-200 flex justify-between items-center text-emerald-700 font-semibold">
                <span className="flex items-center gap-1">
                  <TrendingDown size={14} aria-hidden="true" />
                  Estimated Savings
                </span>
                <span className="text-sm">
                  {currentSource.symbol}{estimatedSavings.toFixed(2)} ({currentTarget.symbol}{Math.round(estimatedSavingsInTarget).toLocaleString()})
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Feature Highlights Footer inside card */}
        <div className="mt-8 pt-6 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4">
          <ul className="flex flex-wrap gap-4 text-xs text-slate-500">
            <li className="flex items-center gap-1.5">
              <CheckCircle2 size={15} className="text-primary" aria-hidden="true" />
              Direct to recipient phone
            </li>
            <li className="flex items-center gap-1.5">
              <CheckCircle2 size={15} className="text-primary" aria-hidden="true" />
              Instant settlement
            </li>
          </ul>

          <a
            href={whatsappUrl(`send ${amount} ${sourceCurrency} to ${targetCurrency}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white shadow-md shadow-primary/20 transition-all hover:bg-whatsapp"
          >
            Send with WhatsApp
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}
