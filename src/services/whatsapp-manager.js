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
    this.initializationAttempts = new Map();
    this.maxRetries = 3;
  }

  async createDevice(deviceId, name) {
    if (this.clients.has(deviceId)) {
      throw new Error('Device already exists');
    }

    const attempts = this.initializationAttempts.get(deviceId) || 0;
    if (attempts >= this.maxRetries) {
      throw new Error('Maximum initialization attempts reached');
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: deviceId,
        dataPath: process.env.SESSIONS_PATH || './sessions'
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--disable-breakpad',
          '--mute-audio',
          '--disable-default-apps',
          '--disable-web-security'
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      }
    });

    // Setup event handlers
    this.setupEventHandlers(client, deviceId);

    this.clients.set(deviceId, client);

    // Initialize client with retry logic
    try {
      deviceModel.update(deviceId, { status: 'initializing' });
      logger.info(`[${deviceId}] Starting initialization (attempt ${attempts + 1}/${this.maxRetries})`);
      
      await this.initializeWithTimeout(client, deviceId, 60000); // 60 second timeout
      
      this.initializationAttempts.delete(deviceId);
      logger.info(`[${deviceId}] Initialization successful`);
    } catch (error) {
      logger.error(`[${deviceId}] Initialization error: ${error.message}`);
      this.clients.delete(deviceId);
      this.initializationAttempts.set(deviceId, attempts + 1);
      
      // Cleanup client
      try {
        await client.destroy();
      } catch (destroyError) {
        logger.error(`[${deviceId}] Error destroying client: ${destroyError.message}`);
      }
      
      throw error;
    }

    return client;
  }

  async initializeWithTimeout(client, deviceId, timeout) {
    return Promise.race([
      client.initialize(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Initialization timeout')), timeout)
      )
    ]);
  }

  setupEventHandlers(client, deviceId) {
    // QR Code handler
    client.on('qr', async (qr) => {
      try {
        const qrCodeData = await qrcode.toDataURL(qr);
        deviceModel.update(deviceId, { qr_code: qrCodeData, status: 'qr_ready' });
        logger.info(`[${deviceId}] QR Code generated`);
        logModel.create(deviceId, 'info', 'QR Code generated - Ready to scan');
      } catch (error) {
        logger.error(`[${deviceId}] Error generating QR code: ${error.message}`);
        logModel.create(deviceId, 'error', `QR generation failed: ${error.message}`);
      }
    });

    // Ready handler
    client.on('ready', () => {
      try {
        const phoneNumber = client.info.wid.user;
        deviceModel.update(deviceId, {
          status: 'connected',
          phone_number: phoneNumber,
          qr_code: null
        });
        logger.info(`[${deviceId}] Connected! Phone: ${phoneNumber}`);
        logModel.create(deviceId, 'info', `Connected successfully with number ${phoneNumber}`);
      } catch (error) {
        logger.error(`[${deviceId}] Error in ready handler: ${error.message}`);
      }
    });

    // Authenticated handler
    client.on('authenticated', () => {
      logger.info(`[${deviceId}] Authentication successful`);
      logModel.create(deviceId, 'info', 'Authentication successful');
    });

    // Message handler
    client.on('message', async (msg) => {
      await this.handleIncomingMessage(deviceId, msg);
    });

    // Message create handler (for sent messages)
    client.on('message_create', async (msg) => {
      if (msg.fromMe) {
        logger.info(`[${deviceId}] Outgoing message detected: ${msg.body.substring(0, 30)}...`);
      }
    });

    // Disconnected handler
    client.on('disconnected', (reason) => {
      deviceModel.update(deviceId, { status: 'disconnected', qr_code: null });
      logger.warn(`[${deviceId}] Disconnected: ${reason}`);
      logModel.create(deviceId, 'warn', `Disconnected: ${reason}`);
      
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        logger.info(`[${deviceId}] Attempting auto-reconnect...`);
        this.restartDevice(deviceId).catch(err => {
          logger.error(`[${deviceId}] Auto-reconnect failed: ${err.message}`);
        });
      }, 5000);
    });

    // Auth failure handler
    client.on('auth_failure', (msg) => {
      deviceModel.update(deviceId, { status: 'auth_failure', qr_code: null });
      logger.error(`[${deviceId}] Authentication failure: ${msg}`);
      logModel.create(deviceId, 'error', `Authentication failed: ${msg}`);
    });

    // Loading screen handler
    client.on('loading_screen', (percent, message) => {
      logger.info(`[${deviceId}] Loading: ${percent}% - ${message}`);
    });

    // Change state handler
    client.on('change_state', state => {
      logger.info(`[${deviceId}] State changed to: ${state}`);
    });
  }

  async handleIncomingMessage(deviceId, msg) {
    try {
      // Skip status messages
      if (msg.isStatus) {
        return;
      }

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

      const preview = msg.body ? msg.body.substring(0, 50) : '[Media]';
      logger.info(`[${deviceId}] ← ${msg.from}: ${preview}${msg.body?.length > 50 ? '...' : ''}`);
      logModel.create(deviceId, 'info', `Received from ${msg.from}: ${msg.type}`);

      // Get device config
      const device = deviceModel.findById(deviceId);
      
      if (device && device.webhook_enabled && device.webhook_url) {
        logger.info(`[${deviceId}] Forwarding to webhook: ${device.webhook_url}`);
        await this.forwardToWebhook(deviceId, device, msg, messageData);
      }
    } catch (error) {
      logger.error(`[${deviceId}] Error handling message: ${error.message}`);
      logModel.create(deviceId, 'error', `Message handling error: ${error.message}`);
    }
  }

  async forwardToWebhook(deviceId, device, msg, messageData) {
    try {
      let webhookPayload;
      
      if (device.webhook_body_template) {
        try {
          logger.info(`[${deviceId}] Building custom webhook payload`);
          webhookPayload = this.buildDynamicPayload(device.webhook_body_template, {
            device_id: deviceId,
            device_name: device.name,
            device_phone: device.phone_number || '',
            message_id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            from_name: msg._data.notifyName || msg.from.split('@')[0],
            message: msg.body || '',
            message_type: msg.type,
            timestamp: msg.timestamp,
            is_group: msg.from.includes('@g.us'),
            chat_name: msg._data.notifyName || msg.from.split('@')[0],
            has_media: msg.hasMedia || false,
            is_forwarded: msg.isForwarded || false,
            is_status: msg.isStatus || false,
            broadcast: msg.broadcast || false
          });
          logModel.create(deviceId, 'info', 'Custom payload built');
        } catch (error) {
          logger.error(`[${deviceId}] Payload build error: ${error.message}`);
          logModel.create(deviceId, 'error', `Payload error: ${error.message}`);
          webhookPayload = this.getDefaultPayload(deviceId, device, msg);
          logModel.create(deviceId, 'warn', 'Using default payload');
        }
      } else {
        webhookPayload = this.getDefaultPayload(deviceId, device, msg);
      }

      logger.info(`[${deviceId}] → Webhook: ${device.webhook_url}`);
      logModel.create(deviceId, 'info', 'Calling webhook...');

      const response = await axios.post(device.webhook_url, webhookPayload, {
        timeout: 10000,
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Manager/1.0'
        },
        validateStatus: (status) => status < 600
      });

      statsModel.increment(deviceId, 'webhook_calls');
      
      if (response.status >= 200 && response.status < 300) {
        logger.info(`[${deviceId}] ✓ Webhook success: ${response.status}`);
        logModel.create(deviceId, 'info', `Webhook success: ${response.status}`);
        
        // Handle auto-reply
        if (device.webhook_response_enabled && response.data) {
          await this.handleWebhookResponse(deviceId, device, msg, response.data);
        }
      } else {
        logger.warn(`[${deviceId}] ⚠ Webhook status ${response.status}`);
        logModel.create(deviceId, 'warn', `Webhook returned ${response.status}`);
      }
    } catch (error) {
      const errorMsg = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.code === 'ECONNREFUSED'
        ? 'Connection refused - webhook server unreachable'
        : error.message;
      
      logger.error(`[${deviceId}] ✗ Webhook failed: ${errorMsg}`);
      logModel.create(deviceId, 'error', `Webhook failed: ${errorMsg}`);
    }
  }

  async handleWebhookResponse(deviceId, device, msg, responseData) {
    try {
      const replyMessage = this.extractResponseMessage(responseData, device.webhook_response_path);
      
      if (replyMessage && replyMessage.trim()) {
        await this.sendMessage(deviceId, msg.from, replyMessage);
        logger.info(`[${deviceId}] ✓ Auto-reply sent: "${replyMessage.substring(0, 30)}..."`);
        logModel.create(deviceId, 'info', `Auto-reply sent to ${msg.from}`);
      } else {
        logger.warn(`[${deviceId}] ⚠ No reply message in webhook response`);
        logModel.create(deviceId, 'warn', 'No reply message found in response');
      }
    } catch (error) {
      logger.error(`[${deviceId}] Auto-reply error: ${error.message}`);
      logModel.create(deviceId, 'error', `Auto-reply failed: ${error.message}`);
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
      } else {
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
      message: msg.body || '',
      message_type: msg.type,
      timestamp: msg.timestamp,
      message_id: msg.id._serialized,
      from_name: msg._data.notifyName || msg.from.split('@')[0]
    };
  }

  extractResponseMessage(responseData, responsePath) {
    if (!responsePath || !responsePath.trim()) {
      // Auto-detect common response paths
      return responseData.reply || responseData.message || responseData.response || responseData.text || null;
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

      logger.info(`[${deviceId}] → Message sent to ${to}`);
      return sentMsg;
    } catch (error) {
      logger.error(`[${deviceId}] Send error: ${error.message}`);
      throw error;
    }
  }

  async getDevice(deviceId) {
    return this.clients.get(deviceId);
  }

  async restartDevice(deviceId) {
    logger.info(`[${deviceId}] Restarting device...`);
    logModel.create(deviceId, 'info', 'Device restart initiated');
    
    await this.disconnectDevice(deviceId);
    
    // Wait a bit before recreating
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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
        deviceModel.update(deviceId, { status: 'disconnected', qr_code: null });
        logger.info(`[${deviceId}] Device disconnected and cleaned up`);
        logModel.create(deviceId, 'info', 'Device disconnected');
      } catch (error) {
        logger.error(`[${deviceId}] Disconnect error: ${error.message}`);
      }
    }
  }

  async disconnectAll() {
    logger.info('Disconnecting all devices...');
    const promises = [];
    for (const [deviceId] of this.clients) {
      promises.push(this.disconnectDevice(deviceId));
    }
    await Promise.all(promises);
    logger.info('All devices disconnected');
  }

  async initializeDevices() {
    const devices = deviceModel.findAll();
    logger.info(`Found ${devices.length} devices to initialize`);
    
    for (const device of devices) {
      try {
        logger.info(`Initializing device: ${device.name} (${device.id})`);
        await this.createDevice(device.id, device.name);
        // Add delay between initializations to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        logger.error(`Failed to initialize ${device.id}: ${error.message}`);
        logModel.create(device.id, 'error', `Initialization failed: ${error.message}`);
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
      logger.error(`[${deviceId}] Error getting chats: ${error.message}`);
      throw error;
    }
  }
}