import express from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { isAuthenticated } from './auth.js';
import { waManager } from '../index.js';
import { deviceModel, messageModel, statsModel, logModel } from '../models/database.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiter
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30
});

router.use(limiter);
router.use(isAuthenticated);

// Get all devices
router.get('/', async (req, res) => {
  try {
    const devices = deviceModel.findAll();
    const devicesWithStatus = devices.map(device => waManager.getStatus(device.id));
    res.json({ success: true, data: devicesWithStatus });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get single device
router.get('/:id', async (req, res) => {
  try {
    const device = waManager.getStatus(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }
    res.json({ success: true, data: device });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create device
router.post('/',
  body('name').trim().notEmpty().withMessage('Name is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const deviceId = `device-${uuidv4()}`;
      const { name } = req.body;

      const device = deviceModel.create(deviceId, name);
      await waManager.createDevice(deviceId, name);

      res.json({ success: true, data: device });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Update device
router.put('/:id',
  body('name').optional().trim().notEmpty(),
  body('webhook_url').optional().isURL(),
  body('webhook_enabled').optional().isBoolean(),
  body('webhook_response_enabled').optional().isBoolean(),
  body('webhook_body_template').optional(),
  body('webhook_response_path').optional().trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const device = deviceModel.findById(req.params.id);
      if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
      }

      const updates = {};
      if (req.body.name) updates.name = req.body.name;
      if (req.body.webhook_url !== undefined) updates.webhook_url = req.body.webhook_url;
      if (req.body.webhook_enabled !== undefined) {
        updates.webhook_enabled = req.body.webhook_enabled ? 1 : 0;
      }
      if (req.body.webhook_response_enabled !== undefined) {
        updates.webhook_response_enabled = req.body.webhook_response_enabled ? 1 : 0;
      }
      if (req.body.webhook_body_template !== undefined) {
        updates.webhook_body_template = req.body.webhook_body_template;
      }
      if (req.body.webhook_response_path !== undefined) {
        updates.webhook_response_path = req.body.webhook_response_path;
      }

      deviceModel.update(req.params.id, updates);
      const updated = deviceModel.findById(req.params.id);

      res.json({ success: true, data: updated });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Delete device
router.delete('/:id', async (req, res) => {
  try {
    const device = deviceModel.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    await waManager.disconnectDevice(req.params.id);
    deviceModel.delete(req.params.id);

    res.json({ success: true, message: 'Device deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get QR code
router.get('/:id/qr', async (req, res) => {
  try {
    const device = deviceModel.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    res.json({
      success: true,
      data: {
        qr_code: device.qr_code,
        status: device.status
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Restart device
router.post('/:id/restart', async (req, res) => {
  try {
    const device = deviceModel.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    await waManager.restartDevice(req.params.id);
    res.json({ success: true, message: 'Device restart initiated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Send message
router.post('/:id/send',
  body('to').trim().notEmpty().withMessage('Recipient is required'),
  body('message').trim().notEmpty().withMessage('Message is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { to, message } = req.body;
      const result = await waManager.sendMessage(req.params.id, to, message);

      res.json({ success: true, data: { message_id: result.id._serialized } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Get chats
router.get('/:id/chats', async (req, res) => {
  try {
    const chats = await waManager.getChats(req.params.id);
    res.json({ success: true, data: chats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get messages
router.get('/:id/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const messages = messageModel.findByDevice(req.params.id, limit);
    res.json({ success: true, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get device stats
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = statsModel.get(req.params.id);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get device logs
router.get('/:id/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = logModel.findByDevice(req.params.id, limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Test webhook
router.post('/:id/test-webhook',
  body('webhook_url').isURL().withMessage('Valid webhook URL is required'),
  body('body_template').optional(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const device = deviceModel.findById(req.params.id);
      if (!device) {
        return res.status(404).json({ success: false, message: 'Device not found' });
      }

      const { webhook_url, body_template } = req.body;

      // Build test payload
      const testVariables = {
        device_id: device.id,
        device_name: device.name,
        device_phone: device.phone_number || "628123456789",
        message_id: "test-msg-" + Date.now(),
        from: "628987654321@c.us",
        to: device.phone_number || "628123456789@c.us",
        from_name: "Test User",
        message: "This is a test message from WhatsApp Manager",
        message_type: "chat",
        timestamp: Math.floor(Date.now() / 1000),
        is_group: false,
        chat_name: "Test User",
        has_media: false,
        is_forwarded: false,
        is_status: false,
        broadcast: false
      };

      let requestPayload;
      
      if (body_template) {
        try {
          // Build dynamic payload
          let jsonString = body_template;
          Object.keys(testVariables).forEach(key => {
            const regex = new RegExp(`{{${key}}}`, 'g');
            const value = testVariables[key];
            if (typeof value === 'string') {
              jsonString = jsonString.replace(regex, value);
            } else {
              jsonString = jsonString.replace(regex, String(value));
            }
          });
          requestPayload = JSON.parse(jsonString);
        } catch (error) {
          logModel.create(device.id, 'error', `Webhook test failed - Invalid template: ${error.message}`);
          return res.status(400).json({ 
            success: false, 
            message: 'Invalid body template', 
            error: error.message 
          });
        }
      } else {
        requestPayload = testVariables;
      }

      logModel.create(device.id, 'info', `Testing webhook: ${webhook_url}`);

      try {
        const axios = (await import('axios')).default;
        const response = await axios.post(webhook_url, requestPayload, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });

        logModel.create(device.id, 'info', `Webhook test successful: ${response.status}`);

        res.json({
          success: true,
          data: {
            status: response.status,
            request: requestPayload,
            response: response.data
          }
        });
      } catch (error) {
        const errorMsg = error.response 
          ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
          : error.message;
        
        logModel.create(device.id, 'error', `Webhook test failed: ${errorMsg}`);

        res.status(500).json({
          success: false,
          message: 'Webhook request failed',
          error: errorMsg,
          request: requestPayload
        });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;