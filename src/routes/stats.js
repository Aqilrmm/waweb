import express from 'express';
import { isAuthenticated } from './auth.js';
import { statsModel, logModel, deviceModel } from '../models/database.js';

const router = express.Router();
router.use(isAuthenticated);

// Global statistics
router.get('/', async (req, res) => {
  try {
    const stats = statsModel.getGlobal();
    const devices = deviceModel.findAll();
    
    const connectedDevices = devices.filter(d => d.status === 'connected').length;
    
    res.json({
      success: true,
      data: {
        ...stats,
        connected_devices: connectedDevices
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Recent logs
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = logModel.findRecent(limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;