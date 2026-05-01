const crypto = require('crypto');
const https = require('https');

// ============================================================
// NEXUS BOT — Bitget Futures + Gemini AI (Multi-Coin Scanner)
// ============================================================

class BitgetAPI {
  constructor(apiKey, secretKey, passphrase) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
    this.baseUrl = 'api.bitget.com';
  }

  sign(timestamp, method, path, body = '') {
    const msg = timestamp + method.toUpperCase() + path + body;
    return crypto.createHmac('sha256', this.secretKey).update(msg).digest('base64');
  }

  request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now().toString();
      const bodyStr = body ? JSON.stringify(body) : '';
      const signature = this.sign(timestamp, method, path, bodyStr);

      const options = {
        hostname: this.baseUrl,
        path,
        method,
        headers: {
          'ACCESS-KEY': this.apiKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': this.passphrase,
          'Content-Type': 'application/json',
          'locale': 'en-US'
        }
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async getBalance() {
    return await this.request('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
  }

  async getTicker(symbol) {
    return await this.request('GET', `/api/v2/mix/market/ticker?symbol=${symbol}&productType=USDT-FUTURES`);
  }

  async getCandles(symbol, granularity = '5m', limit = 1000, startTime, endTime) {
    let path = `/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
    if (startTime) path += `&startTime=${startTime}`;
    if (endTime) path += `&endTime=${endTime}`;
    return await this.request('GET', path);
  }

  async getAllPositions() {
    return await this.request('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
  }

  async getContracts() {
    return await this.request('GET', '/api/v2/mix/market/contracts?productType=USDT-FUTURES');
  }

  async closePosition(symbol, holdSide) {
    return await this.request('POST', '/api/v2/mix/order/close-positions', {
      symbol,
      productType: 'USDT-FUTURES',
      holdSide
    });
  }

  async setMarginMode(symbol, mode = 'isolated') {
    return await this.request('POST', '/api/v2/mix/account/set-margin-mode', {
      symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
      marginMode: mode
    });
  }

  async setLeverage(symbol, leverage, side) {
    // Try BOTH modes: one-way (no holdSide) AND hedge (with holdSide).
    // Whichever the account uses will succeed; the other returns 40774/40808 etc.
    const holdSide = side === 'buy' ? 'long' : 'short';
    const errors = [];
    try {
      const r = await this.request('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
        leverage: String(leverage)
      });
      if (r.code === '00000') return { ok: true, data: r.data };
      errors.push(`one-way: ${r.code} ${r.msg}`);
    } catch (e) { errors.push(`one-way ex: ${e.message}`); }

    try {
      const r = await this.request('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
        leverage: String(leverage), holdSide
      });
      if (r.code === '00000') return { ok: true, data: r.data };
      errors.push(`hedge: ${r.code} ${r.msg}`);
    } catch (e) { errors.push(`hedge ex: ${e.message}`); }

    return { ok: false, msg: errors.join(' | ') };
  }

  async placeOrder(symbol, side, size, leverage, tpPrice, slPrice) {
    // Make sure margin mode is isolated (silently ignore if already)
    try { await this.setMarginMode(symbol, 'isolated'); } catch (e) {}

    // Set leverage robustly (try one-way + hedge)
    const lev = await this.setLeverage(symbol, leverage, side);
    if (!lev.ok) {
      return { code: 'LEV_FAIL', msg: `set-leverage gagal: ${lev.msg}` };
    }

    const order = {
      symbol,
      productType: 'USDT-FUTURES',
      marginMode: 'isolated',
      marginCoin: 'USDT',
      size: String(size),
      side,
      tradeSide: 'open',
      orderType: 'market',
      presetStopSurplusPrice: String(tpPrice),
      presetStopLossPrice: String(slPrice)
    };

    return await this.request('POST', '/api/v2/mix/order/place-order', order);
  }
}

// ============================================================
// TECHNICAL SIGNAL — rule-based scalping (gak bohong, gak ragu)
// ============================================================
function technicalSignal(market) {
  const { price, rsi, ema20, ema50 } = market;
  const emaTrend = ema20 > ema50 ? 'BULL' : 'BEAR';
  const priceVsEma20Pct = ((price - ema20) / ema20) * 100;

  let signal = 'WAIT';
  let confidence = 50;
  let reason = '';

  // STRONG OVERSOLD → LONG
  if (rsi < 30) {
    signal = 'LONG';
    confidence = emaTrend === 'BULL' ? 85 : 72;
    reason = `RSI oversold ${rsi} + EMA ${emaTrend}`;
  }
  // STRONG OVERBOUGHT → SHORT
  else if (rsi > 70) {
    signal = 'SHORT';
    confidence = emaTrend === 'BEAR' ? 85 : 72;
    reason = `RSI overbought ${rsi} + EMA ${emaTrend}`;
  }
  // MODERATE OVERSOLD + bullish trend → LONG
  else if (rsi < 40 && emaTrend === 'BULL' && priceVsEma20Pct > -1) {
    signal = 'LONG';
    confidence = 70;
    reason = `Pullback in bull trend (RSI ${rsi}, harga dekat EMA20)`;
  }
  // MODERATE OVERBOUGHT + bearish trend → SHORT
  else if (rsi > 60 && emaTrend === 'BEAR' && priceVsEma20Pct < 1) {
    signal = 'SHORT';
    confidence = 70;
    reason = `Rally in bear trend (RSI ${rsi}, harga dekat EMA20)`;
  }
  // BREAKOUT MOMENTUM
  else if (rsi > 55 && emaTrend === 'BULL' && priceVsEma20Pct > 0.3) {
    signal = 'LONG';
    confidence = 65;
    reason = `Momentum bullish (RSI ${rsi}, harga ${priceVsEma20Pct.toFixed(2)}% di atas EMA20)`;
  }
  else if (rsi < 45 && emaTrend === 'BEAR' && priceVsEma20Pct < -0.3) {
    signal = 'SHORT';
    confidence = 65;
    reason = `Momentum bearish (RSI ${rsi}, harga ${priceVsEma20Pct.toFixed(2)}% di bawah EMA20)`;
  }
  else {
    reason = `Range/chop — RSI ${rsi}, EMA ${emaTrend}, harga ${priceVsEma20Pct.toFixed(2)}% dari EMA20`;
  }

  // Hitung TP/SL berdasarkan signal (scalping ketat)
  const tpPct = 0.008; // 0.8%
  const slPct = 0.005; // 0.5%
  let takeProfit = 0, stopLoss = 0;
  if (signal === 'LONG') {
    takeProfit = parseFloat((price * (1 + tpPct)).toFixed(6));
    stopLoss = parseFloat((price * (1 - slPct)).toFixed(6));
  } else if (signal === 'SHORT') {
    takeProfit = parseFloat((price * (1 - tpPct)).toFixed(6));
    stopLoss = parseFloat((price * (1 + slPct)).toFixed(6));
  }

  return {
    signal, confidence,
    entry: price, takeProfit, stopLoss,
    reasoning: reason,
    risk: confidence >= 80 ? 'LOW' : confidence >= 65 ? 'MEDIUM' : 'HIGH',
    raw: `TECHNICAL\nSIGNAL: ${signal}\nCONFIDENCE: ${confidence}\nREASONING: ${reason}\nRISK: ${confidence >= 80 ? 'LOW' : 'MEDIUM'}`
  };
}

// ============================================================
// GEMINI AI — sebagai konfirmasi tambahan (opsional)
// ============================================================
async function analyzeWithGemini(geminiKey, marketData) {
  const prompt = `You are an aggressive but disciplined crypto futures SCALPING trader.
Goal: identify HIGH-PROBABILITY short-term setups (5-30 min). Avoid WAIT unless market is truly choppy.

MARKET DATA:
- Symbol: ${marketData.symbol}
- Price: $${marketData.price}
- 24h Change: ${marketData.change24h}%
- High/Low: $${marketData.high} / $${marketData.low}
- Volume: ${marketData.volume}
- RSI(14): ${marketData.rsi}
- EMA20: $${marketData.ema20}
- EMA50: $${marketData.ema50}
- Timeframe: ${marketData.timeframe}

DECISION RULES (be decisive):
- RSI < 35 + price near/below EMA20 → likely LONG (oversold bounce)
- RSI > 65 + price near/above EMA20 → likely SHORT (overbought rejection)
- EMA20 > EMA50 + price above EMA20 → bullish trend, prefer LONG on dips
- EMA20 < EMA50 + price below EMA20 → bearish trend, prefer SHORT on rallies
- Only WAIT if RSI is between 45-55 AND price is right at EMA20 (true chop)

SCALPING TARGETS (tight, fast):
- TAKE_PROFIT: 0.6% to 1.2% from entry (in price)
- STOP_LOSS: 0.4% to 0.7% from entry (in price)
- Risk/Reward must be ≥ 1.3

CONFIDENCE GUIDE:
- 80-95: strong confluence (RSI extreme + EMA aligned + clear momentum)
- 65-79: solid setup (1-2 indicators aligned)
- 50-64: marginal — output WAIT instead
- Below 50: WAIT

Respond in this EXACT format, nothing else:
SIGNAL: LONG or SHORT or WAIT
CONFIDENCE: number 0-100
ENTRY: ${marketData.price}
TAKE_PROFIT: price number only
STOP_LOSS: price number only
REASONING: explanation in Indonesian, max 2 sentences
RISK: LOW or MEDIUM or HIGH`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(parseSignal(text));
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseSignal(text) {
  const get = (key) => {
    const match = text.match(new RegExp(key + ':\\s*(.+)', 'i'));
    return match ? match[1].trim() : null;
  };
  return {
    signal: get('SIGNAL')?.toUpperCase() || 'WAIT',
    confidence: parseInt(get('CONFIDENCE')) || 50,
    entry: parseFloat(get('ENTRY')) || 0,
    takeProfit: parseFloat(get('TAKE_PROFIT')) || 0,
    stopLoss: parseFloat(get('STOP_LOSS')) || 0,
    reasoning: get('REASONING') || '-',
    risk: get('RISK') || 'MEDIUM',
    raw: text
  };
}

// ============================================================
// INDICATORS
// ============================================================
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}

// ============================================================
// NEXUS BOT
// ============================================================
const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT',
  'TRXUSDT', 'TONUSDT', 'DOTUSDT', 'MATICUSDT', 'LTCUSDT',
  'BCHUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT',
  'INJUSDT', 'ATOMUSDT', 'FILUSDT', 'ICPUSDT', 'PEPEUSDT',
  'SHIBUSDT', 'WIFUSDT', 'BONKUSDT', 'TIAUSDT', 'SEIUSDT',
  'XAUTUSDT', 'XAGUSDT'
];

class NexusBot {
  constructor(config) {
    this.config = config;
    this.bitget = new BitgetAPI(config.apiKey, config.secretKey, config.passphrase);
    this.running = false;
    this.interval = null;
    this.reversalInterval = null;
    this.cycleBusy = false;
    this.reversalBusy = false;
    this.logs = [];
    this.trades = [];
    this.lastSignal = null;
    this.balance = 0;
    this.available = 0;
    this.unrealizedPL = 0;
    this.totalPnl = 0;
    this.wins = 0;
    this.totalTrades = 0;
    this.openPositions = [];
    this.lastTradeAt = 0;
    this.contractSpecs = {};
    this.pendingReversal = null; // { sig, market, pos, detectedAt }
  }

  async loadContractSpecs() {
    try {
      const res = await this.bitget.getContracts();
      if (res.code !== '00000') {
        this.log('ERR', `Gagal load contract specs: ${res.msg}`);
        return;
      }
      const list = Array.isArray(res.data) ? res.data : [];
      list.forEach(c => {
        this.contractSpecs[c.symbol] = {
          pricePlace: parseInt(c.pricePlace) || 2,
          volumePlace: parseInt(c.volumePlace) || 2,
          priceEndStep: parseInt(c.priceEndStep) || 1,
          minTradeNum: parseFloat(c.minTradeNum) || 0,
          sizeMultiplier: parseFloat(c.sizeMultiplier) || 0
        };
      });
      this.log('SYS', `Loaded specs untuk ${list.length} kontrak`);
    } catch (e) {
      this.log('ERR', 'Load specs error: ' + e.message);
    }
  }

  // Round price ke kelipatan tick yang benar
  roundPrice(symbol, price) {
    const spec = this.contractSpecs[symbol];
    if (!spec) return parseFloat(price.toFixed(6));
    const step = spec.priceEndStep;       // contoh 1 atau 5
    const decimals = spec.pricePlace;     // contoh 1 untuk BTC = 0.1
    const factor = Math.pow(10, decimals);
    // round ke (step / factor) kelipatan
    const tickSize = step / factor;
    const rounded = Math.round(price / tickSize) * tickSize;
    return parseFloat(rounded.toFixed(decimals));
  }

  // Round size ke presisi yg benar, plus enforce min trade
  roundSize(symbol, size) {
    const spec = this.contractSpecs[symbol];
    if (!spec) return parseFloat(Math.max(size, 0.0001).toFixed(4));
    const decimals = parseInt(spec.volumePlace) || 0;
    let s = parseFloat(size.toFixed(decimals));
    // enforce minimum trade num
    const minNum = parseFloat(spec.minTradeNum) || 0;
    if (minNum > 0 && s < minNum) s = minNum;
    // enforce sizeMultiplier (kelipatan) — default 1 jika 0 atau undefined
    const mult = parseFloat(spec.sizeMultiplier) || 1;
    if (mult > 0) {
      s = Math.ceil(s / mult) * mult;
      s = parseFloat(s.toFixed(decimals));
    }
    // final guard
    if (s <= 0 || isNaN(s)) s = minNum > 0 ? minNum : parseFloat((1 / Math.pow(10, decimals)).toFixed(decimals));
    return s;
  }

  log(type, msg) {
    const entry = { time: new Date().toLocaleTimeString('id-ID'), type, msg };
    this.logs.unshift(entry);
    if (this.logs.length > 150) this.logs.pop();
    console.log(`[${entry.time}] [${type}] ${msg}`);
  }

  getSymbols() {
    if (this.config.scanAll) return DEFAULT_SYMBOLS;
    if (Array.isArray(this.config.symbols) && this.config.symbols.length) return this.config.symbols;
    return [this.config.symbol || 'BTCUSDT'];
  }

  async getMarketData(symbol) {
    const tf = this.config.timeframe || '5m';
    const [tickerRes, candleRes] = await Promise.all([
      this.bitget.getTicker(symbol),
      this.bitget.getCandles(symbol, tf, 60)
    ]);
    const ticker = tickerRes.data?.[0] || {};
    const candles = candleRes.data || [];
    const closes = candles.map(c => parseFloat(c[4])).reverse();
    const rsi = calcRSI(closes);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);

    return {
      symbol,
      timeframe: tf,
      price: parseFloat(ticker.lastPr || 0),
      change24h: parseFloat(ticker.change24h || 0).toFixed(2),
      high: parseFloat(ticker.high24h || 0),
      low: parseFloat(ticker.low24h || 0),
      volume: parseFloat(ticker.baseVolume || 0).toFixed(0),
      rsi, ema20, ema50
    };
  }

  async fetchBalance() {
    try {
      const res = await this.bitget.getBalance();
      if (res.code && res.code !== '00000') {
        this.log('ERR', `Balance API error: ${res.msg || res.code}`);
        return;
      }
      const list = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
      if (list.length === 0) return;
      const acct = list.find(a => (a.marginCoin || '').toUpperCase() === 'USDT') || list[0];

      this.balance = parseFloat(acct?.usdtEquity ?? acct?.accountEquity ?? acct?.available ?? 0);
      this.available = parseFloat(acct?.available ?? acct?.crossedMaxAvailable ?? 0);
      this.unrealizedPL = parseFloat(acct?.unrealizedPL ?? 0);
    } catch (e) {
      this.log('ERR', 'Gagal ambil balance: ' + e.message);
    }
  }

  async fetchOpenPositions() {
    try {
      const res = await this.bitget.getAllPositions();
      if (res.code && res.code !== '00000') return;
      const list = Array.isArray(res.data) ? res.data : [];
      this.openPositions = list
        .filter(p => parseFloat(p.total || 0) > 0)
        .map(p => {
          const size = parseFloat(p.total || 0);
          const entry = parseFloat(p.openPriceAvg || 0);
          const lev = parseFloat(p.leverage || 1);
          const notional = size * entry;
          const margin = lev > 0 ? notional / lev : notional;
          return {
            symbol: p.symbol,
            side: (p.holdSide || '').toUpperCase(),
            size, entry,
            markPrice: parseFloat(p.markPrice || 0),
            unrealizedPL: parseFloat(p.unrealizedPL || 0),
            leverage: lev,
            margin,
            notional
          };
        });
    } catch (e) {
      this.log('ERR', 'Gagal ambil posisi: ' + e.message);
    }
  }

  async runCycle() {
    if (this.cycleBusy) return;
    this.cycleBusy = true;

    try {
      await Promise.all([this.fetchBalance(), this.fetchOpenPositions()]);

      // ── MANAGE OPEN POSITION (auto-close on profit / AI exit check)
      if (this.openPositions.length > 0) {
        for (const p of this.openPositions) {
          await this.manageOpenPosition(p);
        }
        // Re-fetch posisi setelah potensi close
        await this.fetchOpenPositions();
        if (this.openPositions.length > 0) {
          this.log('SYS', `Tahan posisi ${this.openPositions[0].symbol} (uPnL: $${this.openPositions[0].unrealizedPL.toFixed(2)})`);
          return;
        }
      }

      // SAFETY: cooldown 60 detik setelah trade terakhir
      const cooldownMs = (this.config.cooldownSec || 60) * 1000;
      if (Date.now() - this.lastTradeAt < cooldownMs) {
        const remain = Math.ceil((cooldownMs - (Date.now() - this.lastTradeAt)) / 1000);
        this.log('SYS', `Cooldown ${remain}s setelah trade terakhir...`);
        return;
      }

      const symbols = this.getSymbols();
      this.log('SYS', `Scan ${symbols.length} koin: ${symbols.join(', ')}`);

      // Scan semua koin paralel — ambil market data
      const marketResults = await Promise.allSettled(
        symbols.map(s => this.getMarketData(s))
      );
      const markets = marketResults
        .filter(r => r.status === 'fulfilled' && r.value.price > 0)
        .map(r => r.value);

      if (markets.length === 0) {
        this.log('ERR', 'Gagal ambil data market dari semua koin');
        return;
      }

      // Generate sinyal teknikal (instant, no API call)
      const signals = markets.map(m => ({ ...technicalSignal(m), market: m }));

      // Pilih sinyal terbaik: bukan WAIT, confidence tertinggi, di atas threshold
      const minConf = this.config.minConfidence || 65;
      const tradable = signals
        .filter(s => s.signal !== 'WAIT' && s.confidence >= minConf)
        .sort((a, b) => b.confidence - a.confidence);

      // Log ringkasan tiap koin
      signals.forEach(s => {
        const tag = s.signal === 'WAIT' ? 'WAIT' : `${s.signal} ${s.confidence}%`;
        this.log('AI', `${s.market.symbol}: ${tag}`);
      });

      if (tradable.length === 0) {
        this.log('SYS', `Tidak ada sinyal tradable (min conf ${minConf}%) — tunggu cycle berikut`);
        return;
      }

      const best = tradable[0];
      this.lastSignal = { ...best, timestamp: Date.now() };
      this.log('AI', `★ BEST: ${best.market.symbol} ${best.signal} ${best.confidence}% — ${best.reasoning}`);

      // AI explanation (Gemini jelasin sinyal dlm bahasa manusia, async, no block)
      if (this.config.geminiKey) {
        geminiExplainSignal(this.config.geminiKey, best.market, best)
          .then(text => {
            if (text) {
              this.lastSignal.raw = text;
              // Log full Gemini analysis ke log tab baris per baris
              const analisa = text.match(/ANALISA:\s*([\s\S]+?)(?:ACTION:|$)/i)?.[1]?.trim();
              const action  = text.match(/ACTION:\s*(.+)/i)?.[1]?.trim();
              if (analisa) this.log('AI', `[ANALISA ${best.market.symbol}] ${analisa.replace(/\n/g,' ')}`);
              if (action)  this.log('AI', `[ACTION ${best.market.symbol}] ${action}`);
            }
          })
          .catch(() => {});
      }

      if (this.config.autoTrade) {
        await this.executeSignal(best, best.market);
      } else {
        this.log('SYS', 'Auto-execute OFF — sinyal tidak dieksekusi');
      }

    } catch (e) {
      this.log('ERR', e.message);
    } finally {
      this.cycleBusy = false;
    }
  }

  async manageOpenPosition(position) {
    try {
      const margin = this.config.margin || 5;
      const profitLockPct = this.config.profitLockPct || 30; // % dari margin
      const lossLimitPct = this.config.lossLimitPct || 50;   // % dari margin (max loss tolerated)

      const profitTarget = margin * (profitLockPct / 100);
      const lossLimit = margin * (lossLimitPct / 100);

      // Rule 1: Auto-close kalau profit ≥ target
      if (position.unrealizedPL >= profitTarget) {
        this.log('ORDER', `🎯 Profit lock! ${position.symbol} uPnL $${position.unrealizedPL.toFixed(2)} ≥ target $${profitTarget.toFixed(2)} — closing`);
        await this.closePositionNow(position, 'PROFIT');
        return;
      }

      // Rule 2: Cut loss kalau rugi ≥ limit
      if (position.unrealizedPL <= -lossLimit) {
        this.log('ORDER', `🛑 Stop loss! ${position.symbol} uPnL $${position.unrealizedPL.toFixed(2)} ≤ -$${lossLimit.toFixed(2)} — closing`);
        await this.closePositionNow(position, 'LOSS');
        return;
      }

      // Rule 3: AI exit check — kalau profit positif tapi belum capai target, tanya AI
      if (position.unrealizedPL > 0 && this.config.aiExitCheck !== false) {
        try {
          const market = await this.getMarketData(position.symbol);
          const decision = await this.askAIToExit(position, market);
          this.log('AI', `Exit check ${position.symbol}: ${decision.action} — ${decision.reason}`);
          if (decision.action === 'CLOSE') {
            await this.closePositionNow(position, 'AI_EXIT');
            return;
          }
        } catch (e) {
          // AI gagal, tetap pegang posisi sesuai TP/SL native
        }
      }
    } catch (e) {
      this.log('ERR', 'Manage position error: ' + e.message);
    }
  }

  async closePositionNow(position, reason) {
    try {
      const holdSide = (position.side || '').toLowerCase().includes('long') ? 'long' : 'short';
      const res = await this.bitget.closePosition(position.symbol, holdSide);

      if (res.code === '00000') {
        this.lastTradeAt = Date.now();
        this.totalPnl += position.unrealizedPL;
        if (position.unrealizedPL > 0) this.wins++;
        this.totalTrades++;
        this.log('ORDER', `✅ Closed ${position.symbol} ${holdSide.toUpperCase()} | ${reason} | PnL: ${position.unrealizedPL >= 0 ? '+' : ''}$${position.unrealizedPL.toFixed(2)}`);

        // Catat ke history
        this.trades.unshift({
          time: new Date().toLocaleTimeString('id-ID'),
          symbol: position.symbol,
          side: holdSide.toUpperCase(),
          entry: position.entry,
          exit: position.markPrice,
          pnl: position.unrealizedPL,
          reason,
          status: 'CLOSED'
        });
      } else {
        this.log('ERR', `Close gagal: ${res.msg} (${res.code})`);
      }
    } catch (e) {
      this.log('ERR', 'Close error: ' + e.message);
    }
  }

  async askAIToExit(position, market) {
    const pnlPct = ((position.markPrice - position.entry) / position.entry * 100 * (position.side.includes('LONG') ? 1 : -1)).toFixed(2);

    const prompt = `You manage an OPEN futures position. Decide if to CLOSE NOW or HOLD.

POSITION:
- Symbol: ${position.symbol}
- Side: ${position.side}
- Entry: $${position.entry}
- Current: $${position.markPrice}
- PnL: $${position.unrealizedPL.toFixed(2)} (${pnlPct}%)

CURRENT MARKET:
- RSI(14): ${market.rsi}
- EMA20: $${market.ema20}
- EMA50: $${market.ema50}

RULES:
- If profit is decent and momentum reversing → CLOSE (lock profit)
- If profit is small and trend still favorable → HOLD
- If RSI crossed extreme on the wrong side → CLOSE

Respond EXACTLY in 2 lines:
ACTION: CLOSE or HOLD
REASON: max 1 sentence in Indonesian`;

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.2 }
      });
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${this.config.geminiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const action = (text.match(/ACTION:\s*(\w+)/i)?.[1] || 'HOLD').toUpperCase();
            const reason = text.match(/REASON:\s*(.+)/i)?.[1] || '-';
            resolve({ action, reason });
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async executeSignal(signal, market) {
    try {
      const targetMargin = this.config.margin || 10;
      const leverage = this.config.leverage || 10;
      const side = signal.signal === 'LONG' ? 'buy' : 'sell';
      const spec = this.contractSpecs[market.symbol];

      // Target notional = margin × leverage
      const targetNotional = targetMargin * leverage;
      const rawSize = targetNotional / market.price;
      const size = this.roundSize(market.symbol, rawSize);

      // Hitung notional & margin SEBENARNYA setelah size dibulatkan
      const actualNotional = size * market.price;
      const actualMargin = actualNotional / leverage;

      // SAFETY: cek balance cukup (pakai actual margin)
      if (this.available < actualMargin) {
        this.log('ERR', `Balance kurang: $${this.available.toFixed(2)} < margin yg dibutuhkan $${actualMargin.toFixed(2)}`);
        return;
      }

      // SAFETY: cek size valid
      if (size <= 0) {
        this.log('ERR', `Size invalid setelah round (${size}) — naikin margin/leverage atau ganti koin`);
        return;
      }

      // Warn kalau margin actual jauh berbeda dari target (>20% lebih besar)
      if (spec && actualMargin > targetMargin * 1.2) {
        const minNotional = (spec.minTradeNum || 0) * market.price;
        const minMarginNeeded = minNotional / leverage;
        this.log('SYS', `⚠ ${market.symbol} min size ${spec.minTradeNum} → margin minimum $${minMarginNeeded.toFixed(2)} (kamu set $${targetMargin}). Pakai $${actualMargin.toFixed(2)}.`);
      }

      // Round TP/SL ke tick size yang benar
      const tp = signal.takeProfit > 0 ? this.roundPrice(market.symbol, signal.takeProfit) : 0;
      const sl = signal.stopLoss > 0 ? this.roundPrice(market.symbol, signal.stopLoss) : 0;

      // Guard: TP/SL harus berbeda dari entry setelah rounding
      if (tp > 0 && tp === market.price) {
        this.log('ERR', `TP sama dengan entry setelah rounding (${market.symbol}) — skip order`);
        return;
      }
      if (sl > 0 && sl === market.price) {
        this.log('ERR', `SL sama dengan entry setelah rounding (${market.symbol}) — skip order`);
        return;
      }

      // Refresh balance right before sending (avoid stale value)
      try { await this.fetchBalance(); } catch (e) {}

      this.log('ORDER', `Open ${signal.signal} ${market.symbol} | Size: ${size} | Margin: $${actualMargin.toFixed(2)} | Lev: ${leverage}x | Entry: ~$${market.price} | TP: $${tp} | SL: $${sl}`);

      let attemptSize = size;
      let res = await this.bitget.placeOrder(
        market.symbol, side, attemptSize, leverage, tp, sl
      );

      // Auto-retry once with scaled-down size if balance error (40762)
      // — happens when actual fees + margin slightly exceed available
      if (res.code === '40762' || (res.msg || '').toLowerCase().includes('exceeds the balance')) {
        this.log('SYS', `⚠ ${market.symbol}: balance check failed server-side, retry dgn size 80%`);
        const scaledRaw = attemptSize * 0.8;
        attemptSize = this.roundSize(market.symbol, scaledRaw);
        if (attemptSize > 0) {
          const retryNotional = attemptSize * market.price;
          const retryMargin = retryNotional / leverage;
          this.log('ORDER', `Retry: Size ${attemptSize} | Margin ~$${retryMargin.toFixed(2)}`);
          res = await this.bitget.placeOrder(
            market.symbol, side, attemptSize, leverage, tp, sl
          );
        }
      }

      if (res.code === '00000') {
        this.lastTradeAt = Date.now();
        this.log('ORDER', `✅ Order sukses! OrderId: ${res.data?.orderId}`);
        this.trades.unshift({
          time: new Date().toLocaleTimeString('id-ID'),
          symbol: market.symbol,
          side: signal.signal,
          entry: market.price,
          tp: signal.takeProfit,
          sl: signal.stopLoss,
          margin: actualMargin, leverage,
          orderId: res.data?.orderId,
          status: 'OPEN'
        });
        this.totalTrades++;
      } else if (res.code === 'LEV_FAIL') {
        this.log('ERR', `${market.symbol}: ${res.msg} — leverage ${leverage}x mungkin di atas max coin atau ada posisi terbuka di symbol ini`);
      } else if (res.code === '40762') {
        this.log('ERR', `${market.symbol}: Balance kurang. Cek di Bitget — saldo USDT-Futures kamu mungkin <$${actualMargin.toFixed(2)}, atau koin ini butuh min notional lebih besar.`);
      } else {
        this.log('ERR', `Order gagal: ${res.msg} (code: ${res.code})`);
      }
    } catch (e) {
      this.log('ERR', 'Execute error: ' + e.message);
    }
  }

  // ── AUTO REVERSAL: scan tiap 5 detik, minta konfirmasi user sebelum flip ──
  async runReversalCheck() {
    if (!this.running) return;
    if (this.reversalBusy || this.cycleBusy) return;
    if (!this.config.autoReversal) return;

    this.reversalBusy = true;
    try {
      // Auto-expire pending reversal setelah 25 detik
      if (this.pendingReversal && (Date.now() - this.pendingReversal.detectedAt > 25000)) {
        this.log('SYS', `Reversal ${this.pendingReversal.pos.symbol} kadaluarsa (tidak dikonfirmasi 25 detik)`);
        this.pendingReversal = null;
      }

      // Sudah ada pending yang belum dikonfirmasi — tunggu dulu
      if (this.pendingReversal) return;

      if (this.openPositions.length === 0) return;

      for (const pos of [...this.openPositions]) {
        let market;
        try { market = await this.getMarketData(pos.symbol); } catch (e) { continue; }

        const sig = technicalSignal(market);
        const minConf = this.config.reversalConfidence || 70;

        const isReversal = (
          (pos.side === 'LONG' && sig.signal === 'SHORT' && sig.confidence >= minConf) ||
          (pos.side === 'SHORT' && sig.signal === 'LONG'  && sig.confidence >= minConf)
        );

        if (isReversal) {
          // Simpan sebagai pending — tunggu konfirmasi user dari UI
          this.pendingReversal = { sig, market, pos: { ...pos }, detectedAt: Date.now() };
          this.log('AI', `⏳ REVERSAL TERDETEKSI: ${pos.symbol} posisi ${pos.side} → sinyal ${sig.signal} ${sig.confidence}% — menunggu konfirmasi kamu...`);
          break;
        } else {
          this.log('SYS', `Reversal check ${pos.symbol}: sinyal ${sig.signal} ${sig.confidence}% (min ${minConf}%) — tahan ${pos.side}`);
        }
      }
    } catch (e) {
      this.log('ERR', 'Reversal check error: ' + e.message);
    } finally {
      this.reversalBusy = false;
    }
  }

  // User klik Setuju — eksekusi flip
  async confirmReversal() {
    if (!this.pendingReversal) return { ok: false, msg: 'Tidak ada reversal pending.' };
    const { sig, market, pos } = this.pendingReversal;
    this.pendingReversal = null;
    this.log('AI', `✅ Reversal DIKONFIRMASI: close ${pos.symbol} ${pos.side} → buka ${sig.signal}`);
    try {
      await this.closePositionNow(pos, `REVERSAL→${sig.signal}`);
      await new Promise(r => setTimeout(r, 1500));
      this.lastSignal = { ...sig, market, timestamp: Date.now() };
      this.lastTradeAt = 0;
      if (this.config.autoTrade) {
        await this.fetchBalance();
        await this.executeSignal(sig, market);
      } else {
        this.log('SYS', 'Auto Execute OFF — sinyal reversal tidak dieksekusi otomatis');
      }
      return { ok: true };
    } catch (e) {
      this.log('ERR', 'Eksekusi reversal gagal: ' + e.message);
      return { ok: false, msg: e.message };
    }
  }

  // User klik Tidak — batalkan
  rejectReversal() {
    if (!this.pendingReversal) return { ok: false, msg: 'Tidak ada reversal pending.' };
    const { pos, sig } = this.pendingReversal;
    this.log('SYS', `❌ Reversal DITOLAK: tetap tahan posisi ${pos.symbol} ${pos.side}`);
    this.pendingReversal = null;
    return { ok: true };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const symbols = this.getSymbols();
    const reversalMode = this.config.autoReversal ? ` | AutoReversal ON (min ${this.config.reversalConfidence || 70}%)` : '';
    this.log('SYS', `Bot started | Mode: ${this.config.scanAll ? 'SCAN ALL' : 'SINGLE'} | Symbols: ${symbols.length} | Leverage: ${this.config.leverage}x | TF: ${this.config.timeframe}${reversalMode}`);
    await this.loadContractSpecs();
    await this.runCycle();
    const intervalMs = (this.config.intervalSec || 30) * 1000;
    this.interval = setInterval(() => this.runCycle(), intervalMs);

    // Reversal check tiap 5 detik (teknikal saja, instant)
    this.reversalInterval = setInterval(() => this.runReversalCheck(), 5000);
  }

  stop() {
    this.running = false;
    clearInterval(this.interval);
    clearInterval(this.reversalInterval);
    this.reversalInterval = null;
    this.log('SYS', 'Bot stopped.');
  }

  getStatus() {
    return {
      running: this.running,
      balance: this.balance,
      available: this.available,
      unrealizedPL: this.unrealizedPL,
      totalPnl: this.totalPnl,
      totalTrades: this.totalTrades,
      wins: this.wins,
      winRate: this.totalTrades > 0 ? Math.round(this.wins / this.totalTrades * 100) : 0,
      lastSignal: this.lastSignal,
      logs: this.logs.slice(0, 40),
      trades: this.trades.slice(0, 20),
      openPositions: this.openPositions,
      pendingReversal: this.pendingReversal,
      config: {
        symbols: this.getSymbols(),
        scanAll: this.config.scanAll,
        leverage: this.config.leverage,
        margin: this.config.margin,
        timeframe: this.config.timeframe,
        autoTrade: this.config.autoTrade,
        minConfidence: this.config.minConfidence
      }
    };
  }
}

// ============================================================
// GEMINI Q&A — user nanya bebas, AI jawab dengan konteks market
// ============================================================
function callGemini(geminiKey, prompt, model, maxTokens, temperature) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature }
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(json.error);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function askGeminiQuestion(geminiKey, question, context = '') {
  const prompt = `Kamu adalah AI asisten trader crypto futures yang ramah & to-the-point.
Jawab dalam Bahasa Indonesia santai tapi tetap akurat.
Kalau ada data market, gunakan untuk jawab spesifik. Kalau pertanyaan umum, jawab edukatif.
Maksimal 4 paragraf pendek. Jangan kasih financial advice yang kuat — selalu ingatkan trading itu berisiko.

PERTANYAAN USER:
${question}
${context}

JAWABAN:`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
  let lastError = null;
  let quotaError = null;
  for (const model of models) {
    try {
      const text = await callGemini(geminiKey, prompt, model, 500, 0.7);
      if (text) return text;
    } catch (e) {
      lastError = e;
      const msg = (e.message || '').toLowerCase();
      if (msg.includes('quota') || msg.includes('exceed') || e.code === 429) {
        quotaError = e;
        // coba model lain
        continue;
      }
      if (msg.includes('not found') || msg.includes('not supported')) {
        // model salah, coba berikutnya
        continue;
      }
      // error fatal lain (api key dll), stop
      break;
    }
  }
  // Format error
  if (quotaError) {
    throw new Error('Gemini API quota habis hari ini (free tier limit). Tunggu reset besok atau upgrade plan di Google AI Studio (ai.google.dev).');
  }
  const err = lastError?.message || 'Tidak bisa hubungi Gemini';
  if (err.toLowerCase().includes('api key') || err.toLowerCase().includes('invalid')) {
    throw new Error('GEMINI_API_KEY tidak valid. Cek di Replit Secrets.');
  }
  throw new Error('AI error: ' + err);
}

// ============================================================
// GEMINI EXPLAIN — AI jelasin sinyal teknikal dlm bahasa manusia
// ============================================================
async function geminiExplainSignal(geminiKey, market, sig) {
  const prompt = `Sebagai analis trader pro, jelaskan ringkas (3-4 baris) dalam Bahasa Indonesia kenapa sinyal ini muncul, dan apa yg harus diperhatikan.

DATA:
Symbol: ${market.symbol}
Harga: $${market.price}
RSI: ${market.rsi}
EMA20: $${market.ema20}
EMA50: $${market.ema50}
24h: ${market.change24h}%
Timeframe: ${market.timeframe}

SINYAL TEKNIKAL: ${sig.signal} (confidence ${sig.confidence}%, risk ${sig.risk})
Alasan teknis: ${sig.reasoning}
Target TP: $${sig.takeProfit}, SL: $${sig.stopLoss}

Format respons (gak usah markdown, plain text):
SIGNAL: ${sig.signal}
CONFIDENCE: ${sig.confidence}%
RISK: ${sig.risk}
ANALISA: <3-4 baris penjelasan praktis dlm BI, sebut harga & indikator>
ACTION: <1 baris saran ringkas>`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 250, temperature: 0.5 }
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text.trim() || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

module.exports = NexusBot;
module.exports.DEFAULT_SYMBOLS = DEFAULT_SYMBOLS;
module.exports.askGeminiQuestion = askGeminiQuestion;
module.exports.geminiExplainSignal = geminiExplainSignal;
