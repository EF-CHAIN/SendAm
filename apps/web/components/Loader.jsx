import { Loader2 } from 'lucide-react';

export default function Loader({ size = 24, className = "text-primary" }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}
