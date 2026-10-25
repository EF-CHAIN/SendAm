import { useState } from 'react';
import { ArrowRight, Layers, BookOpen } from 'lucide-react';

/**
 * Reads the Stellar path-payment description from a transaction. Accepted shape
 * (on `tx.pathPayment` or `tx.metadata.pathPayment`):
 *
 *   {
 *     sourceAsset: 'USDC' | 'USDC:G...' | { code, issuer } | 'native',
 *     sourceAmount, destAsset, destAmount,
 *     path: [asset, ...],                    // optional intermediate assets
 *     hops: [{ type: 'orderbook' | 'amm', poolId, rate, amountIn, amountOut }],
 *   }
 *
 * Returns null when there is nothing to draw (no path data, or a same-asset payment).
 */
// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function normalizeAsset(asset) {
  if (asset === undefined || asset === null || asset === '') return null;
  if (typeof asset === 'string') {
    const [code, issuer] = asset.split(':');
    if (code === 'native') return { code: 'XLM', issuer: null };
    return { code, issuer: issuer || null };
  }
  const code = asset.code ?? asset.asset_code;
  const issuer = asset.issuer ?? asset.asset_issuer ?? null;
  if (asset.type === 'native' || asset.asset_type === 'native') return { code: 'XLM', issuer: null };
  return code ? { code, issuer } : null;
}

function toNumber(value) {
  const n = Number(value);
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) ? n : null;
}

// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function formatRate(value) {
  if (!Number.isFinite(value)) return '—';
  return Number(value.toPrecision(7)).toLocaleString(undefined, { maximumFractionDigits: 7 });
}

// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function shortenId(id) {
  if (!id || id.length <= 14) return id || '';
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function extractPaymentPath(tx) {
  const raw = tx?.pathPayment ?? tx?.metadata?.pathPayment;
  if (!raw || typeof raw !== 'object') return null;
  const source = normalizeAsset(raw.sourceAsset);
  const dest = normalizeAsset(raw.destAsset);
  if (!source || !dest) return null;

  const hops = Array.isArray(raw.hops) ? raw.hops : [];
  let middle = [];
  if (Array.isArray(raw.path)) middle = raw.path.map(normalizeAsset).filter(Boolean);
  else if (hops.length > 1) middle = hops.slice(0, -1).map((hop) => normalizeAsset(hop.to)).filter(Boolean);

  if (middle.length === 0 && hops.length === 0 && source.code === dest.code && source.issuer === dest.issuer) return null;

  const sourceAmount = toNumber(raw.sourceAmount);
  const destAmount = toNumber(raw.destAmount);
  const assets = [source, ...middle, dest];
  const nodes = assets.map((asset, index) => ({
    ...asset,
    amount: index === 0 ? sourceAmount : index === assets.length - 1 ? destAmount : null,
  }));

  const segments = assets.slice(0, -1).map((from, index) => {
    const to = assets[index + 1];
    const hop = hops[index] || {};
    const isAmm = Boolean(hop.poolId) || /amm|pool/i.test(String(hop.type || ''));
    const amountIn = toNumber(hop.amountIn);
    const amountOut = toNumber(hop.amountOut);
    let rate = toNumber(hop.rate);
    if (rate === null && amountIn && amountOut !== null) rate = amountOut / amountIn;
    if (rate === null && assets.length === 2 && sourceAmount && destAmount !== null) rate = destAmount / sourceAmount;
    return {
      from: from.code,
      to: to.code,
      venue: isAmm ? 'amm' : 'orderbook',
      poolId: hop.poolId || null,
      rate,
    };
  });

  const overallRate = sourceAmount && destAmount !== null ? destAmount / sourceAmount : null;
  return { nodes, segments, overallRate };
}

/** Interactive Source Asset → Orderbook / AMM Pool → Destination Asset diagram. */
export default function PaymentPathVisualizer({ tx }) {
  const path = extractPaymentPath(tx);
  const [selected, setSelected] = useState(null);
  if (!path) return null;

  const { nodes, segments, overallRate } = path;
  const active = selected === null ? null : nodes[selected];

  return (
    <section aria-labelledby="payment-path-heading" data-testid="payment-path">
      <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800/60 border-t border-b border-gray-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <h2 id="payment-path-heading" className="text-sm font-semibold text-gray-700 dark:text-gray-300">Payment Path</h2>
        {overallRate !== null && (
          <span className="text-xs text-gray-500" data-testid="path-overall-rate">
            1 {nodes[0].code} ≈ {formatRate(overallRate)} {nodes[nodes.length - 1].code}
          </span>
        )}
      </div>
      <div className="px-4 py-4 overflow-x-auto">
        <ol className="flex items-stretch gap-2 min-w-max" aria-label="Stellar payment path">
          {nodes.map((node, index) => {
            const segment = segments[index];
            return (
              <li key={`${node.code}-${index}`} className="flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(selected === index ? null : index)}
                  aria-pressed={selected === index}
                  aria-label={`${index === 0 ? 'Source' : index === nodes.length - 1 ? 'Destination' : 'Intermediate'} asset ${node.code}`}
                  className={`flex flex-col justify-center rounded-xl border px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    selected === index
                      ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40'
                      : 'border-gray-200 bg-white hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900'
                  }`}
                >
                  <span className="text-[11px] uppercase tracking-wide text-gray-500">
                    {index === 0 ? 'Source' : index === nodes.length - 1 ? 'Destination' : 'Via'}
                  </span>
                  <span className="text-base font-bold text-slate-900 dark:text-slate-100">{node.code}</span>
                  {node.amount !== null && (
                    <span className="text-xs font-mono text-gray-600 dark:text-gray-400">{formatRate(node.amount)}</span>
                  )}
                </button>
                {segment && (
                  <div className="flex flex-col items-center justify-center gap-1 px-1 text-xs text-gray-600 dark:text-gray-400" data-testid="path-segment">
                    <span className="inline-flex items-center gap-1 font-semibold">
                      {segment.venue === 'amm' ? <Layers className="w-3.5 h-3.5" aria-hidden="true" /> : <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />}
                      {segment.venue === 'amm' ? 'AMM Pool' : 'Orderbook'}
                    </span>
                    <ArrowRight className="w-5 h-5 text-indigo-500" aria-hidden="true" />
                    {segment.rate !== null && (
                      <span className="font-mono" data-testid="segment-rate">1 {segment.from} = {formatRate(segment.rate)} {segment.to}</span>
                    )}
                    {segment.poolId && (
                      <span className="font-mono" title={segment.poolId} data-testid="segment-pool-id">Pool ID: {shortenId(segment.poolId)}</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {active && (
          <dl className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-950" data-testid="path-node-details">
            <div className="sm:grid sm:grid-cols-3 sm:gap-2 py-1">
              <dt className="text-gray-500">Asset</dt>
              <dd className="sm:col-span-2 font-semibold">{active.code}</dd>
            </div>
            <div className="sm:grid sm:grid-cols-3 sm:gap-2 py-1">
              <dt className="text-gray-500">Issuer</dt>
              <dd className="sm:col-span-2 font-mono break-all">{active.issuer || (active.code === 'XLM' ? 'Native asset' : '—')}</dd>
            </div>
            {segments.filter((s) => s.poolId).map((s) => (
              <div key={s.poolId} className="sm:grid sm:grid-cols-3 sm:gap-2 py-1">
                <dt className="text-gray-500">Pool {s.from}/{s.to}</dt>
                <dd className="sm:col-span-2 font-mono break-all">{s.poolId}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
