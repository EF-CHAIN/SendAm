'use strict';

// Shared live-database client for the integration tests that exercise real
// ORM flows (e.g. support.workflow.test.js). Connects to DATABASE_URL, which CI
// migrates (prisma:deploy) before running `npm test`. No extra services are
// required; tests that need a durable backend import `{ prisma }` from here.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = { prisma };