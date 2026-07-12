// Recipient resolution with a fixed, documented precedence:
//   1. saved contacts (the user's own Alias rows) — bare names live here
//   2. sigil-prefixed GLOBAL names (@ada or ada*domain) via sendam-ns
//   3. raw addresses, passed through untouched
// The sigil requirement is the collision rule: a saved contact "ada" and a
// global "@ada" can never shadow each other silently — bare input stops at
// contacts, sigil input skips them for NS. Address validity is still
// enforced downstream (detectChainFromAddress in the confirmation flow).
//
// prisma and nsClient are injected so this stays unit-testable offline.
const createRecipientResolver = ({ prisma, nsClient }) => {
  return async (user, recipient) => {
    const raw = String(recipient || '').trim();
    const normalized = raw.toLowerCase();

    // 1. Saved contacts — exact alias match, including sigil-less names.
    const savedAlias = await prisma.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: normalized } },
    });
    if (savedAlias) return { destination: savedAlias.target, label: normalized };

    // 2. Global names — only sigil-prefixed forms ever reach the NS.
    const isGlobalForm = normalized.startsWith('@') || normalized.includes('*');
    if (isGlobalForm && nsClient.enabled) {
      const resolved = await nsClient.resolveName(normalized);
      if (resolved) return { destination: resolved.accountId, label: normalized };
    }

    // 3. Raw address (or an unresolvable name — the confirmation flow's
    // address check will reject that with a clear message).
    return { destination: raw, label: raw };
  };
};

module.exports = { createRecipientResolver };
