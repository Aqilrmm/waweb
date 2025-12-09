import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { initDatabase } from './models/database.js';
import { logger } from './utils/logger.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import statsRoutes from './routes/stats.js';
import { WhatsAppManager } from './services/whatsapp-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure required directories exist
const dirs = ['./sessions', './database', './logs', './public'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize database
initDatabase();

// Initialize WhatsApp Manager
export const waManager = new WhatsAppManager();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware - using file system store (no Redis needed)
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/stats', statsRoutes);

// Static files - serve after API routes
app.use(express.static(path.join(__dirname, '../public')));

// Serve admin panel for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    next();
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Admin panel: http://localhost:${PORT}`);
  
  // Initialize existing devices
  waManager.initializeDevices();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  await waManager.disconnectAll();
  process.exit(0);
});