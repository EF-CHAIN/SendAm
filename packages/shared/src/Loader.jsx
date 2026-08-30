import { Loader2 } from 'lucide-react';

export default function Loader({ size = 24, className = 'text-primary' }) {
  return (
    <span role="status" aria-label="Loading">
      <Loader2 size={size} className={`animate-spin ${className}`} />
    </span>
  );
}
