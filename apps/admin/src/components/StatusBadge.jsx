export default function StatusBadge({ status }) {
  let colorClass = 'bg-gray-100 text-gray-600';

  switch (status?.toLowerCase()) {
    case 'success':
      colorClass = 'bg-green-100 text-green-700';
      break;
    case 'pending':
      colorClass = 'bg-yellow-100 text-yellow-700';
      break;
    case 'failed':
      colorClass = 'bg-red-100 text-red-700';
      break;
  }

  return (
    <span className={`px-2.5 py-1 text-xs font-semibold rounded-full capitalize ${colorClass}`}>
      {status || 'Unknown'}
    </span>
  );
}
