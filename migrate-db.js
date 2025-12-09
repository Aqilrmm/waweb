import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './database/app.db';
const db = new Database(DB_PATH);

console.log('Running database migration...');

try {
  // Add new columns if they don't exist
  const columns = db.pragma('table_info(devices)');
  const columnNames = columns.map(col => col.name);

  if (!columnNames.includes('webhook_body_template')) {
    console.log('Adding webhook_body_template column...');
    db.exec('ALTER TABLE devices ADD COLUMN webhook_body_template TEXT');
  }

  if (!columnNames.includes('webhook_response_path')) {
    console.log('Adding webhook_response_path column...');
    db.exec('ALTER TABLE devices ADD COLUMN webhook_response_path TEXT');
  }

  console.log('Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
}

db.close();