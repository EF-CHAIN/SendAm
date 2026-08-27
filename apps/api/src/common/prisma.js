const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const config = require('../config/env');

const dbUrl = config.databaseUrl || process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/sendam_dev';

if (!dbUrl) {
  throw new Error('DATABASE_URL must be set. Use your Neon PostgreSQL connection string.');
}

const adapter = new PrismaPg({ connectionString: dbUrl });

const prisma = new PrismaClient({ adapter });

module.exports = prisma;
