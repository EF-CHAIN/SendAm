import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Collapsible, syntax-highlighted JSON tree for the dark (bg-gray-900) panels
// the admin uses for decoded XDR. Keys render blue, strings green, numbers
// orange; booleans and null get their own muted colors so "false" never reads
// like a string. Every composite node is a real <button> with aria-expanded,
// so the tree is keyboard- and screen-reader-operable.

const INDENT_PER_LEVEL = 16;

function Primitive({ value }) {
  if (value === null) return <span className="italic text-gray-400">null</span>;
  switch (typeof value) {
    case 'string':
      return <span className="text-emerald-400">&quot;{value}&quot;</span>;
    case 'number':
      return <span className="text-orange-400">{String(value)}</span>;
    case 'boolean':
      return <span className="text-fuchsia-400">{String(value)}</span>;
    default:
      return <span className="text-gray-300">{String(value)}</span>;
  }
}

function isComposite(value) {
  return typeof value === 'object' && value !== null;
}

function summaryFor(value) {
  if (Array.isArray(value)) {
    return value.length === 1 ? '[…] 1 item' : `[…] ${value.length} items`;
  }
  const size = Object.keys(value).length;
  return size === 1 ? '{…} 1 key' : `{…} ${size} keys`;
}

function TreeNode({ name, value, depth, defaultExpandedDepth, path }) {
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);
  const label =
    name !== undefined ? <span className="text-sky-400">{name}: </span> : null;
  const indent = { paddingLeft: `${depth * INDENT_PER_LEVEL}px` };

  if (!isComposite(value)) {
    return (
      <div style={indent} className="leading-5">
        {label}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div className="leading-5">
      <div style={indent}>
        <button
          type="button"
          onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name ?? 'root'}`}
          data-testid={`json-node-${path}`}
          className="inline-flex items-center gap-0.5 rounded text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
          )}
          {label}
          <span className="text-gray-300">{expanded ? open : summaryFor(value)}</span>
        </button>
      </div>
      {expanded && (
        <>
          {entries.map(([key, child]) => (
            <TreeNode
              key={key}
              name={key}
              value={child}
              depth={depth + 1}
              defaultExpandedDepth={defaultExpandedDepth}
              path={`${path}.${key}`}
            />
          ))}
          <div style={indent}>
            <span className="text-gray-300">{close}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function JsonTreeView({ data, defaultExpandedDepth = 2 }) {
  return (
    <div className="font-mono text-xs text-gray-100" data-testid="json-tree">
      <TreeNode
        value={data}
        depth={0}
        defaultExpandedDepth={defaultExpandedDepth}
        path="root"
      />
    </div>
  );
}
