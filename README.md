# SihaTradeBot 🤖

Auto trading bot untuk **Bitget USDT-Futures** menggunakan **Gemini AI** sebagai konfirmasi sinyal.

## Cara Deploy di Replit

### 1. Upload ke Replit
- Buat project baru di [replit.com](https://replit.com) → pilih **Node.js**
- Upload semua file dari zip ini

### 2. Install Dependencies
Di Replit Shell, jalankan:
```
npm install
```

### 3. Set API Keys di Secrets
Buka tab **Secrets** di Replit, tambahkan:
| Key | Value |
|-----|-------|
| `BITGET_API_KEY` | API Key Bitget kamu |
| `BITGET_SECRET_KEY` | Secret Key Bitget kamu |
| `BITGET_PASSPHRASE` | Passphrase Bitget kamu |
| `GEMINI_API_KEY` | API Key dari Google AI Studio |

### 4. Jalankan
Klik tombol **Run** atau jalankan:
```
node server.js
```

Bot akan berjalan di port 3000 (atau sesuai `PORT` env).

## Struktur File
```
sihatradebot/
├── server.js       → Express server & API endpoints
├── bot.js          → NexusBot engine (trading logic + Gemini AI)
├── public/
│   └── index.html  → UI dashboard (SihaTradeBot)
├── package.json
└── .replit
```

## ⚠️ Peringatan
Trading futures sangat berisiko. Gunakan uang yang siap hilang. Ini bukan financial advice.
