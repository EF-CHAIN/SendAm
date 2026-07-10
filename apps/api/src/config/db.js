const prisma = require('../common/prisma');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    await prisma.$connect();
    logger.info('PostgreSQL connected successfully');
  } catch (error) {
    logger.error('PostgreSQL connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
