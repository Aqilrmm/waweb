import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { deviceModel, messageModel, statsModel, logModel } from '../models/database.js';
import { logger } from '../utils/logger.js';

export class WhatsAppManager {
  constructor() {
    this.clients = new Map();
  }

  async createDevice(deviceId, name) {
    if (this.clients.has(deviceId)) {
      throw new Error('Device already exists');
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: deviceId,
        dataPath: process.env.SESSIONS_PATH || './sessions'
      }),
      puppeteer: {
        headless: true,
        // Use system Chrome - try these paths in order
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' || '/usr/bin/chromium-browser' || '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--single-process', // Add this for stability
          '--disable-extensions'
        ]
      }
    });

    // QR Code handler
    client.on('qr', async (qr) => {
      try {
        const qrCodeData = await qrcode.toDataURL(qr);
        deviceModel.update(deviceId, { qr_code: qrCodeData, status: 'qr_ready' });
        logger.info(`QR Code generated for device ${deviceId}`);
        logModel.create(deviceId, 'info', 'QR Code generated');
      } catch (error) {
        logger.error(`Error generating QR code: ${error.message}`);
      }
    });

    // Ready handler
    client.on('ready', () => {
      const phoneNumber = client.info.wid.user;
      deviceModel.update(deviceId, {
        status: 'connected',
        phone_number: phoneNumber,
        qr_code: null
      });
      logger.info(`Device ${deviceId} is ready! Phone: ${phoneNumber}`);
      logModel.create(deviceId, 'info', `Connected with phone number ${phoneNumber}`);
    });

    // Message handler
    client.on('message', async (msg) => {
      await this.handleIncomingMessage(deviceId, msg);
    });

    // Disconnected handler
    client.on('disconnected', (reason) => {
      deviceModel.update(deviceId, { status: 'disconnected' });
      logger.warn(`Device ${deviceId} disconnected: ${reason}`);
      logModel.create(deviceId, 'warn', `Disconnected: ${reason}`);
    });

    // Auth failure handler
    client.on('auth_failure', (msg) => {
      deviceModel.update(deviceId, { status: 'auth_failure' });
      logger.error(`Authentication failure for device ${deviceId}: ${msg}`);
      logModel.create(deviceId, 'error', `Authentication failure: ${msg}`);
    });

    this.clients.set(deviceId, client);

    // Initialize client
    try {
      deviceModel.update(deviceId, { status: 'initializing' });
      await client.initialize();
      logger.info(`Device ${deviceId} initialization started`);
    } catch (error) {
      logger.error(`Error initializing device ${deviceId}: ${error.message}`);
      this.clients.delete(deviceId);
      throw error;
    }

    return client;
  }

  async handleIncomingMessage(deviceId, msg) {
    try {
      const messageData = {
        id: uuidv4(),
        device_id: deviceId,
        message_id: msg.id._serialized,
        from_number: msg.from,
        to_number: msg.to,
        message_body: msg.body,
        message_type: msg.type,
        timestamp: msg.timestamp,
        direction: 'incoming'
      };

      messageModel.create(messageData);
      statsModel.increment(deviceId, 'messages_received');

      logger.info(`[${deviceId}] Message received from ${msg.from}: ${msg.body.substring(0, 50)}...`);
      logModel.create(deviceId, 'info', `Received message from ${msg.from}`);

      // Get device config
      const device = deviceModel.findById(deviceId);
      
      if (device && device.webhook_enabled && device.webhook_url) {
        logger.info(`[${deviceId}] Webhook enabled, forwarding to: ${device.webhook_url}`);
        await this.forwardToWebhook(deviceId, device, msg, messageData);
      } else {
        logger.info(`[${deviceId}] Webhook disabled or not configured`);
      }
    } catch (error) {
      logger.error(`[${deviceId}] Error handling message: ${error.message}`);
      logModel.create(deviceId, 'error', `Error handling message: ${error.message}`);
    }
  }

  async forwardToWebhook(deviceId, device, msg, messageData) {
    try {
      // Build dynamic webhook payload
      let webhookPayload;
      
      logModel.create(deviceId, 'info', 'Building webhook payload...');
      
      if (device.webhook_body_template) {
        try {
          logger.info(`[${deviceId}] Using custom body template`);
          webhookPayload = this.buildDynamicPayload(device.webhook_body_template, {
            device_id: deviceId,
            device_name: device.name,
            device_phone: device.phone_number,
            message_id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            from_name: msg._data.notifyName || 'Unknown',
            message: msg.body,
            message_type: msg.type,
            timestamp: msg.timestamp,
            is_group: msg.from.includes('@g.us'),
            chat_name: msg._data.notifyName || msg.from,
            has_media: msg.hasMedia,
            is_forwarded: msg.isForwarded,
            is_status: msg.isStatus,
            broadcast: msg.broadcast
          });
          logModel.create(deviceId, 'info', 'Custom payload built successfully');
        } catch (error) {
          logger.error(`[${deviceId}] Error building dynamic payload: ${error.message}`);
          logModel.create(deviceId, 'error', `Payload build failed: ${error.message}`);
          webhookPayload = this.getDefaultPayload(deviceId, device, msg);
          logModel.create(deviceId, 'warn', 'Using default payload as fallback');
        }
      } else {
        logger.info(`[${deviceId}] Using default payload`);
        webhookPayload = this.getDefaultPayload(deviceId, device, msg);
      }

      logger.info(`[${deviceId}] Sending webhook to: ${device.webhook_url}`);
      logModel.create(deviceId, 'info', `Calling webhook: ${device.webhook_url}`);

      const response = await axios.post(device.webhook_url, webhookPayload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: function (status) {
          return status < 600; // Accept any status code less than 600
        }
      });

      statsModel.increment(deviceId, 'webhook_calls');
      
      if (response.status >= 200 && response.status < 300) {
        logger.info(`[${deviceId}] Webhook successful: ${response.status}`);
        logModel.create(deviceId, 'info', `Webhook success: ${response.status}`);
      } else {
        logger.warn(`[${deviceId}] Webhook returned non-success status: ${response.status}`);
        logModel.create(deviceId, 'warn', `Webhook status ${response.status}: ${JSON.stringify(response.data)}`);
      }

      // Send response back if enabled - only for successful responses
      if (device.webhook_response_enabled && response.data && response.status >= 200 && response.status < 300) {
        logger.info(`[${deviceId}] Processing webhook response for auto-reply`);
        const replyMessage = this.extractResponseMessage(response.data, device.webhook_response_path);
        
        if (replyMessage) {
          await this.sendMessage(deviceId, msg.from, replyMessage);
          logger.info(`[${deviceId}] Auto-reply sent to ${msg.from}`);
          logModel.create(deviceId, 'info', `Auto-reply sent: "${replyMessage.substring(0, 50)}..."`);
        } else {
          logger.warn(`[${deviceId}] No reply message found in webhook response`);
          logModel.create(deviceId, 'warn', 'No reply message in webhook response');
        }
      }
    } catch (error) {
      const errorMsg = error.response 
        ? `${error.response.status} - ${JSON.stringify(error.response.data)}`
        : error.message;
      
      logger.error(`[${deviceId}] Webhook error: ${errorMsg}`);
      logModel.create(deviceId, 'error', `Webhook failed: ${errorMsg}`);
    }
  }

  buildDynamicPayload(template, variables) {
    let jsonString = template;
    
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      const value = variables[key];
      
      if (typeof value === 'string') {
        jsonString = jsonString.replace(regex, value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        jsonString = jsonString.replace(regex, String(value));
      } else if (value === null || value === undefined) {
        jsonString = jsonString.replace(regex, 'null');
      }
    });
    
    return JSON.parse(jsonString);
  }

  getDefaultPayload(deviceId, device, msg) {
    return {
      device_id: deviceId,
      device_name: device.name,
      from: msg.from,
      to: msg.to,
      message: msg.body,
      message_type: msg.type,
      timestamp: msg.timestamp,
      message_id: msg.id._serialized
    };
  }

  extractResponseMessage(responseData, responsePath) {
    if (!responsePath) {
      return responseData.reply || responseData.message || responseData.response || null;
    }

    const paths = responsePath.split('.');
    let current = responseData;

    for (const path of paths) {
      if (current && typeof current === 'object' && path in current) {
        current = current[path];
      } else {
        return null;
      }
    }

    return typeof current === 'string' ? current : null;
  }

  async sendMessage(deviceId, to, message) {
    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error('Device not found');
    }

    const device = deviceModel.findById(deviceId);
    if (device.status !== 'connected') {
      throw new Error('Device not connected');
    }

    try {
      const chatId = to.includes('@') ? to : `${to}@c.us`;
      const sentMsg = await client.sendMessage(chatId, message);

      const messageData = {
        id: uuidv4(),
        device_id: deviceId,
        message_id: sentMsg.id._serialized,
        from_number: sentMsg.from,
        to_number: sentMsg.to,
        message_body: message,
        message_type: 'chat',
        timestamp: sentMsg.timestamp,
        direction: 'outgoing'
      };

      messageModel.create(messageData);
      statsModel.increment(deviceId, 'messages_sent');

      logger.info(`Message sent from device ${deviceId} to ${to}`);
      return sentMsg;
    } catch (error) {
      logger.error(`Error sending message: ${error.message}`);
      throw error;
    }
  }

  async getDevice(deviceId) {
    return this.clients.get(deviceId);
  }

  async restartDevice(deviceId) {
    await this.disconnectDevice(deviceId);
    const device = deviceModel.findById(deviceId);
    if (device) {
      await this.createDevice(deviceId, device.name);
    }
  }

  async disconnectDevice(deviceId) {
    const client = this.clients.get(deviceId);
    if (client) {
      try {
        await client.destroy();
        this.clients.delete(deviceId);
        deviceModel.update(deviceId, { status: 'disconnected' });
        logger.info(`Device ${deviceId} disconnected`);
      } catch (error) {
        logger.error(`Error disconnecting device ${deviceId}: ${error.message}`);
      }
    }
  }

  async disconnectAll() {
    const promises = [];
    for (const [deviceId] of this.clients) {
      promises.push(this.disconnectDevice(deviceId));
    }
    await Promise.all(promises);
  }

  async initializeDevices() {
    const devices = deviceModel.findAll();
    for (const device of devices) {
      try {
        logger.info(`Initializing device ${device.id}...`);
        await this.createDevice(device.id, device.name);
      } catch (error) {
        logger.error(`Failed to initialize device ${device.id}: ${error.message}`);
      }
    }
  }

  getStatus(deviceId) {
    const device = deviceModel.findById(deviceId);
    const client = this.clients.get(deviceId);
    
    return {
      ...device,
      is_active: client ? true : false
    };
  }

  async getChats(deviceId) {
    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error('Device not found');
    }

    try {
      const chats = await client.getChats();
      return chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name,
        is_group: chat.isGroup,
        unread_count: chat.unreadCount,
        timestamp: chat.timestamp
      }));
    } catch (error) {
      logger.error(`Error getting chats: ${error.message}`);
      throw error;
    }
  }
}