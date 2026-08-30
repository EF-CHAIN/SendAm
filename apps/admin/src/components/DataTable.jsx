/**
 * Generic data table with optional row-click support.
 *
 * Props:
 *   columns      — array of { header, accessor?, render? }
 *   data         — array of row objects
 *   keyField     — unique key field name (default: 'id')
 *   onRowClick   — optional (row) => void handler; makes rows focusable / clickable
 *   rowClassName — optional extra class(es) added to every <tr>
 */
export default function DataTable({
  columns,
  data,
  keyField = 'id',
  onRowClick,
  rowClassName = '',
}) {
  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 bg-white rounded-xl border border-gray-100">
        No records found.
      </div>
    );
  }

  const handleRowKeyDown = (e, row) => {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className="w-full max-w-full overflow-x-auto bg-white rounded-xl border border-gray-100 shadow-sm">
      <table className="min-w-max w-full text-sm text-left text-gray-600">
        <thead className="text-xs text-gray-500 uppercase bg-gray-50 border-b border-gray-100">
          <tr>
            {columns.map((col, idx) => (
              <th key={idx} scope="col" className="px-4 sm:px-6 py-4 whitespace-nowrap">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr
              key={row[keyField] || idx}
              className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${rowClassName}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => handleRowKeyDown(e, row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              aria-label={onRowClick ? `View details for row ${idx + 1}` : undefined}
            >
              {columns.map((col, colIdx) => (
                <td key={colIdx} className="px-4 sm:px-6 py-4 whitespace-nowrap">
                  {col.render ? col.render(row) : row[col.accessor]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
