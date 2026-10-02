export default function StatCard({ title, value, icon: Icon, colorClass = 'text-primary' }) {
  return (
    <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 dark:border-slate-800 flex items-center gap-4 hover:shadow-md transition-shadow min-w-0">
      <div className={`p-3 sm:p-4 rounded-full bg-opacity-10 dark:bg-opacity-20 ${colorClass.replace('text-', 'bg-')} ${colorClass} shrink-0`}>
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">{title}</p>
        <p className="text-2xl font-bold text-dark dark:text-white break-words">{value}</p>
      </div>
    </div>
  );
}
