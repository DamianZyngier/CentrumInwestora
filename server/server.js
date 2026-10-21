'use strict';

/**
 * Centrum Inwestora - lokalny serwer.
 *
 * Rola:
 *  - serwowanie statycznego frontendu (site/),
 *  - proxy do Yahoo Finance i NBP (przeglądarka nie może ich wołać bez CORS),
 *  - cache odpowiedzi na dysku (katalog cache/).
 *
 * Serwer NIE przechowuje transakcji ani danych portfela - te zostają w przeglądarce.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT_DIR, 'site');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(process.env.CACHE_DIR)
  : path.join(ROOT_DIR, 'cache');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 20000, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} dla ${url}`);
  }
  return response.json();
}

function cacheFile(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function cleanupCache(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  try {
    const files = await fsp.readdir(CACHE_DIR);
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(CACHE_DIR, name);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(file);
          removed += 1;
        }
      } catch {
        /* plik mógł zniknąć */
      }
    }
    if (removed > 0) console.log(`[cache] usunięto ${removed} starych plików`);
  } catch {
    /* brak katalogu cache */
  }
}

const inFlight = new Map();

async function cached(key, ttlMs, producer) {
  const file = cacheFile(key);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs < ttlMs) {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    }
  } catch {
    /* brak cache - liczymy od nowa */
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const value = await producer();
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(value), 'utf8');
    } catch (error) {
      console.warn('[cache] zapis nieudany:', error.message);
    }
    return value;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

const MINOR_UNITS = {
  GBp: { code: 'GBP', divisor: 100 },
  GBX: { code: 'GBP', divisor: 100 },
  ILA: { code: 'ILS', divisor: 100 },
  ZAc: { code: 'ZAR', divisor: 100 },
};

function normalizeCurrency(rawCurrency) {
  if (!rawCurrency) return { code: 'PLN', divisor: 1, raw: 'PLN' };
  const minor = MINOR_UNITS[rawCurrency];
  if (minor) return { code: minor.code, divisor: minor.divisor, raw: rawCurrency };
  return { code: rawCurrency.toUpperCase(), divisor: 1, raw: rawCurrency };
}

function isoDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function assertSymbol(symbol) {
  if (!/^[A-Za-z0-9.\-=^]{1,24}$/.test(symbol || '')) {
    throw new Error(`Nieprawidłowy symbol: ${symbol}`);
  }
  return symbol;
}

function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`Nieprawidłowa data: ${value}`);
  }
  return value;
}

function assertCurrency(value) {
  if (!/^[A-Z]{3}$/.test(value || '')) {
    throw new Error(`Nieprawidłowa waluta: ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Yahoo Finance
// ---------------------------------------------------------------------------

let yahooChain = Promise.resolve();
let lastYahooAt = 0;
let yahooBlockedUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yahooBlockedError() {
  return new Error(
    'Yahoo Finance chwilowo ogranicza zapytania (HTTP 429). Spróbuj ponownie za kilka minut - część danych może pochodzić z cache.'
  );
}

/**
 * Yahoo ogranicza liczbę zapytań (HTTP 429). Wszystkie zapytania serializujemy
 * z minimalnym odstępem i ponawiamy z backoffem - dzięki temu pierwsze pobranie
 * jest wolniejsze, ale stabilne, a kolejne korzystają z cache.
 */
function scheduleYahoo(task) {
  const run = async () => {
    if (Date.now() < yahooBlockedUntil) throw yahooBlockedError();
    const wait = Math.max(0, 350 - (Date.now() - lastYahooAt));
    if (wait > 0) await sleep(wait);
    lastYahooAt = Date.now();
    return task();
  };
  const result = yahooChain.then(run, run);
  yahooChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function fetchChart(symbol, query, timeoutMs = 20000) {
  return scheduleYahoo(async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const host = attempt % 2 === 0 ? 'query1' : 'query2';
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
        const data = await fetchJson(url, timeoutMs);
        const result = data && data.chart && data.chart.result && data.chart.result[0];
        if (!result) throw new Error(`Brak danych dla ${symbol}`);
        yahooBlockedUntil = 0;
        return result;
      } catch (error) {
        lastError = error;
        const rateLimited = /429|Too Many/i.test(error.message || '');
        if (rateLimited) {
          // Nie katujmy Yahoo kolejnymi symbolami, jeśli limit jest globalny.
          yahooBlockedUntil = Date.now() + 60 * 1000;
        }
        const retryable = /429|Too Many|timeout|aborted|fetch failed/i.test(error.message || '');
        if (!retryable || attempt === 2) throw error;
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastError;
  });
}

function extractSplits(result) {
  const raw = (result.events && result.events.splits) || {};
  return Object.values(raw)
    .map((split) => ({
      date: isoDate(split.date),
      ratio: Number(split.numerator) / Number(split.denominator),
    }))
    .filter((split) => Number.isFinite(split.ratio) && split.ratio > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getQuote(symbol) {
  return cached(`quote:v2:${symbol}`, 10 * 60 * 1000, async () => {
    const result = await fetchChart(symbol, 'interval=1d&range=1d');
    const meta = result.meta || {};
    const rawCurrency = meta.currency || 'PLN';
    const normalized = normalizeCurrency(rawCurrency);
    const rawPrice = Number(meta.regularMarketPrice ?? meta.chartPreviousClose ?? meta.previousClose);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new Error(`Brak ceny dla ${symbol}`);
    }
    return {
      symbol,
      price: rawPrice / normalized.divisor,
      currency: normalized.code,
      rawPrice,
      rawCurrency,
      name: meta.longName || meta.shortName || symbol,
      exchange: meta.fullExchangeName || meta.exchangeName || '',
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    };
  });
}

async function getHistory(symbol, fromIso) {
  const from = Math.floor(new Date(`${fromIso}T00:00:00Z`).getTime() / 1000) - 10 * 86400;
  const to = Math.floor(Date.now() / 1000) + 86400;
  return cached(`history:v3:${symbol}:${fromIso}`, 12 * 60 * 60 * 1000, async () => {
    const result = await fetchChart(
      symbol,
      `period1=${from}&period2=${to}&interval=1d&events=split`,
      30000
    );
    const meta = result.meta || {};
    const normalized = normalizeCurrency(meta.currency || 'PLN');
    const timestamps = result.timestamp || [];
    const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
    const dates = [];
    const values = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const close = closes[i];
      if (close == null || !Number.isFinite(Number(close))) continue;
      dates.push(isoDate(timestamps[i]));
      values.push(Number(close) / normalized.divisor);
    }
    return {
      symbol,
      currency: normalized.code,
      rawCurrency: meta.currency || 'PLN',
      name: meta.longName || meta.shortName || symbol,
      exchange: meta.fullExchangeName || meta.exchangeName || '',
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      dates,
      closes: values,
      splits: extractSplits(result),
    };
  });
}

async function getSplits(symbol, fromIso) {
  const from = Math.floor(new Date(`${fromIso}T00:00:00Z`).getTime() / 1000) - 10 * 86400;
  const to = Math.floor(Date.now() / 1000) + 86400;
  return cached(`splits:v3:${symbol}:${fromIso}`, 12 * 60 * 60 * 1000, async () => {
    const result = await fetchChart(
      symbol,
      `period1=${from}&period2=${to}&interval=1mo&events=split`,
      20000
    );
    return extractSplits(result);
  });
}

// ---------------------------------------------------------------------------
// TradingView - notowania bieżące (jedno zapytanie dla wielu symboli)
// ---------------------------------------------------------------------------

const TRADINGVIEW_URL = 'https://scanner.tradingview.com/global/scan';

// Sufiks Yahoo -> giełda w TradingView. Dzięki temu nie trzeba pobierać
// notowań osobno dla każdego symbolu (Yahoo bardzo agresywnie ogranicza 429).
const TRADINGVIEW_EXCHANGES = [
  ['.WA', 'GPW'],
  ['.L', 'LSE'],
  ['.DE', 'XETR'],
  ['.F', 'FRA'],
  ['.BE', 'BER'],
  ['.MU', 'MUN'],
  ['.DU', 'DUS'],
  ['.HM', 'HAM'],
  ['.HA', 'HAN'],
  ['.SG', 'STU'],
  ['.SW', 'SIX'],
  ['.PA', 'EURONEXT'],
  ['.AS', 'EURONEXT'],
  ['.BR', 'EURONEXT'],
  ['.LS', 'EURONEXT'],
  ['.MI', 'MIL'],
  ['.MC', 'BME'],
  ['.ST', 'OMXSTO'],
  ['.CO', 'OMXCOP'],
  ['.HE', 'OMXHEX'],
  ['.OL', 'OSL'],
  ['.VI', 'VIE'],
  ['.TO', 'TSX'],
  ['.V', 'TSXV'],
  ['.AX', 'ASX'],
  ['.HK', 'HKEX'],
  ['.T', 'TSE'],
  ['.KS', 'KRX'],
  ['.SI', 'SGX'],
  ['.SA', 'BMFBOVESPA'],
];

function tradingViewSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase();
  for (const [suffix, exchange] of TRADINGVIEW_EXCHANGES) {
    if (upper.endsWith(suffix)) return `${exchange}:${upper.slice(0, -suffix.length)}`;
  }
  return null;
}

async function fetchTradingViewQuotes(symbols) {
  const entries = [...new Set(symbols)]
    .map((symbol) => ({ symbol, ticker: tradingViewSymbol(symbol) }))
    .filter((entry) => entry.ticker);
  if (entries.length === 0) return {};

  const quotes = {};
  for (let offset = 0; offset < entries.length; offset += 50) {
    const batch = entries.slice(offset, offset + 50);
    const data = await fetchJson(TRADINGVIEW_URL, 20000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: {
          tickers: batch.map((entry) => entry.ticker),
          query: { types: [] },
        },
        columns: ['close', 'currency', 'description', 'exchange', 'update_mode'],
      }),
    });

    const byTicker = new Map(batch.map((entry) => [entry.ticker, entry.symbol]));
    for (const row of data.data || []) {
      const symbol = byTicker.get(row.s);
      if (!symbol) continue;
      const [rawClose, rawCurrency, description, exchange, updateMode] = row.d || [];
      const close = Number(rawClose);
      if (!Number.isFinite(close) || close <= 0) continue;
      const normalized = normalizeCurrency(rawCurrency || 'PLN');
      quotes[symbol] = {
        symbol,
        price: close / normalized.divisor,
        currency: normalized.code,
        rawPrice: close,
        rawCurrency: normalized.raw,
        name: description || symbol,
        exchange: exchange || '',
        marketTime: new Date().toISOString(),
        source: 'TradingView',
        delayed: /delayed/i.test(String(updateMode || '')),
      };
    }
  }
  return quotes;
}

async function getTradingViewQuotes(symbols) {
  const key = `tv:quotes:v1:${[...new Set(symbols)].sort().join(',')}`;
  const result = await cached(key, 5 * 60 * 1000, async () => ({
    quotes: await fetchTradingViewQuotes(symbols),
    fetchedAt: new Date().toISOString(),
  }));
  return result.quotes || {};
}

/**
 * Jedno zapytanie z przeglądarki: notowania, historia, splity i kursy walut.
 * Dzięki temu frontend nie zalewa Yahoo dziesiątkami równoległych żądań.
 */
async function getSnapshot(symbols, fromIso) {
  const histories = {};
  const splits = {};
  const quotes = {};
  const errors = [];
  let tradingViewError = null;

  // 1. Notowania bieżące: jedno zapytanie do TradingView dla wszystkich symboli.
  //    Yahoo jest obecnie bardzo mocno ograniczane (HTTP 429), więc nie nadaje
  //    się na główne źródło wyceny. TradingView zwraca cenę, walutę i nazwę.
  try {
    Object.assign(quotes, await getTradingViewQuotes(symbols));
  } catch (error) {
    tradingViewError = error;
  }

  // 2. Historia (wykres) i splity: Yahoo. Jeśli jest zablokowane, wycena
  //    z TradingView nadal jest poprawna - brakuje tylko wykresu.
  for (const symbol of symbols) {
    try {
      const history = await getHistory(symbol, fromIso);
      histories[symbol] = history;
      splits[symbol] = history.splits;
      if (!quotes[symbol]) {
        const lastPrice = history.closes.length > 0 ? history.closes[history.closes.length - 1] : null;
        if (lastPrice != null) {
          quotes[symbol] = {
            symbol,
            price: lastPrice,
            currency: history.currency,
            name: history.name,
            exchange: history.exchange,
            marketTime: history.marketTime,
            source: 'Yahoo',
          };
        }
      }
    } catch (error) {
      errors.push({ symbol, message: error.message, scope: 'history' });
    }
  }

  // 3. Kursy walut: NBP (działa niezależnie od Yahoo).
  let rates = { PLN: 1 };
  let fxDate = null;
  try {
    const fx = await getFxLatest();
    rates = { PLN: 1, ...fx.rates };
    fxDate = fx.date;
  } catch (error) {
    errors.push({ symbol: 'FX', message: error.message, scope: 'quote' });
  }

  // Błąd TradingView pokazujemy tylko wtedy, gdy nie udało się zdobyć żadnej
  // wyceny - inaczej byłby mylący (Yahoo mogło uzupełnić brakujące symbole).
  if (Object.keys(quotes).length === 0 && tradingViewError) {
    errors.push({ symbol: 'TradingView', message: tradingViewError.message, scope: 'quote' });
  }

  return {
    quotes,
    histories,
    splits,
    rates,
    fxDate,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// NBP
// ---------------------------------------------------------------------------

async function getFxLatest() {
  return cached('nbp:latest', 60 * 60 * 1000, async () => {
    const data = await fetchJson('https://api.nbp.pl/api/exchangerates/tables/a/?format=json');
    const table = data && data[0];
    if (!table || !Array.isArray(table.rates)) throw new Error('Nieprawidłowa odpowiedź NBP');
    const rates = { PLN: 1 };
    for (const rate of table.rates) rates[rate.code] = rate.mid;
    return { date: table.effectiveDate, rates };
  });
}

function shiftDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function getFxRate(currency, dateIso) {
  if (currency === 'PLN') return { currency, date: dateIso, rate: 1, source: 'stały' };
  return cached(`nbp:rate:${currency}:${dateIso}`, 30 * 24 * 60 * 60 * 1000, async () => {
    let lastError = null;
    // NBP nie publikuje kursów w weekendy i święta - cofamy się maks. 7 dni.
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = shiftDate(dateIso, -offset);
      try {
        const data = await fetchJson(
          `https://api.nbp.pl/api/exchangerates/rates/a/${currency}/${day}/?format=json`,
          15000
        );
        const rate = data && data.rates && data.rates[0];
        if (!rate) throw new Error('Brak kursu');
        return {
          currency,
          date: day,
          requestedDate: dateIso,
          rate: rate.mid,
          source: offset === 0 ? 'NBP' : `NBP (${day})`,
          estimated: offset > 0,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Brak kursu NBP ${currency} dla ${dateIso}: ${lastError && lastError.message}`);
  });
}

// ---------------------------------------------------------------------------
// Routing API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'centrum-inwestora', time: new Date().toISOString() });
  }

  if (route === '/api/quotes') {
    const symbols = String(url.searchParams.get('symbols') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(assertSymbol);
    if (symbols.length === 0) throw new Error('Brak parametru symbols');
    if (symbols.length > 60) throw new Error('Zbyt wiele symboli (maks. 60)');

    const quotes = {};
    const errors = [];
    let tradingViewError = null;
    try {
      Object.assign(quotes, await getTradingViewQuotes(symbols));
    } catch (error) {
      tradingViewError = error;
    }
    await mapLimit(symbols.filter((symbol) => !quotes[symbol]), 5, async (symbol) => {
      try {
        quotes[symbol] = await getQuote(symbol);
      } catch (error) {
        errors.push({ symbol, message: error.message, scope: 'quote' });
      }
    });
    if (Object.keys(quotes).length === 0 && tradingViewError) {
      errors.push({ symbol: 'TradingView', message: tradingViewError.message, scope: 'quote' });
    }
    return sendJson(res, 200, { quotes, errors, fetchedAt: new Date().toISOString() });
  }

  if (route === '/api/history') {
    const symbol = assertSymbol(url.searchParams.get('symbol'));
    const from = assertIsoDate(url.searchParams.get('from') || '2000-01-01');
    return sendJson(res, 200, await getHistory(symbol, from));
  }

  if (route === '/api/histories') {
    const symbols = String(url.searchParams.get('symbols') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(assertSymbol);
    const from = assertIsoDate(url.searchParams.get('from') || '2000-01-01');
    if (symbols.length === 0) throw new Error('Brak parametru symbols');
    if (symbols.length > 60) throw new Error('Zbyt wiele symboli (maks. 60)');

    const histories = {};
    const errors = [];
    await mapLimit(symbols, 3, async (symbol) => {
      try {
        histories[symbol] = await getHistory(symbol, from);
      } catch (error) {
        errors.push({ symbol, message: error.message });
      }
    });
    return sendJson(res, 200, { histories, errors });
  }

  if (route === '/api/snapshot') {
    const symbols = String(url.searchParams.get('symbols') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(assertSymbol);
    const from = assertIsoDate(url.searchParams.get('from') || '2000-01-01');
    if (symbols.length === 0) throw new Error('Brak parametru symbols');
    if (symbols.length > 60) throw new Error('Zbyt wiele symboli (maks. 60)');
    return sendJson(res, 200, await getSnapshot(symbols, from));
  }

  if (route === '/api/splits') {
    const symbols = String(url.searchParams.get('symbols') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(assertSymbol);
    const from = assertIsoDate(url.searchParams.get('from') || '2000-01-01');
    if (symbols.length === 0) throw new Error('Brak parametru symbols');
    if (symbols.length > 60) throw new Error('Zbyt wiele symboli (maks. 60)');

    const splits = {};
    const errors = [];
    await mapLimit(symbols, 4, async (symbol) => {
      try {
        splits[symbol] = await getSplits(symbol, from);
      } catch (error) {
        errors.push({ symbol, message: error.message });
      }
    });
    return sendJson(res, 200, { splits, errors });
  }

  if (route === '/api/fx/latest') {
    return sendJson(res, 200, await getFxLatest());
  }

  if (route === '/api/fx/rate') {
    const currency = assertCurrency(url.searchParams.get('currency'));
    const date = assertIsoDate(url.searchParams.get('date'));
    return sendJson(res, 200, await getFxRate(currency, date));
  }

  if (route === '/api/fx/history') {
    const currency = assertCurrency(url.searchParams.get('currency'));
    const from = assertIsoDate(url.searchParams.get('from') || '2000-01-01');
    if (currency === 'PLN') {
      return sendJson(res, 200, { currency: 'PLN', dates: [], rates: [], fixed: 1 });
    }
    const history = await getHistory(`${currency}PLN=X`, from);
    return sendJson(res, 200, {
      currency,
      dates: history.dates,
      rates: history.closes,
      splits: history.splits,
    });
  }

  throw new Error(`Nieznany endpoint: ${route}`);
}

// ---------------------------------------------------------------------------
// Statyczne pliki
// ---------------------------------------------------------------------------

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  let baseDir = SITE_DIR;
  let relativePath = relative.replace(/^\/+/, '');

  if (relativePath.startsWith('data/reference/')) {
    baseDir = path.join(DATA_DIR, 'reference');
    relativePath = relativePath.slice('data/reference/'.length);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, relativePath);

  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  let stat;
  try {
    stat = await fsp.stat(resolvedFile);
    if (stat.isDirectory()) {
      resolvedFile = path.join(resolvedFile, 'index.html');
      stat = await fsp.stat(resolvedFile);
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  const ext = path.extname(resolvedFile).toLowerCase();
  const isVendor = relativePath.startsWith('vendor/');
  const cacheControl = isVendor
    ? 'public, max-age=604800'
    : ['.html', '.js', '.css', '.yaml', '.yml'].includes(ext)
      ? 'no-cache'
      : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': contentType(resolvedFile),
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(resolvedFile).pipe(res);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'Nieprawidłowy URL' });
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    console.error('[error]', req.method, url.pathname, '-', error.message);
    if (!res.headersSent) sendJson(res, 502, { error: error.message });
  } finally {
    console.log(`${req.method} ${url.pathname} ${Date.now() - started}ms`);
  }
});

server.listen(PORT, HOST, () => {
  fsp
    .mkdir(CACHE_DIR, { recursive: true })
    .then(() => cleanupCache())
    .catch(() => undefined);
  console.log(`Centrum Inwestora: http://localhost:${PORT}`);
  console.log(`Katalog cache: ${CACHE_DIR}`);
});
