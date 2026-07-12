// Atomic claim of a user's pendingSend. Two WhatsApp messages carrying a
// valid PIN can be processed concurrently (webhook dedup is per message id,
// and both are different messages) — without an atomic claim BOTH would
// pass the guard and execute the payment twice. updateMany's WHERE clause
// makes the database the referee: exactly one caller sees count === 1.
//
// prisma and Prisma are injected (not required here) so this stays
// unit-testable offline — common/prisma throws at require-time without
// DATABASE_URL.
//
// Prisma Json-null semantics: the filter uses Prisma.AnyNull (matches both
// SQL NULL and JSON null, robust to either having been written historically)
// while the write uses Prisma.DbNull (plain SQL NULL).
const claimPendingSend = async ({ prisma, Prisma, userId }) => {
  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      NOT: { pendingSend: { equals: Prisma.AnyNull } },
    },
    data: { pendingSend: Prisma.DbNull },
  });
  return result.count === 1;
};

module.exports = { claimPendingSend };
