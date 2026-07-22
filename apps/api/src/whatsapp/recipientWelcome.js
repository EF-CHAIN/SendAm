// One-time welcome for recipients who receive money on SendAm before they've
// ever talked to the bot. The welcome fires exactly once per user, keyed on
// the User row (welcomeSentAt), not on message history.
//
// Atomic claim via updateMany: two concurrent deposits for the same fresh user
// both reach this code — exactly one wins the claim and sends the welcome.
// The loser gets count === 0 and skips. This is the same pattern used by
// pendingClaim.js for double-confirm races.
//
// prisma is injected (not required here) so this stays unit-testable offline.

const WELCOME_MESSAGE = 'You\'ve received money on SendAm — reply "balance" to see it, "help" for commands.';

const claimWelcome = async ({ prisma, userId }) => {
  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      welcomeSentAt: null,
    },
    data: {
      welcomeSentAt: new Date(),
    },
  });
  return result.count === 1;
};

const sendWelcomeForDeposit = async ({ user, phoneNumber, prisma, notify }) => {
  const won = await claimWelcome({ prisma, userId: user.id });
  if (won) {
    await notify(phoneNumber, WELCOME_MESSAGE);
  }
  return won;
};

module.exports = {
  claimWelcome,
  sendWelcomeForDeposit,
  WELCOME_MESSAGE,
};
