import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { maskPhoneNumber } from './maskPhoneNumber.js';

// Displays a phone number masked by default, with an eye toggle to reveal it.
// `onReveal` is awaited before the number is unmasked, so the caller can record
// the reveal in the audit trail. If it rejects, the number stays masked.
export default function MaskedPhone({ phone, onReveal }) {
  const [isRevealed, setIsRevealed] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState(null);

  if (!phone) return '-';

  const toggle = async () => {
    if (isRevealed) {
      setIsRevealed(false);
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      await onReveal();
      setIsRevealed(true);
    } catch {
      setError('Could not reveal number');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono">{maskPhoneNumber(phone, isRevealed)}</span>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        aria-label={isRevealed ? 'Hide phone number' : 'Reveal phone number'}
        className="text-slate-500 hover:text-slate-700 disabled:opacity-50"
      >
        {isRevealed ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
