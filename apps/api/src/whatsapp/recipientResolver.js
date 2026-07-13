// Recipient resolution with a fixed, documented precedence:
//   1. saved contacts (the user's own Alias rows) — bare names live here
//   2. raw addresses, passed through untouched
// Address validity is still enforced downstream (detectChainFromAddress in
// the confirmation flow).
//
// prisma is injected so this stays unit-testable offline.
const createRecipientResolver = ({ prisma }) => {
  return async (user, recipient) => {
    const raw = String(recipient || '').trim();
    const normalized = raw.toLowerCase();

    // 1. Saved contacts — exact alias match.
    const savedAlias = await prisma.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: normalized } },
    });
    if (savedAlias) return { destination: savedAlias.target, label: normalized };

    // 2. Raw address (or an unresolvable name — the confirmation flow's
    // address check will reject that with a clear message).
    return { destination: raw, label: raw };
  };
};

module.exports = { createRecipientResolver };
