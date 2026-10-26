/**
 * Highlights matching search query terms within text string.
 */
export default function HighlightMatch({ text, query }) {
  if (!text) return null;
  const str = String(text);
  const trimmed = (query || "").trim();
  if (!trimmed) return <span>{str}</span>;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = str.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <mark
            key={i}
            className="bg-amber-200 dark:bg-amber-800 text-amber-950 dark:text-amber-100 font-bold px-0.5 rounded-xs"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}
