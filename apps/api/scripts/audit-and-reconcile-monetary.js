#!/usr/bin/env node

const prisma = require('../src/common/prisma');
const logger = require('../src/utils/logger');
const { reconcileMonetaryValues } = require('../src/payment/payment.reconciler');

const main = async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  logger.info(`Starting monetary audit & reconciliation (applyMode=${apply})...`);

  try {
    const result = await reconcileMonetaryValues({
      prisma,
      apply,
      loggerInstance: logger,
    });

    console.log('\n--- Monetary Reconciliation Audit Summary ---');
    console.log(`Total Records Checked: ${result.checkedCount}`);
    console.log(`Non-canonical / Invalid Records Found: ${result.invalidCount}`);
    console.log(`Records Reconciled / Fixed: ${result.fixedCount}`);
    if (result.errors.length > 0) {
      console.log(`Errors Encountered (${result.errors.length}):`, result.errors);
    }
    console.log('---------------------------------------------\n');

    if (!apply && result.invalidCount > 0) {
      console.log('Run with --apply to perform automatic database updates.');
    }
  } catch (err) {
    console.error('Reconciliation failed:', err);
    process.exit(1);
  } finally {
    if (prisma.$disconnect) {
      await prisma.$disconnect();
    }
  }
};

if (require.main === module) {
  main();
}

module.exports = { main };
