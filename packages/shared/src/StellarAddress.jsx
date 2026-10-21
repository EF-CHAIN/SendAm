import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** How long the checkmark stays visible after a successful copy. */
const COPIED_RESET_MS = 2000;
const VISIBLE_CHARS = 4;

/** GABC...WXYZ for long values; shorter values are returned unchanged. */
function truncate(address) {
  if (address.length <= VISIBLE_CHARS * 2 + 3) return address;
  return `${address.slice(0, VISIBLE_CHARS)}...${address.slice(-VISIBLE_CHARS)}`;
}

/** Copy via the async Clipboard API, falling back to execCommand. */
async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path below.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * Renders a Stellar public key as `GABC...WXYZ` with the full address in a
 * tooltip and a one-click copy action.
 *
 * Renders nothing for an empty or non-string address.
 *
 * @param {Object} props
 * @param {string} props.address - full 56-character public key
 * @param {string} [props.className] - extra classes for the button
 */
export default function StellarAddress({ address, className = '' }) {
  const [status, setStatus] = useState('idle'); // 'idle' | 'copied' | 'failed'
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(address);
    setStatus(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), COPIED_RESET_MS);
  }, [address]);

  if (typeof address !== 'string' || address.length === 0) return null;

  const Icon = status === 'copied' ? Check : Copy;

  return (
    <button
      type="button"
      title={address}
      aria-label={`Copy Stellar address ${address}`}
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 whitespace-nowrap font-mono text-sm hover:underline focus-visible:outline focus-visible:outline-2 ${className}`.trim()}
    >
      <span>{truncate(address)}</span>
      <Icon size={14} aria-hidden="true" data-testid={status === 'copied' ? 'copied-icon' : 'copy-icon'} />
      <span role="status" className="sr-only">
        {status === 'copied' && 'Address copied'}
        {status === 'failed' && 'Copy failed'}
      </span>
    </button>
  );
}
