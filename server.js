const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const NexusBot = require('./bot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Bitget WS → SSE Candle Streaming ─────────────────────
const sseClients = new Map();   // key `SYM:tf` -> Set of SSE res
const bitgetWsMap = new Map();  // key `SYM:tf` -> { ws, pingTimer }

const TF_CHANNEL = {
  '1m':'candle1m','3m':'candle3m','5m':'candle5m',
  '15m':'candle15m','30m':'candle30m',
  '1H':'candle1H','4H':'candle4H','1D':'candle1D'
};

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
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel, instId: symbol }] }));
    entry.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
  });

  ws.on('message', (data) => {
    const str = data.toString();
    if (str === 'pong') return;
    try {
      const msg = JSON.parse(str);
      if (msg.data && Array.isArray(msg.data)) {
        const candles = msg.data.map(c => ({
          time: Math.floor(parseInt(c[0]) / 1000),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5] || 0),
          confirm: c[8] === '1'
        }));
        broadcastSSE(key, { type: 'candle', candles });
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    if (entry.pingTimer) clearInterval(entry.pingTimer);
    bitgetWsMap.delete(key);
    setTimeout(() => {
      const clients = sseClients.get(key);
      if (clients && clients.size > 0) startBitgetWs(symbol, tf);
    }, 3000);
  });

  ws.on('error', () => { try { ws.terminate(); } catch(e) {} });
}

app.get('/api/candle-stream', (req, res) => {
  const { symbol = 'BTCUSDT', tf = '5m' } = req.query;
  const key = `${symbol}:${tf}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  startBitgetWs(symbol, tf);

  const hbTimer = setInterval(() => {
    try { res.write(': hb\n\n'); } catch(e) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(hbTimer);
    const clients = sseClients.get(key);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        const entry = bitgetWsMap.get(key);
        if (entry) {
          if (entry.pingTimer) clearInterval(entry.pingTimer);
          try { entry.ws.terminate(); } catch(e) {}
        }
        bitgetWsMap.delete(key);
        sseClients.delete(key);
      }
    }
  });
});

let bot = null;

app.get('/api/status', (req, res) => {
  if (!bot) return res.json({ running: false, logs: [], trades: [], lastSignal: null, balance: 0, totalPnl: 0, winRate: 0, totalTrades: 0 });
  res.json(bot.getStatus());
});

app.get('/api/defaults', (req, res) => {
  res.json({
    hasBitgetKey: !!process.env.BITGET_API_KEY,
    hasSecret: !!process.env.BITGET_SECRET_KEY,
    hasPassphrase: !!process.env.BITGET_PASSPHRASE,
    hasGemini: !!process.env.GEMINI_API_KEY
  });
});

app.post('/api/start', async (req, res) => {
  const {
    symbol, symbols, scanAll,
    leverage, margin, timeframe, intervalSec, autoTrade, minConfidence, cooldownSec,
    autoReversal, reversalConfidence
  } = req.body;

  const apiKey = req.body.apiKey || process.env.BITGET_API_KEY;
  const secretKey = req.body.secretKey || process.env.BITGET_SECRET_KEY;
  const passphrase = req.body.passphrase || process.env.BITGET_PASSPHRASE;
  const geminiKey = req.body.geminiKey || process.env.GEMINI_API_KEY;

  if (!apiKey || !secretKey || !passphrase || !geminiKey) {
    return res.json({ ok: false, msg: 'API keys belum lengkap. Cek Secrets di Replit.' });
  }

  if (bot && bot.running) bot.stop();

  bot = new NexusBot({
    apiKey, secretKey, passphrase, geminiKey,
    symbol: symbol || 'BTCUSDT',
    symbols: Array.isArray(symbols) ? symbols : (typeof symbols === 'string' ? symbols.split(',').map(s => s.trim()).filter(Boolean) : []),
    scanAll: scanAll === true,
    leverage: parseInt(leverage) || 10,
    margin: parseFloat(margin) || 10,
    timeframe: timeframe || '5m',
    intervalSec: parseInt(intervalSec) || 30,
    cooldownSec: parseInt(cooldownSec) || 60,
    autoTrade: autoTrade === true,
    minConfidence: parseInt(minConfidence) || 65,
    profitLockPct: parseFloat(req.body.profitLockPct) || 30,
    lossLimitPct: parseFloat(req.body.lossLimitPct) || 50,
    aiExitCheck: req.body.aiExitCheck !== false,
    autoReversal: autoReversal === true,
    reversalConfidence: parseInt(reversalConfidence) || 70
  });

  try {
    await bot.start();
    res.json({ ok: true, msg: 'Bot started!' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (bot) bot.stop();
  res.json({ ok: true, msg: 'Bot stopped.' });
});

app.post('/api/config', (req, res) => {
  if (!bot) return res.json({ ok: false, msg: 'Bot belum dibuat.' });
  Object.assign(bot.config, req.body);
  res.json({ ok: true });
});

app.post('/api/close', async (req, res) => {
  if (!bot) return res.json({ ok: false, msg: 'Bot belum jalan.' });
  const { symbol } = req.body;
  if (!symbol) return res.json({ ok: false, msg: 'Symbol wajib.' });
  try {
    await bot.fetchOpenPositions();
    const pos = bot.openPositions.find(p => p.symbol === symbol);
    if (!pos) return res.json({ ok: false, msg: `Tidak ada posisi terbuka di ${symbol}.` });
    await bot.closePositionNow(pos, 'MANUAL');
    res.json({ ok: true, msg: `Posisi ${symbol} ditutup.` });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post('/api/confirm-reversal', async (req, res) => {
  if (!bot) return res.json({ ok: false, msg: 'Bot belum jalan.' });
  const result = await bot.confirmReversal();
  res.json(result);
});

app.post('/api/reject-reversal', (req, res) => {
  if (!bot) return res.json({ ok: false, msg: 'Bot belum jalan.' });
  const result = bot.rejectReversal();
  res.json(result);
});

app.post('/api/close-all', async (req, res) => {
  if (!bot) return res.json({ ok: false, msg: 'Bot belum jalan.' });
  try {
    await bot.fetchOpenPositions();
    if (bot.openPositions.length === 0) return res.json({ ok: false, msg: 'Tidak ada posisi terbuka.' });
    let closed = 0;
    for (const pos of [...bot.openPositions]) {
      try { await bot.closePositionNow(pos, 'MANUAL_ALL'); closed++; } catch (e) {}
    }
    res.json({ ok: true, msg: `${closed} posisi ditutup.` });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get('/api/candles', async (req, res) => {
  const { symbol = 'BTCUSDT', tf = '5m', limit = 1000, startTime, endTime } = req.query;
  try {
    const apiKey = process.env.BITGET_API_KEY;
    const secretKey = process.env.BITGET_SECRET_KEY;
    const passphrase = process.env.BITGET_PASSPHRASE;
    if (!apiKey) return res.json({ ok: false, msg: 'API key belum di-set' });

    let api;
    if (bot && bot.bitget) {
      api = bot.bitget;
    } else {
      const Bot = require('./bot');
      const tmp = new Bot({ apiKey, secretKey, passphrase, geminiKey: process.env.GEMINI_API_KEY || '' });
      api = tmp.bitget;
    }

    const r = await api.getCandles(symbol, tf, Math.min(parseInt(limit) || 1000, 1000), startTime, endTime);
    if (r.code && r.code !== '00000') return res.json({ ok: false, msg: r.msg });
    const candles = (r.data || []).map(c => ({
      time: Math.floor(parseInt(c[0]) / 1000),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5] || 0)
    })).sort((a, b) => a.time - b.time);
    res.json({ ok: true, candles });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get('/api/ticker', async (req, res) => {
  const { symbol = 'BTCUSDT' } = req.query;
  try {
    const apiKey = process.env.BITGET_API_KEY;
    if (!apiKey) return res.json({ ok: false });

    let api;
    if (bot && bot.bitget) {
      api = bot.bitget;
    } else {
      const Bot = require('./bot');
      const tmp = new Bot({ apiKey, secretKey: process.env.BITGET_SECRET_KEY, passphrase: process.env.BITGET_PASSPHRASE, geminiKey: '' });
      api = tmp.bitget;
    }

    const r = await api.getTicker(symbol);
    if (r.code && r.code !== '00000') return res.json({ ok: false });
    const t = r.data?.[0] || {};
    res.json({
      ok: true,
      price: parseFloat(t.lastPr || 0),
      change24h: parseFloat(t.change24h || 0),
      high24h: parseFloat(t.high24h || 0),
      low24h: parseFloat(t.low24h || 0),
      volume: parseFloat(t.baseVolume || 0)
    });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.post('/api/ask-ai', async (req, res) => {
  const { question, symbol } = req.body;
  if (!question) return res.json({ ok: false, msg: 'Pertanyaan kosong.' });
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.json({ ok: false, msg: 'GEMINI_API_KEY belum di-set.' });

  try {
    let context = '';
    if (bot && symbol) {
      try {
        const m = await bot.getMarketData(symbol);
        context = `\n\nDATA MARKET TERKINI ${symbol}:\n- Harga: $${m.price}\n- 24h Change: ${m.change24h}%\n- RSI(14): ${m.rsi}\n- EMA20: $${m.ema20}\n- EMA50: $${m.ema50}\n- Timeframe: ${m.timeframe}`;
      } catch (e) {}
    }

    const NexusBot = require('./bot');
    const answer = await NexusBot.askGeminiQuestion(geminiKey, question, context);
    res.json({ ok: true, answer });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

let contractsCache = null;
let contractsCacheAt = 0;

app.get('/api/contracts', async (req, res) => {
  try {
    const now = Date.now();
    if (contractsCache && (now - contractsCacheAt) < 10 * 60 * 1000) {
      return res.json({ ok: true, contracts: contractsCache });
    }
    const apiKey = process.env.BITGET_API_KEY;
    const secretKey = process.env.BITGET_SECRET_KEY;
    const passphrase = process.env.BITGET_PASSPHRASE;
    if (!apiKey) return res.json({ ok: false, msg: 'API key belum di-set' });

    let api;
    if (bot && bot.bitget) {
      api = bot.bitget;
    } else {
      const Bot = require('./bot');
      const tmp = new Bot({ apiKey, secretKey, passphrase, geminiKey: process.env.GEMINI_API_KEY || '' });
      api = tmp.bitget;
    }

    const r = await api.getContracts();
    if (r.code && r.code !== '00000') return res.json({ ok: false, msg: r.msg });
    const map = {};
    for (const c of (r.data || [])) {
      map[c.symbol] = {
        maxLever: parseInt(c.maxLever || 0) || 50,
        minLever: parseInt(c.minLever || 1) || 1,
        pricePlace: parseInt(c.pricePlace || 2) || 2,
        priceEndStep: parseInt(c.priceEndStep || 1) || 1,
        volumePlace: parseInt(c.volumePlace || 0) || 0,
        minTradeNum: parseFloat(c.minTradeNum || 0) || 0,
        minTradeUSDT: parseFloat(c.minTradeUSDT || 5) || 5
      };
    }
    contractsCache = map;
    contractsCacheAt = now;
    res.json({ ok: true, contracts: map });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get('/ping', (req, res) => res.send('pong'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SihaTradeBot server running on port ${PORT}`);
});
