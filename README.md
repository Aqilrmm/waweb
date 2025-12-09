# WhatsApp Multi-Device Manager

Aplikasi WhatsApp Multi-Device dengan panel admin untuk mengelola multiple devices dan integrasi API webhook.

## 🚀 Fitur

- ✅ **Multi-Device Support** - Kelola banyak device WhatsApp dalam satu aplikasi
- 🎛️ **Admin Panel** - Dashboard web untuk monitoring dan konfigurasi
- 🔗 **Webhook Integration** - Forward pesan ke API eksternal dengan konfigurasi per-device
- 📊 **Real-time Monitoring** - Status device, statistik pesan, dan logs
- 🔐 **Authentication** - Login admin dengan bcrypt
- 💾 **Session Management** - Auto-save session untuk reconnect otomatis
- 📱 **QR Code Management** - Generate dan scan QR code dari panel

## 📋 Requirements

- Node.js >= 18.0.0
- npm atau yarn
- Database SQLite (included)

## 🛠️ Instalasi

```bash
# Clone repository
git clone <repo-url>
cd whatsapp-multidevice

# Install dependencies
npm install

# Setup environment
cp .env.example .env

# Edit .env dan atur kredensial admin
nano .env

# Jalankan aplikasi
npm start
```

## ⚙️ Konfigurasi

Edit file `.env`:

```env
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
SESSION_SECRET=your-secret-key-here
```

## 📖 Penggunaan

1. Akses admin panel: `http://localhost:3000`
2. Login dengan kredensial admin
3. Tambah device baru dari dashboard
4. Scan QR code dengan WhatsApp
5. Konfigurasi webhook integration untuk setiap device
6. Monitor pesan dan status device

## 🔌 Webhook Integration

Setiap device dapat dikonfigurasi untuk forward pesan ke API eksternal dengan **Dynamic Body Builder**:

### Dynamic Body Template

Gunakan variabel dinamis untuk membangun request body sesuai kebutuhan:

```json
{
  "session_id": "{{device_id}}",
  "message": "{{message}}",
  "user_info": {
    "name": "{{from_name}}",
    "phone": "{{from}}",
    "email": "user@example.com"
  },
  "metadata": {
    "timestamp": {{timestamp}},
    "is_group": {{is_group}},
    "message_type": "{{message_type}}"
  }
}
```

### Available Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{device_id}}` | Device ID | device-xxx-xxx |
| `{{device_name}}` | Device Name | Customer Service 1 |
| `{{device_phone}}` | Device Phone | 628123456789 |
| `{{message_id}}` | WhatsApp Message ID | 3EB0xxx |
| `{{from}}` | Sender Number | 628987654321@c.us |
| `{{to}}` | Recipient Number | 628123456789@c.us |
| `{{from_name}}` | Sender Name | John Doe |
| `{{message}}` | Message Body | Hello World |
| `{{message_type}}` | Message Type | chat, image, video |
| `{{timestamp}}` | Unix Timestamp | 1701234567 |
| `{{is_group}}` | Is Group Chat | true/false |
| `{{chat_name}}` | Chat Name | Support Group |
| `{{has_media}}` | Has Media | true/false |
| `{{is_forwarded}}` | Is Forwarded | true/false |

### Response Mapping

Konfigurasi path untuk mengekstrak reply message dari webhook response:

**Webhook Response Path Examples:**
- `reply` → untuk response: `{"reply": "Thank you"}`
- `data.message` → untuk response: `{"data": {"message": "Thank you"}}`
- `result.text` → untuk response: `{"result": {"text": "Thank you"}}`

**Default:** Jika tidak diisi, akan mencoba: `reply`, `message`, `response`

### Example Workflow

1. **Incoming WhatsApp Message:**
   ```
   From: 628987654321
   Message: "Hello, I need help"
   ```

2. **Your Body Template:**
   ```json
   {
     "session": "{{device_id}}",
     "text": "{{message}}",
     "user": {
       "phone": "{{from}}",
       "name": "{{from_name}}"
     }
   }
   ```

3. **Request Sent to Webhook:**
   ```json
   {
     "session": "device-abc-123",
     "text": "Hello, I need help",
     "user": {
       "phone": "628987654321@c.us",
       "name": "John Doe"
     }
   }
   ```

4. **Your API Response:**
   ```json
   {
     "status": "success",
     "data": {
       "reply": "Hi John! How can I help you today?"
     }
   }
   ```

5. **Auto-Reply Sent (if enabled):**
   ```
   To: 628987654321
   Message: "Hi John! How can I help you today!"
   ```

## 📁 Struktur Project

```
whatsapp-multidevice/
├── src/
│   ├── controllers/     # Business logic
│   ├── models/          # Database models
│   ├── routes/          # API endpoints
│   ├── services/        # WhatsApp service layer
│   ├── middleware/      # Auth & validation
│   └── utils/           # Helper functions
├── public/              # Static files (admin panel)
├── sessions/            # WhatsApp sessions
├── database/            # SQLite database
└── logs/               # Application logs
```

## 🔧 API Endpoints

### Admin Panel
- `GET /` - Admin dashboard
- `POST /api/auth/login` - Login
- `GET /api/auth/logout` - Logout

### Device Management
- `GET /api/devices` - List semua devices
- `POST /api/devices` - Tambah device baru
- `GET /api/devices/:id` - Detail device
- `PUT /api/devices/:id` - Update device config
- `DELETE /api/devices/:id` - Hapus device
- `GET /api/devices/:id/qr` - Get QR code
- `POST /api/devices/:id/restart` - Restart device

### Messaging
- `POST /api/devices/:id/send` - Kirim pesan
- `GET /api/devices/:id/chats` - List chats
- `GET /api/devices/:id/messages` - List messages

### Statistics
- `GET /api/stats` - Global statistics
- `GET /api/devices/:id/stats` - Device statistics

## 🔒 Security

- Password di-hash dengan bcrypt
- Session-based authentication
- Input validation & sanitization
- Rate limiting
- CORS protection

## 📝 Development

```bash
# Development mode dengan auto-reload
npm run dev

# Production mode
npm start

# View logs
npm run logs
```

## ⚠️ Catatan Penting

- WhatsApp tidak mengizinkan bot/unofficial clients. Gunakan dengan risiko sendiri.
- Backup session secara berkala
- Jangan share session files
- Monitor logs untuk detect ban patterns

## 🤝 Contributing

Pull requests welcome! Untuk perubahan besar, buka issue terlebih dahulu.

## 📄 License

Apache-2.0

## 🆘 Support

Jika ada masalah, buat issue di repository atau hubungi maintainer.