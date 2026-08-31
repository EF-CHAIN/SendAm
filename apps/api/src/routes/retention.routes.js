'use strict';

// Operator visibility into the retention policy and its most recent runs
// (#315). Read-only plus an explicit dry run: the sweep itself is scheduled,
// and giving it a "purge now" button invites a destructive click that no
// amount of confirmation dialog makes safe.

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middlewares/requireAdmin');
const prisma = require('../common/prisma');
const { describePolicy } = require('../compliance/retentionPolicy');
const { runRetentionSweep } = require('../jobs/retention.jobs');

/** The enforced policy, generated from the same source the sweep reads. */
router.get('/policy', requireAdmin('compliance.read'), (_req, res) => {
  res.json(describePolicy());
});

/**
 * Outcomes of recent sweeps, taken from the audit trail rather than a separate
 * table — the audit entry is already the authoritative record that the sweep
 * ran, and a second store could disagree with it.
 */
router.get('/runs', requireAdmin('compliance.read'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const runs = await prisma.auditLog.findMany({
      where: { action: { in: ['retention_sweep_executed', 'retention_sweep_dry_run'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ runs });
  } catch (error) {
    next(error);
  }
});

/** Report what the sweep *would* remove, without removing anything. */
router.post('/dry-run', requireAdmin('compliance.write'), async (_req, res, next) => {
  try {
    res.json(await runRetentionSweep({ dryRun: true }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
