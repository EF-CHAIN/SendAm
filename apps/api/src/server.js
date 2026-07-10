const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const logger = require('./utils/logger');
const { registerJobs } = require('./jobs');

const startServer = async () => {
  await connectDB();
  registerJobs();

  app.listen(config.port, () => {
    logger.info(`Server running in ${config.env} mode on port ${config.port}`);
  });
};

startServer();
