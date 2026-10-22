import { Loader2 } from 'lucide-react';

export default function Loader({ size = 24, className = 'text-primary' }) {
  return (
    <span role="status" aria-live="polite" aria-label="Loading">
      <span className="sr-only">Loading data, please wait...</span>
      <Loader2 size={size} className={`animate-spin ${className}`} />
    </span>
  );
}
