const config = require('../config/env');

const verifyWebhook = (req, res, next) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];

  if (mode && token) {
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
      return next();
    } else {
      return res.sendStatus(403);
    }
  }
  next();
};

module.exports = verifyWebhook;
