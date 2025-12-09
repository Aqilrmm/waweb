import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// Middleware to check if user is authenticated
export const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ success: false, message: 'Unauthorized' });
};

// Login
router.post('/login',
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { username, password } = req.body;
      
      const adminUsername = process.env.ADMIN_USERNAME || 'admin';
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

      if (username !== adminUsername) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // Check if password is already hashed or plain text
      let isValid = false;
      if (adminPassword.startsWith('$2a$') || adminPassword.startsWith('$2b$')) {
        isValid = await bcrypt.compare(password, adminPassword);
      } else {
        isValid = password === adminPassword;
      }

      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      req.session.userId = username;
      
      // Force save session
      req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err);
          return res.status(500).json({ success: false, message: 'Session save failed' });
        }
        
        res.json({ success: true, message: 'Login successful' });
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logout successful' });
  });
});

// Check auth status
router.get('/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ success: true, authenticated: true, user: req.session.userId });
  } else {
    res.json({ success: true, authenticated: false });
  }
});

export default router;