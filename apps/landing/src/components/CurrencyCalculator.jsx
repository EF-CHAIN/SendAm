import { memo, useDeferredValue, useId, useMemo, useState, useTransition } from 'react';
import { ArrowRight, CheckCircle2, TrendingDown, RefreshCw, Zap } from 'lucide-react';
import { useState, useId } from 'react';
import { ArrowRight, ArrowLeftRight, CheckCircle2, ChevronDown, TrendingDown, RefreshCw, Zap } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';
import {
  SOURCE_CURRENCIES,
  TARGET_CURRENCIES,
  PRESET_AMOUNTS,
  getExchangeRate,
} from '@/lib/currencyConstants.js';
import {
  computeQuote,
  parseAmount,
  SENDAM_FEE_PERCENT,
  TRADITIONAL_FEE_PERCENT,
} from '@/lib/quote.js';

// The output panels below are memoised on the (deferred) quote, so a keystroke
// only re-renders the cheap input column immediately. The fee maths and the
// locale formatting run in a lower-priority render that React can interrupt
// when the next keystroke arrives.
const RecipientAmount = memo(function RecipientAmount({ quote, target }) {
  return (
    <div className="w-full px-3 py-2 text-2xl font-extrabold text-emerald-800 sm:text-3xl truncate">
      {target.symbol} {quote.receivedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </div>
  );
});

const RateLine = memo(function RateLine({ rate, source, target }) {
  return (
    <span>
      1 {source} = {rate.toLocaleString()} {target}
    </span>
  );
});

const FeeBreakdown = memo(function FeeBreakdown({ quote, source, target }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3.5 space-y-2 text-xs">
      <div className="flex justify-between text-slate-600">
        <span>SendAm Fee ({SENDAM_FEE_PERCENT}%)</span>
        <span className="font-semibold text-slate-800">{source.symbol}{quote.sendAmFee.toFixed(2)}</span>
      </div>
      <div className="flex justify-between text-slate-600">
        <span>Traditional Wire (~{TRADITIONAL_FEE_PERCENT}%)</span>
        <span className="line-through text-slate-400">{source.symbol}{quote.traditionalFee.toFixed(2)}</span>
      </div>
      <div className="pt-2 border-t border-slate-200 flex justify-between items-center text-emerald-700 font-semibold">
        <span className="flex items-center gap-1">
          <TrendingDown size={14} aria-hidden="true" />
          Estimated Savings
        </span>
        <span className="text-sm">
          {source.symbol}{quote.estimatedSavings.toFixed(2)} ({target.symbol}{Math.round(quote.estimatedSavingsInTarget).toLocaleString()})
        </span>
      </div>
    </div>
  );
});
  calculateQuote,
  sendCommand,
  SENDAM_FEE_PERCENT,
  TRADITIONAL_FEE_PERCENT,
} from '@/lib/calculator.js';

// Every currency the calculator can display, so a swapped corridor can resolve
// its flags and symbols even when a code leaves its original list.
const ALL_CURRENCIES = [...SOURCE_CURRENCIES, ...TARGET_CURRENCIES];

const currencyFor = (code) => ALL_CURRENCIES.find((c) => c.code === code) || null;

export default function CurrencyCalculator() {
  const [amount, setAmount] = useState('100');
  const [sourceCurrency, setSourceCurrency] = useState('USD');
  const [targetCurrency, setTargetCurrency] = useState('NGN');
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [spinDegrees, setSpinDegrees] = useState(0);

  const inputId = useId();
  const sourceSelectId = useId();
  const targetSelectId = useId();
  const breakdownId = useId();

  // Typing stays urgent; everything derived from the amount follows a
  // deferred copy so slider/typing input is never blocked by the quote render.
  const [isTransitionPending, startTransition] = useTransition();
  const deferredAmount = useDeferredValue(amount);
  const deferredSource = useDeferredValue(sourceCurrency);
  const deferredTarget = useDeferredValue(targetCurrency);

  const quote = useMemo(
    () => computeQuote(deferredAmount, deferredSource, deferredTarget),
    [deferredAmount, deferredSource, deferredTarget],
  );
  const isStale =
    isTransitionPending ||
    deferredAmount !== amount ||
    deferredSource !== sourceCurrency ||
    deferredTarget !== targetCurrency;
  const quote = calculateQuote({ amount, source: sourceCurrency, target: targetCurrency });
  const parsedAmount = quote.amount;
  const sendAmFeePercent = SENDAM_FEE_PERCENT;
  const sendAmFee = quote.fee;
  const traditionalFeePercent = TRADITIONAL_FEE_PERCENT;
  const traditionalFee = quote.traditionalFee;
  const currentRate = quote.rate;
  const receivedAmount = quote.received;
  const estimatedSavings = quote.savings;
  const estimatedSavingsInTarget = quote.savingsInTarget;
  const formatMoney = (value) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parsedAmount = Math.max(0, parseFloat(amount) || 0);

  // SendAm fee is flat 1%
  const sendAmFeePercent = 1;
  const sendAmFee = parsedAmount * 0.01;
  const netSendAmount = Math.max(0, parsedAmount - sendAmFee);

  // Traditional bank wire / money transfer fees typically range from 6% to 8%
  const traditionalFeePercent = 7;
  const traditionalFee = parsedAmount * 0.07;

  // Rate lookup, with the reverse direction derived for swapped corridors
  const currentRate = getExchangeRate(sourceCurrency, targetCurrency);
  const receivedAmount = netSendAmount * currentRate;

  // Cheap, urgent values: preset highlight only needs the live amount.
  const parsedAmount = parseAmount(amount);

  const currentSource = SOURCE_CURRENCIES.find((c) => c.code === deferredSource) || SOURCE_CURRENCIES[0];
  const currentTarget = TARGET_CURRENCIES.find((c) => c.code === deferredTarget) || TARGET_CURRENCIES[0];
  // Preset buttons follow the live source currency so symbols never lag the select.
  const liveSource = SOURCE_CURRENCIES.find((c) => c.code === sourceCurrency) || SOURCE_CURRENCIES[0];
  const currentSource = currencyFor(sourceCurrency) || SOURCE_CURRENCIES[0];
  const currentTarget = currencyFor(targetCurrency) || TARGET_CURRENCIES[0];

  // Keep a swapped-in code selectable even when it left its original list.
  const sourceOptions = SOURCE_CURRENCIES.some((c) => c.code === sourceCurrency)
    ? SOURCE_CURRENCIES
    : [...SOURCE_CURRENCIES, currentSource];
  const targetOptions = TARGET_CURRENCIES.some((c) => c.code === targetCurrency)
    ? TARGET_CURRENCIES
    : [...TARGET_CURRENCIES, currentTarget];

  // Compact rate label: keep small reciprocal rates readable, group large rates.
  const rateLabel =
    currentRate >= 1
      ? currentRate.toLocaleString()
      : currentRate.toLocaleString(undefined, { maximumFractionDigits: 6 });

  const handleAmountChange = (e) => {
    const val = e.target.value;
    if (val === '' || /^\d*\.?\d{0,2}$/.test(val)) {
      setAmount(val);
    }
  };

  // Corridor tabs and presets are discrete clicks, so the whole update can be
  // a transition: the press feedback paints first, the new quote renders after.
  const handleCorridorSwitch = (src, tgt) => {
    startTransition(() => {
      setSourceCurrency(src);
      setTargetCurrency(tgt);
    });
  };

  const handlePresetClick = (preset) => {
    startTransition(() => {
      setAmount(String(preset));
    });
  };

  const handleSwap = () => {
    // Exchange the two currencies and carry the amount the user was receiving
    // over as the new send amount, then let the fee and rate recalculate.
    const nextSource = targetCurrency;
    const nextTarget = sourceCurrency;
    const carriedAmount = Math.round(receivedAmount * 100) / 100;

    setSpinDegrees((degrees) => degrees + 180);
    setSourceCurrency(nextSource);
    setTargetCurrency(nextTarget);
    setAmount(carriedAmount === 0 ? '' : String(carriedAmount));
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
          const isDisabled = sourceCurrency === tgt.code;
          return (
            <button
              key={tgt.code}
              type="button"
              onClick={() => handleCorridorSwitch(sourceCurrency, tgt.code)}
              disabled={isDisabled}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
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
        <div className="grid gap-6 md:grid-cols-[1fr_auto_1fr] md:gap-8 items-center">
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
                  <span
                    key={sourceCurrency}
                    aria-hidden="true"
                    className="inline-block animate-fade-up [animation-duration:300ms]"
                  >
                    {currentSource.flag}
                  </span>
                  <select
                    id={sourceSelectId}
                    value={sourceCurrency}
                    onChange={(e) => setSourceCurrency(e.target.value)}
                    className="bg-transparent text-sm font-semibold text-dark outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-primary rounded"
                  >
                    {sourceOptions.map((c) => (
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
                      onClick={() => handlePresetClick(preset)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition ${
                        isSelected
                          ? 'border-primary bg-secondary text-primary'
                          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {liveSource.symbol}{preset}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Exchange rate display */}
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 bg-slate-50 rounded-xl p-3 border border-slate-100">
              <RefreshCw size={14} className="text-primary shrink-0" aria-hidden="true" />
              <RateLine rate={quote.rate} source={deferredSource} target={deferredTarget} />
            </div>
          </div>

          {/* Target Column: follows the deferred quote, flagged busy while it catches up */}
          <div
            className="space-y-4"
            aria-busy={isStale}
            data-stale={isStale ? 'true' : 'false'}
          >
              <span data-testid="calculator-rate">
                {currentRate === null
                  ? `${sourceCurrency} to ${targetCurrency} is not available`
                  : `1 ${sourceCurrency} = ${currentRate.toLocaleString()} ${targetCurrency}`}
              <span>
                1 {sourceCurrency} = {rateLabel} {targetCurrency}
              </span>
            </div>
          </div>

          {/* Swap currencies */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={handleSwap}
              aria-label="Swap currencies"
              title="Swap currencies"
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-primary shadow-md transition duration-300 hover:border-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              style={{ transform: `rotate(${spinDegrees}deg)` }}
            >
              <ArrowLeftRight size={18} aria-hidden="true" />
            </button>
          </div>

          {/* Target Column */}
          <div className="space-y-4">
            <div>
              <label htmlFor={targetSelectId} className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                Recipient Gets (Est.)
              </label>
              <div className="relative flex rounded-2xl border-2 border-emerald-100 bg-emerald-50/50 p-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
                <RecipientAmount quote={quote} target={currentTarget} />
                <div
                  data-testid="calculator-payout"
                  aria-live="polite"
                  className="w-full px-3 py-2 text-2xl font-extrabold text-emerald-800 sm:text-3xl truncate"
                >
                  {receivedAmount === null ? '—' : `${currentTarget.symbol} ${formatMoney(receivedAmount)}`}
                </div>
                <div className="flex items-center gap-1 border-l border-emerald-200 pl-3 pr-2">
                  <span
                    key={targetCurrency}
                    aria-hidden="true"
                    className="inline-block animate-fade-up [animation-duration:300ms]"
                  >
                    {currentTarget.flag}
                  </span>
                  <select
                    id={targetSelectId}
                    value={targetCurrency}
                    onChange={(e) => setTargetCurrency(e.target.value)}
                    className="bg-transparent text-sm font-semibold text-emerald-900 outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                  >
                    {targetOptions.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Breakdown summary */}
            <FeeBreakdown quote={quote} source={currentSource} target={currentTarget} />
            <div className="rounded-xl border border-slate-100 bg-slate-50/80 p-3.5 space-y-2 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>SendAm Fee ({sendAmFeePercent}%)</span>
                <span data-testid="calculator-fee" className="font-semibold text-slate-800">{currentSource.symbol}{sendAmFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Traditional Wire (~{traditionalFeePercent}%)</span>
                <span data-testid="calculator-traditional-fee" className="line-through text-slate-400">{currentSource.symbol}{traditionalFee.toFixed(2)}</span>
              </div>
              <div className="pt-2 border-t border-slate-200 flex justify-between items-center text-emerald-700 font-semibold">
                <span className="flex items-center gap-1">
                  <TrendingDown size={14} aria-hidden="true" />
                  Estimated Savings
                </span>
                <span data-testid="calculator-savings" className="text-sm">
                  {currentSource.symbol}{estimatedSavings.toFixed(2)}
                  {estimatedSavingsInTarget !== null &&
                    ` (${currentTarget.symbol}${Math.round(estimatedSavingsInTarget).toLocaleString()})`}
                </span>
              </div>

              {/* Collapsible full fee transparency drawer */}
              <div className="pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setBreakdownOpen((open) => !open)}
                  aria-expanded={breakdownOpen}
                  aria-controls={breakdownId}
                  className="w-full flex items-center justify-between gap-2 py-1 text-slate-600 font-semibold hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                >
                  <span>View fee breakdown</span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={`transition-transform duration-300 ${breakdownOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                <div
                  id={breakdownId}
                  role="region"
                  aria-label="Fee breakdown"
                  aria-hidden={!breakdownOpen}
                  className={`grid transition-[grid-template-rows] duration-300 ease-in-out motion-reduce:transition-none ${
                    breakdownOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="overflow-hidden">
                    <dl className="pt-2 space-y-2">
                      <div className="flex justify-between text-slate-600">
                        <dt>You send</dt>
                        <dd className="font-semibold text-slate-800">
                          {currentSource.symbol}{parsedAmount.toFixed(2)}
                        </dd>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <dt>SendAm service fee ({sendAmFeePercent}%)</dt>
                        <dd className="font-semibold text-slate-800">
                          −{currentSource.symbol}{sendAmFee.toFixed(2)}
                        </dd>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <dt>Stellar network fee (covered by SendAm)</dt>
                        <dd className="font-semibold text-slate-800">&lt;{currentSource.symbol}0.0001</dd>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-slate-200 text-slate-700 font-semibold">
                        <dt>Net send amount</dt>
                        <dd className="text-slate-900">
                          {currentSource.symbol}{netSendAmount.toFixed(2)}
                        </dd>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <dt>Guaranteed FX rate</dt>
                        <dd className="font-semibold text-slate-800">
                          1 {sourceCurrency} = {currentRate.toLocaleString()} {targetCurrency}
                        </dd>
                      </div>
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <dt>Recipient gets</dt>
                        <dd>
                          {currentTarget.symbol}{receivedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </dd>
                      </div>
                    </dl>
                    <p className="pt-2 text-[11px] leading-snug text-slate-400">
                      The Stellar network base fee (under {currentSource.symbol}0.0001 per transaction) is paid
                      by SendAm, so it is never deducted from your transfer. The FX rate is locked when you
                      send — no recipient-side spread.
                    </p>
                  </div>
                </div>
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
            href={whatsappUrl(sendCommand(amount, sourceCurrency, targetCurrency))}
            data-testid="calculator-whatsapp-link"
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
