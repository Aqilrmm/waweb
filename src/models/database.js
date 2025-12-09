import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './database/app.db';

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export function initDatabase() {
  // Devices table
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone_number TEXT,
      status TEXT DEFAULT 'disconnected',
      webhook_url TEXT,
      webhook_enabled INTEGER DEFAULT 0,
      webhook_response_enabled INTEGER DEFAULT 0,
      webhook_body_template TEXT,
      webhook_response_path TEXT,
      qr_code TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      message_id TEXT,
      from_number TEXT,
      to_number TEXT,
      message_body TEXT,
      message_type TEXT,
      timestamp INTEGER,
      direction TEXT,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Stats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      messages_sent INTEGER DEFAULT 0,
      messages_received INTEGER DEFAULT 0,
      webhook_calls INTEGER DEFAULT 0,
      last_activity INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  // Logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      level TEXT,
      message TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Create indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stats_device ON stats(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_device ON logs(device_id)');
}

// Device operations
export const deviceModel = {
  create: (id, name) => {
    const stmt = db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)');
    stmt.run(id, name);
    
    // Initialize stats
    const statsStmt = db.prepare('INSERT INTO stats (device_id) VALUES (?)');
    statsStmt.run(id);
    
    return { id, name, status: 'disconnected' };
  },

  findAll: () => {
    return db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
  },

  findById: (id) => {
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  },

  update: (id, data) => {
    const fields = [];
    const values = [];
    
    Object.entries(data).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });
    
    fields.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);
    
    const stmt = db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  },

  delete: (id) => {
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }
};

// Message operations
export const messageModel = {
  create: (data) => {
    const stmt = db.prepare(`
      INSERT INTO messages (id, device_id, message_id, from_number, to_number, 
                           message_body, message_type, timestamp, direction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      data.id,
      data.device_id,
      data.message_id,
      data.from_number,
      data.to_number,
      data.message_body,
      data.message_type,
      data.timestamp,
      data.direction
    );
  },

  findByDevice: (deviceId, limit = 100) => {
    return db.prepare(`
      SELECT * FROM messages 
      WHERE device_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(deviceId, limit);
  }
};

// Stats operations
export const statsModel = {
  get: (deviceId) => {
    return db.prepare('SELECT * FROM stats WHERE device_id = ?').get(deviceId);
  },

  increment: (deviceId, field) => {
    const stmt = db.prepare(`
      UPDATE stats 
      SET ${field} = ${field} + 1, last_activity = ? 
      WHERE device_id = ?
    `);
    stmt.run(Math.floor(Date.now() / 1000), deviceId);
  },

  getGlobal: () => {
    return db.prepare(`
      SELECT 
        COUNT(DISTINCT device_id) as total_devices,
        SUM(messages_sent) as total_sent,
        SUM(messages_received) as total_received,
        SUM(webhook_calls) as total_webhooks
      FROM stats
    `).get();
  }
};

// Log operations
export const logModel = {
  create: (deviceId, level, message) => {
    db.prepare('INSERT INTO logs (device_id, level, message) VALUES (?, ?, ?)')
      .run(deviceId, level, message);
  },

  findRecent: (limit = 100) => {
    return db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit);
  },

  findByDevice: (deviceId, limit = 100) => {
    return db.prepare(`
      SELECT * FROM logs 
      WHERE device_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(deviceId, limit);
  }
};