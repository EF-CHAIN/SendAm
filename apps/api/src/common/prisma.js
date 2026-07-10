const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const config = require('../config/env');

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL must be set. Use your Neon PostgreSQL connection string.');
}

const adapter = new PrismaPg({ connectionString: config.databaseUrl });

const prisma = new PrismaClient({ adapter });

module.exports = prisma;
