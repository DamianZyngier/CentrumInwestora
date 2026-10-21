'use strict';

/**
 * Warstwa dostępu do danych: pliki referencyjne (YAML) + lokalne API rynkowe.
 *
 * Adres API można nadpisać w site/js/config.js (window.INVESTOR_CONFIG.apiBase).
 * Domyślnie API jest na tym samym originie co strona.
 */

const API = {
  base: ((window.INVESTOR_CONFIG && window.INVESTOR_CONFIG.apiBase) || '').replace(/\/+$/, ''),
  _health: null,
  _memory: new Map(),

  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    if (!this.base) return path;
    return `${this.base}/${path.replace(/^\/+/, '')}`;
  },

  async request(path, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url(path), {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body && body.error ? `: ${body.error}` : '';
        } catch {
          /* ignore */
        }
        throw new Error(`HTTP ${response.status}${detail}`);
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Przekroczono czas oczekiwania na API');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },

  async isAvailable() {
    if (this._health !== null) return this._health;
    try {
      const data = await this.request('/api/health', 5000);
      this._health = Boolean(data && data.ok);
    } catch {
      this._health = false;
    }
    return this._health;
  },

  // -------------------------------------------------------------------------
  // Pliki referencyjne
  // -------------------------------------------------------------------------

  async fetchYaml(path) {
    try {
      const response = await fetch(this.url(path), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (typeof jsyaml === 'undefined') throw new Error('Brak biblioteki js-yaml');
      return jsyaml.load(text);
    } catch (error) {
      console.error(`Nie udało się wczytać ${path}:`, error);
      return null;
    }
  },

  async getMapping() {
    const data = await this.fetchYaml('data/reference/instruments_mapping.yaml');
    return data || {};
  },

  async getTargets() {
    const data = await this.fetchYaml('data/reference/asset_classes.yaml');
    return (data && data.targets) || {};
  },

  async getSplitReference() {
    const data = await this.fetchYaml('data/reference/splits.yaml');
    return data || {};
  },

  // -------------------------------------------------------------------------
  // Notowania i waluty
  // -------------------------------------------------------------------------

  cacheKey(name) {
    return `investor:${name}:v2`;
  },

  cacheSet(name, value) {
    try {
      localStorage.setItem(this.cacheKey(name), JSON.stringify({ savedAt: Date.now(), value }));
    } catch {
      /* localStorage może być pełny / zablokowany */
    }
  },

  cacheGet(name, maxAgeMs) {
    try {
      const raw = localStorage.getItem(this.cacheKey(name));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.savedAt) return null;
      if (maxAgeMs && Date.now() - parsed.savedAt > maxAgeMs) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  async getMarketData(symbols) {
    const unique = [...new Set((symbols || []).filter(Boolean))];
    if (unique.length === 0) {
      return { quotes: {}, rates: { PLN: 1 }, errors: [], stale: false, available: false };
    }

    const available = await this.isAvailable();
    if (!available) {
      const cached = this.cacheGet('market', 7 * 24 * 60 * 60 * 1000);
      if (cached && cached.value) {
        return {
          ...cached.value,
          stale: true,
          available: false,
          error: 'Brak połączenia z lokalnym API - używam ostatnich zapisanych notowań.',
        };
      }
      return {
        quotes: {},
        rates: { PLN: 1 },
        errors: unique.map((symbol) => ({ symbol, message: 'Brak lokalnego API' })),
        stale: true,
        available: false,
        error: 'Brak połączenia z lokalnym API. Uruchom serwer (docker compose up -d).',
      };
    }

    try {
      const [quoteData, fxData] = await Promise.all([
        this.request(`/api/quotes?symbols=${encodeURIComponent(unique.join(','))}`, 45000),
        this.request('/api/fx/latest', 20000),
      ]);
      const payload = {
        quotes: quoteData.quotes || {},
        rates: { PLN: 1, ...(fxData.rates || {}) },
        errors: quoteData.errors || [],
        fxDate: fxData.date || null,
        fetchedAt: quoteData.fetchedAt || new Date().toISOString(),
        stale: false,
        available: true,
      };
      this.cacheSet('market', payload);
      return payload;
    } catch (error) {
      const cached = this.cacheGet('market', 7 * 24 * 60 * 60 * 1000);
      if (cached && cached.value) {
        return {
          ...cached.value,
          stale: true,
          available: true,
          error: `Błąd API: ${error.message}. Używam ostatnich zapisanych notowań.`,
        };
      }
      return {
        quotes: {},
        rates: { PLN: 1 },
        errors: unique.map((symbol) => ({ symbol, message: error.message })),
        stale: true,
        available: true,
        error: `Błąd API: ${error.message}`,
      };
    }
  },

  async getSnapshot(symbols, fromIso) {
    const unique = [...new Set((symbols || []).filter(Boolean))];
    const referenceSplits = await this.getSplitReference();

    if (unique.length === 0) {
      return {
        quotes: {},
        rates: { PLN: 1 },
        histories: {},
        splits: referenceSplits,
        errors: [],
        fetchedAt: null,
        stale: false,
        available: false,
      };
    }

    const mergeSplits = (serverSplits) =>
      typeof Processor !== 'undefined' && Processor.mergeSplits
        ? Processor.mergeSplits(serverSplits || {}, referenceSplits)
        : { ...referenceSplits, ...(serverSplits || {}) };

    if (!(await this.isAvailable())) {
      return this.fallbackSnapshot(
        unique,
        mergeSplits({}),
        'Brak połączenia z lokalnym API. Uruchom serwer: docker compose up -d.'
      );
    }

    try {
      const data = await this.request(
        `/api/snapshot?symbols=${encodeURIComponent(unique.join(','))}&from=${encodeURIComponent(fromIso)}`,
        180000
      );
      const payload = {
        quotes: data.quotes || {},
        rates: { PLN: 1, ...(data.rates || {}) },
        histories: data.histories || {},
        splits: mergeSplits(data.splits),
        errors: data.errors || [],
        fxDate: data.fxDate || null,
        fetchedAt: data.fetchedAt || new Date().toISOString(),
        stale: false,
        available: true,
      };

      // Jeśli Yahoo zawiedzie tylko dla części symboli, uzupełnij brakujące
      // notowania z ostatniego udanego pobrania (max 7 dni).
      const cached = this.cacheGet('market', 7 * 24 * 60 * 60 * 1000);
      let usedCache = false;
      if (cached && cached.value) {
        const cachedQuotes = cached.value.quotes || {};
        for (const [symbol, quote] of Object.entries(cachedQuotes)) {
          if (!unique.includes(symbol) || payload.quotes[symbol] || !quote) continue;
          const marketTime = quote.marketTime ? Date.parse(quote.marketTime) : 0;
          // Nie podawaj bardzo starych notowań jako aktualnych.
          if (!marketTime || Date.now() - marketTime > 14 * 24 * 60 * 60 * 1000) continue;
          payload.quotes[symbol] = quote;
          usedCache = true;
        }
        const cachedRates = cached.value.rates || {};
        for (const [currency, rate] of Object.entries(cachedRates)) {
          if (payload.rates[currency] == null) {
            payload.rates[currency] = rate;
            usedCache = true;
          }
        }
      }
      if (usedCache) payload.stale = true;

      this.cacheSet('market', {
        quotes: payload.quotes,
        rates: payload.rates,
        fxDate: payload.fxDate,
        fetchedAt: payload.fetchedAt,
      });
      return payload;
    } catch (error) {
      return this.fallbackSnapshot(
        unique,
        mergeSplits({}),
        `Błąd API: ${error.message}. Używam ostatnich zapisanych notowań.`
      );
    }
  },

  fallbackSnapshot(symbols, splits, message) {
    const cached = this.cacheGet('market', 7 * 24 * 60 * 60 * 1000);
    const quotes = (cached && cached.value && cached.value.quotes) || {};
    const rates = (cached && cached.value && cached.value.rates) || { PLN: 1 };
    return {
      quotes,
      rates,
      histories: {},
      splits,
      errors: symbols
        .filter((symbol) => !quotes[symbol])
        .map((symbol) => ({ symbol, message })),
      fetchedAt: cached && cached.value ? cached.value.fetchedAt : null,
      stale: Boolean(cached),
      available: false,
      error: message,
    };
  },

  async getSplits(symbols, fromIso) {
    const unique = [...new Set((symbols || []).filter(Boolean))];
    const reference = await this.getSplitReference();
    const merged = { ...reference };
    if (unique.length === 0 || !(await this.isAvailable())) return merged;

    try {
      const data = await this.request(
        `/api/splits?symbols=${encodeURIComponent(unique.join(','))}&from=${encodeURIComponent(fromIso)}`,
        60000
      );
      for (const [symbol, splits] of Object.entries(data.splits || {})) {
        merged[symbol] = splits;
      }
    } catch (error) {
      console.warn('Nie udało się pobrać splitów z API:', error.message);
    }
    return merged;
  },

  async getHistories(symbols, fromIso) {
    const unique = [...new Set((symbols || []).filter(Boolean))];
    if (unique.length === 0 || !(await this.isAvailable())) return null;
    try {
      const data = await this.request(
        `/api/histories?symbols=${encodeURIComponent(unique.join(','))}&from=${encodeURIComponent(fromIso)}`,
        120000
      );
      return { histories: data.histories || {}, errors: data.errors || [] };
    } catch (error) {
      console.warn('Nie udało się pobrać historii notowań:', error.message);
      return null;
    }
  },

  async getFxHistories(currencies, fromIso) {
    const unique = [...new Set((currencies || []).filter((currency) => currency && currency !== 'PLN'))];
    const result = {};
    if (unique.length === 0 || !(await this.isAvailable())) return result;

    await this.mapLimit(unique, 3, async (currency) => {
      try {
        const data = await this.request(
          `/api/fx/history?currency=${encodeURIComponent(currency)}&from=${encodeURIComponent(fromIso)}`,
          60000
        );
        result[currency] = data;
      } catch (error) {
        console.warn(`Nie udało się pobrać historii ${currency}PLN:`, error.message);
      }
    });
    return result;
  },

  async getFxRate(currency, dateIso) {
    if (currency === 'PLN') return { currency, date: dateIso, rate: 1, source: 'stały' };
    if (await this.isAvailable()) {
      try {
        return await this.request(
          `/api/fx/rate?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(dateIso)}`,
          25000
        );
      } catch (error) {
        console.warn(`Brak kursu NBP ${currency}/${dateIso}:`, error.message);
      }
    }
    const cached = this.cacheGet('market', 7 * 24 * 60 * 60 * 1000);
    let fallback = cached && cached.value && cached.value.rates ? cached.value.rates[currency] : null;
    if (!fallback && (await this.isAvailable())) {
      try {
        const fx = await this.request('/api/fx/latest', 20000);
        fallback = fx && fx.rates ? fx.rates[currency] : null;
      } catch {
        fallback = null;
      }
    }
    if (fallback) {
      return {
        currency,
        date: dateIso,
        rate: fallback,
        source: 'kurs bieżący (fallback)',
        estimated: true,
      };
    }
    throw new Error(`Brak kursu ${currency} dla ${dateIso}`);
  },

  // -------------------------------------------------------------------------
  // Instrumenty
  // -------------------------------------------------------------------------

  symbolFor(walor, mapping, gielda) {
    const meta = mapping && mapping[walor];
    if (meta && meta.yahoo_symbol) return meta.yahoo_symbol;
    const suffixMap = {
      WWA: '.WA',
      DEU: '.DE',
      XETR: '.DE',
      LON: '.L',
      LSE: '.L',
      FRA: '.F',
      PAR: '.PA',
      AMS: '.AS',
      MIL: '.MI',
      MAD: '.MC',
    };
    const ticker = String(walor || '').trim().split(/\s+/)[0].toUpperCase();
    if (!ticker) return '';
    return ticker + (suffixMap[String(gielda || '').toUpperCase()] || '');
  },

  async mapLimit(items, limit, fn) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await fn(items[index], index);
      }
    });
    await Promise.all(workers);
  },
};

window.API = API;
