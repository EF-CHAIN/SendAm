'use strict';

// Shared live-database client for the integration tests that exercise real
// ORM flows (e.g. support.workflow.test.js). Connects to DATABASE_URL, which CI
// migrates (prisma:deploy) before running `npm test`. Mirrors the driver
// adapter setup used by src/common/prisma.js so the client initializes without
// a network round-trip at import time.
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;

const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: dbUrl })),
});

module.exports = { prisma };
