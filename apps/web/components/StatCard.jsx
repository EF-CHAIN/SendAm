export default function StatCard({ title, value, icon: Icon, colorClass = "text-primary" }) {
  return (
    <div className="bg-white p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-4 hover:shadow-md transition-shadow min-w-0">
      <div className={`p-3 sm:p-4 rounded-full bg-opacity-10 ${colorClass.replace('text-', 'bg-')} ${colorClass} shrink-0`}>
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
        <h3 className="text-2xl font-bold text-dark break-words">{value}</h3>
      </div>
    </div>
  );
}
