import { Inbox } from 'lucide-react';

export default function EmptyState({ message = "No data available", icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
      <Icon className="w-12 h-12 text-gray-300 mb-4" />
      <h3 className="text-lg font-medium text-gray-600">{message}</h3>
    </div>
  );
}
