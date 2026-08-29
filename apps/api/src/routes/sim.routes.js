const express = require('express');
const router = express.Router();
const createSimController = require('../controllers/sim.controller');
const { validateRequest } = require('../middlewares/validateRequest');

const simController = createSimController();

router.post(
  '/message',
  validateRequest({
    body: {
      allowedKeys: ['phoneNumber', 'name', 'text'],
      required: ['phoneNumber', 'text'],
      fields: {
        phoneNumber: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phoneNumber is required',
        },
        name: { type: 'string', optional: true },
        text: {
          type: 'string',
          trim: true,
          custom: (value) => value.trim().length > 0,
          message: 'text is required',
        },
      },
    },
  }),
  simController.handleMessage,
);

router.get(
  '/messages/:phone',
  validateRequest({
    params: {
      allowedKeys: ['phone'],
      required: ['phone'],
      fields: {
        phone: {
          type: 'string',
          trim: true,
          custom: (value) => value.length > 5,
          message: 'A valid phone number is required',
        },
      },
    },
    query: {
      allowedKeys: ['since'],
      fields: {
        since: { type: 'string', optional: true },
      },
    },
  }),
  simController.listMessages,
);

module.exports = router;
