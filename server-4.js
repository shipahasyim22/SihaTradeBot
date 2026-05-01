const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const NexusBot = require('./bot');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── USER DATABASE ──────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  try { if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); } catch(e) {}
  return {};
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function hashPw(pw) { return crypto.createHash('sha256').update(pw+'siha_salt_2025').digest('hex'); }

// ── NODEMAILER SETUP ──────────────────────────────────────
function createMailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

// OTP store: email -> { code, expiresAt, verified }
const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTP(email, otp) {
  const mailer = createMailer();
  if (!mailer) throw new Error('Email belum dikonfigurasi di server.');
  const from = process.env.GMAIL_USER;
  await mailer.sendMail({
    from: `SihaTradeBot <${from}>`,
    to: email,
    subject: 'Kode Verifikasi SihaTradeBot',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#0b0e17;color:#e2e8f0;border-radius:12px">
        <h2 style="color:#00c48c;margin:0 0 16px">SihaTradeBot 🤖</h2>
        <p style="margin:0 0 20px;color:#94a3b8">Gunakan kode OTP berikut untuk verifikasi akun kamu:</p>
        <div style="background:#1a1f2e;border-radius:8px;padding:20px;text-align:center;margin-bottom:20px">
          <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#00c48c">${otp}</span>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0">Kode berlaku 10 menit. Jangan share ke siapapun.</p>
      </div>
    `
  });
}

const sessions = new Map();
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function getUser(req) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return null;
  const email = sessions.get(token);
  if (!email) return null;
  return loadUsers()[email] || null;
}

// ── AUTH ───────────────────────────────────────────────────
// Step 1: Kirim OTP ke email
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.json({ ok:false, msg:'Email tidak valid.' });
  const users = loadUsers();
  if (users[email]) return res.json({ ok:false, msg:'Email sudah terdaftar.' });
  const otp = generateOTP();
  otpStore.set(email, { code:otp, expiresAt:Date.now() + 10*60*1000, verified:false });
  try {
    await sendOTP(email, otp);
    res.json({ ok:true, msg:'Kode OTP dikirim ke email.' });
  } catch(e) {
    res.json({ ok:false, msg:'Gagal kirim email: ' + e.message });
  }
});

// Step 2: Verifikasi OTP + buat akun
app.post('/api/auth/register', (req, res) => {
  const { email, password, otp } = req.body;
  if (!email || !password || !otp) return res.json({ ok:false, msg:'Semua field wajib diisi.' });
  if (password.length < 6) return res.json({ ok:false, msg:'Password min 6 karakter.' });
  const entry = otpStore.get(email);
  if (!entry) return res.json({ ok:false, msg:'Kirim OTP dulu.' });
  if (Date.now() > entry.expiresAt) { otpStore.delete(email); return res.json({ ok:false, msg:'OTP expired. Kirim ulang.' }); }
  if (entry.code !== otp.toString().trim()) return res.json({ ok:false, msg:'Kode OTP salah.' });
  otpStore.delete(email);
  const users = loadUsers();
  if (users[email]) return res.json({ ok:false, msg:'Email sudah terdaftar.' });
  users[email] = { email, password:hashPw(password), createdAt:Date.now(), apiKey:'', secretKey:'', passphrase:'', geminiKey:'' };
  saveUsers(users);
  const token = makeToken();
  sessions.set(token, email);
  res.json({ ok:true, token, email });
});

// Forgot password — kirim OTP reset
app.post('/api/auth/forgot-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ ok:false, msg:'Email wajib.' });
  const users = loadUsers();
  if (!users[email]) return res.json({ ok:false, msg:'Email tidak ditemukan.' });
  const otp = generateOTP();
  otpStore.set('reset:'+email, { code:otp, expiresAt:Date.now() + 10*60*1000 });
  try {
    await sendOTP(email, otp);
    res.json({ ok:true, msg:'Kode OTP reset dikirim ke email.' });
  } catch(e) {
    res.json({ ok:false, msg:'Gagal kirim email: ' + e.message });
  }
});

// Reset password dengan OTP
app.post('/api/auth/reset-password', (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.json({ ok:false, msg:'Semua field wajib.' });
  if (newPassword.length < 6) return res.json({ ok:false, msg:'Password min 6 karakter.' });
  const entry = otpStore.get('reset:'+email);
  if (!entry) return res.json({ ok:false, msg:'Kirim OTP reset dulu.' });
  if (Date.now() > entry.expiresAt) { otpStore.delete('reset:'+email); return res.json({ ok:false, msg:'OTP expired.' }); }
  if (entry.code !== otp.toString().trim()) return res.json({ ok:false, msg:'Kode OTP salah.' });
  otpStore.delete('reset:'+email);
  const users = loadUsers();
  if (!users[email]) return res.json({ ok:false, msg:'User tidak ditemukan.' });
  users[email].password = hashPw(newPassword);
  saveUsers(users);
  res.json({ ok:true, msg:'Password berhasil direset.' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok:false, msg:'Email & password wajib.' });
  const users = loadUsers();
  const user = users[email];
  if (!user) return res.json({ ok:false, msg:'Email tidak ditemukan.' });
  if (user.password !== hashPw(password)) return res.json({ ok:false, msg:'Password salah.' });
  const token = makeToken();
  sessions.set(token, email);
  res.json({ ok:true, token, email, hasApiKey:!!user.apiKey, hasGemini:!!user.geminiKey });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ ok:true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ ok:false });
  res.json({ ok:true, email:user.email, hasApiKey:!!user.apiKey, hasGemini:!!user.geminiKey });
});

app.post('/api/auth/save-keys', (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ ok:false, msg:'Belum login.' });
  const users = loadUsers();
  const { apiKey, secretKey, passphrase, geminiKey } = req.body;
  if (apiKey !== undefined) users[user.email].apiKey = apiKey;
  if (secretKey !== undefined) users[user.email].secretKey = secretKey;
  if (passphrase !== undefined) users[user.email].passphrase = passphrase;
  if (geminiKey !== undefined) users[user.email].geminiKey = geminiKey;
  saveUsers(users);
  res.json({ ok:true, msg:'API keys tersimpan.' });
});

app.get('/api/auth/keys', (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ ok:false });
  res.json({ ok:true, hasApiKey:!!user.apiKey, hasSecret:!!user.secretKey, hasPassphrase:!!user.passphrase, hasGemini:!!user.geminiKey });
});

// ── BITGET WS → SSE ────────────────────────────────────────
const sseClients = new Map();
const bitgetWsMap = new Map();
const TF_CHANNEL = { '1m':'candle1m','3m':'candle3m','5m':'candle5m','15m':'candle15m','30m':'candle30m','1H':'candle1H','4H':'candle4H','1D':'candle1D' };

function broadcastSSE(key, payload) {
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch(e) {} });
}

function startBitgetWs(symbol, tf) {
  const key = `${symbol}:${tf}`;
  if (bitgetWsMap.has(key)) return;
  const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
  const entry = { ws, pingTimer: null };
  bitgetWsMap.set(key, entry);

  ws.on('open', () => {
    const channel = TF_CHANNEL[tf] || `candle${tf}`;
    ws.send(JSON.stringify({ op:'subscribe', args:[
      { instType:'USDT-FUTURES', channel, instId:symbol },
      { instType:'USDT-FUTURES', channel:'ticker', instId:symbol }
    ]}));
    entry.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);
  });

  ws.on('message', (data) => {
    const str = data.toString();
    if (str === 'pong') return;
    try {
      const msg = JSON.parse(str);
      if (!msg.data || !Array.isArray(msg.data)) return;
      if (msg.arg && msg.arg.channel === 'ticker') {
        const t = msg.data[0] || {};
        broadcastSSE(key, { type:'ticker', price:parseFloat(t.lastPr||0), change24h:parseFloat(t.change24h||0), high24h:parseFloat(t.high24h||0), low24h:parseFloat(t.low24h||0), volume24h:parseFloat(t.baseVolume||0), quoteVolume24h:parseFloat(t.quoteVolume||0) });
        return;
      }
      const candles = msg.data.map(c => ({ time:Math.floor(parseInt(c[0])/1000), open:parseFloat(c[1]), high:parseFloat(c[2]), low:parseFloat(c[3]), close:parseFloat(c[4]), volume:parseFloat(c[5]||0), confirm:c[8]==='1' }));
      broadcastSSE(key, { type:'candle', candles });
    } catch(e) {}
  });

  ws.on('close', () => {
    if (entry.pingTimer) clearInterval(entry.pingTimer);
    bitgetWsMap.delete(key);
    setTimeout(() => { const c = sseClients.get(key); if (c && c.size > 0) startBitgetWs(symbol, tf); }, 3000);
  });

  ws.on('error', () => { try { ws.terminate(); } catch(e) {} });
}

app.get('/api/candle-stream', (req, res) => {
  const { symbol='BTCUSDT', tf='5m' } = req.query;
  const key = `${symbol}:${tf}`;
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  startBitgetWs(symbol, tf);
  const hbTimer = setInterval(() => { try { res.write(': hb\n\n'); } catch(e) {} }, 20000);
  req.on('close', () => {
    clearInterval(hbTimer);
    const clients = sseClients.get(key);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        const entry = bitgetWsMap.get(key);
        if (entry) { if (entry.pingTimer) clearInterval(entry.pingTimer); try { entry.ws.terminate(); } catch(e) {} }
        bitgetWsMap.delete(key); sseClients.delete(key);
      }
    }
  });
});

// ── BOT per user ───────────────────────────────────────────
const bots = new Map();
function getBot(req) { const u = getUser(req); if (!u) return null; return bots.get(u.email)||null; }

app.get('/api/status', (req, res) => {
  const bot = getBot(req);
  if (!bot) return res.json({ running:false, logs:[], trades:[], lastSignal:null, balance:0, totalPnl:0, winRate:0, totalTrades:0 });
  res.json(bot.getStatus());
});

app.get('/api/defaults', (req, res) => {
  const u = getUser(req);
  res.json({ hasBitgetKey:!!(u&&u.apiKey), hasSecret:!!(u&&u.secretKey), hasPassphrase:!!(u&&u.passphrase), hasGemini:!!(u&&u.geminiKey) });
});

app.post('/api/start', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ ok:false, msg:'Belum login.' });
  const { symbol, symbols, scanAll, leverage, margin, timeframe, intervalSec, autoTrade, minConfidence, cooldownSec, autoReversal, reversalConfidence } = req.body;
  if (!user.apiKey||!user.secretKey||!user.passphrase||!user.geminiKey) return res.json({ ok:false, msg:'API keys belum lengkap. Set di menu API.' });
  const prev = bots.get(user.email);
  if (prev && prev.running) prev.stop();
  const bot = new NexusBot({ apiKey:user.apiKey, secretKey:user.secretKey, passphrase:user.passphrase, geminiKey:user.geminiKey, symbol:symbol||'BTCUSDT', symbols:Array.isArray(symbols)?symbols:(typeof symbols==='string'?symbols.split(',').map(s=>s.trim()).filter(Boolean):[]), scanAll:scanAll===true, leverage:parseInt(leverage)||10, margin:parseFloat(margin)||10, timeframe:timeframe||'5m', intervalSec:parseInt(intervalSec)||30, cooldownSec:parseInt(cooldownSec)||60, autoTrade:autoTrade===true, minConfidence:parseInt(minConfidence)||65, profitLockPct:parseFloat(req.body.profitLockPct)||30, lossLimitPct:parseFloat(req.body.lossLimitPct)||50, aiExitCheck:req.body.aiExitCheck!==false, autoReversal:autoReversal===true, reversalConfidence:parseInt(reversalConfidence)||70 });
  bots.set(user.email, bot);
  try { await bot.start(); res.json({ ok:true, msg:'Bot started!' }); } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/stop', (req, res) => { const bot=getBot(req); if(bot) bot.stop(); res.json({ok:true,msg:'Bot stopped.'}); });
app.post('/api/config', (req, res) => { const bot=getBot(req); if(!bot) return res.json({ok:false,msg:'Bot belum dibuat.'}); Object.assign(bot.config,req.body); res.json({ok:true}); });

app.post('/api/close', async (req, res) => {
  const bot = getBot(req);
  if (!bot) return res.json({ok:false,msg:'Bot belum jalan.'});
  const {symbol} = req.body;
  if (!symbol) return res.json({ok:false,msg:'Symbol wajib.'});
  try { await bot.fetchOpenPositions(); const pos=bot.openPositions.find(p=>p.symbol===symbol); if(!pos) return res.json({ok:false,msg:`Tidak ada posisi ${symbol}.`}); await bot.closePositionNow(pos,'MANUAL'); res.json({ok:true,msg:`Posisi ${symbol} ditutup.`}); } catch(e) { res.json({ok:false,msg:e.message}); }
});

app.post('/api/close-all', async (req, res) => {
  const bot = getBot(req);
  if (!bot) return res.json({ok:false,msg:'Bot belum jalan.'});
  try { await bot.fetchOpenPositions(); if(bot.openPositions.length===0) return res.json({ok:false,msg:'Tidak ada posisi.'}); let closed=0; for(const pos of [...bot.openPositions]) { try { await bot.closePositionNow(pos,'MANUAL_ALL'); closed++; } catch(e) {} } res.json({ok:true,msg:`${closed} posisi ditutup.`}); } catch(e) { res.json({ok:false,msg:e.message}); }
});

app.post('/api/confirm-reversal', async (req,res) => { const bot=getBot(req); if(!bot) return res.json({ok:false,msg:'Bot belum jalan.'}); res.json(await bot.confirmReversal()); });
app.post('/api/reject-reversal', (req,res) => { const bot=getBot(req); if(!bot) return res.json({ok:false,msg:'Bot belum jalan.'}); res.json(bot.rejectReversal()); });

// ── CANDLES — public API Bitget, tidak butuh auth ──────────
function httpsGet(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, { headers:{'locale':'en-US','User-Agent':'SihaTradeBot/1.0'} }, (r) => {
      let d = '';
      r.on('data', chunk => d += chunk);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

app.get('/api/candles', async (req, res) => {
  const { symbol='BTCUSDT', tf='5m', limit=1000, endTime } = req.query;
  try {
    let url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${tf}&limit=${Math.min(parseInt(limit)||1000,1000)}`;
    if (endTime) url += `&endTime=${endTime}`;
    const data = await httpsGet(url);
    if (data.code && data.code !== '00000') return res.json({ ok:false, msg:data.msg });
    const candles = (data.data||[]).map(c => ({ time:Math.floor(parseInt(c[0])/1000), open:parseFloat(c[1]), high:parseFloat(c[2]), low:parseFloat(c[3]), close:parseFloat(c[4]), volume:parseFloat(c[5]||0) })).sort((a,b)=>a.time-b.time);
    res.json({ ok:true, candles });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol='BTCUSDT' } = req.query;
  try {
    const data = await httpsGet(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`);
    if (data.code && data.code !== '00000') return res.json({ ok:false });
    const t = data.data?.[0] || {};
    res.json({ ok:true, price:parseFloat(t.lastPr||0), change24h:parseFloat(t.change24h||0), high24h:parseFloat(t.high24h||0), low24h:parseFloat(t.low24h||0), volume24h:parseFloat(t.baseVolume||0), quoteVolume24h:parseFloat(t.quoteVolume||0) });
  } catch(e) { res.json({ ok:false }); }
});

let contractsCache=null, contractsCacheAt=0;
app.get('/api/contracts', async (req, res) => {
  try {
    const now = Date.now();
    if (contractsCache && (now-contractsCacheAt)<600000) return res.json({ ok:true, contracts:contractsCache });
    const data = await httpsGet(`https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES`);
    if (data.code && data.code !== '00000') return res.json({ ok:false, msg:data.msg });
    const map = {};
    for (const c of (data.data||[])) map[c.symbol] = { maxLever:parseInt(c.maxLever||0)||50, minLever:parseInt(c.minLever||1)||1, pricePlace:parseInt(c.pricePlace||2)||2, priceEndStep:parseInt(c.priceEndStep||1)||1, volumePlace:parseInt(c.volumePlace||0)||0, minTradeNum:parseFloat(c.minTradeNum||0)||0, minTradeUSDT:parseFloat(c.minTradeUSDT||5)||5 };
    contractsCache=map; contractsCacheAt=now;
    res.json({ ok:true, contracts:map });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.post('/api/ask-ai', async (req, res) => {
  const user = getUser(req);
  const { question, symbol } = req.body;
  if (!question) return res.json({ ok:false, msg:'Pertanyaan kosong.' });
  if (!user||!user.geminiKey) return res.json({ ok:false, msg:'GEMINI_API_KEY belum di-set.' });
  try {
    let context = '';
    const bot = getBot(req);
    if (bot && symbol) { try { const m=await bot.getMarketData(symbol); context=`\n\nDATA MARKET ${symbol}:\n- Harga: $${m.price}\n- 24h Change: ${m.change24h}%\n- RSI: ${m.rsi}`; } catch(e) {} }
    const answer = await NexusBot.askGeminiQuestion(user.geminiKey, question, context);
    res.json({ ok:true, answer });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

app.get('/ping', (req,res) => res.send('pong'));
app.get('/', (req,res) => {
  const p2=path.join(__dirname,'index.html');
  if (fs.existsSync(p2)) return res.sendFile(p2);
  res.send('SihaTradeBot running.');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`SihaTradeBot running on port ${PORT}`));
