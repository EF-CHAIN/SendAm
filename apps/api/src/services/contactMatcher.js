const normalize = (name) => String(name || '').normalize('NFKD')
  .replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');

// Jaro-Winkler similarity favors common prefixes while tolerating transpositions.
const similarity = (left, right) => {
  const a = Array.from(normalize(left));
  const b = Array.from(normalize(right));
  const radius = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const used = new Set();
  const matched = [];
  for (const [i, char] of a.entries()) {
    for (let j = Math.max(0, i - radius); j <= Math.min(b.length - 1, i + radius); j++) {
      if (char !== b[j] || used.has(j)) continue;
      matched.push(char);
      used.add(j);
      break;
    }
  }
  if (!matched.length) return 0;
  const ordered = b.filter((_, i) => used.has(i));
  const transpositions = matched.filter((char, i) => char !== ordered[i]).length / 2;
  const jaro = (matched.length / a.length + matched.length / b.length +
    (matched.length - transpositions) / matched.length) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && a[prefix] === b[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
};

const matchContacts = (name, contacts) => {
  const ranked = contacts.map((contact) => ({ ...contact, score: similarity(name, contact.label) }))
    .filter(({ score }) => score > 0.85)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const targets = new Set();
  return ranked.filter(({ target, score }) => {
    if (ranked[0].score - score > 0.05 || targets.has(target)) return false;
    targets.add(target);
    return true;
  }).slice(0, 10).map(({ label, target }) => ({ label, target }));
};

module.exports = { matchContacts };
