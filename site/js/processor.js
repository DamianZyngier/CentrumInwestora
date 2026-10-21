'use strict';

/**
 * Logika biznesowa: parsowanie CSV, kursy walut, splity i metryki portfela.
 *
 * Obsługiwane formaty:
 *  1) "orders"       - historia zleceń Bossa (Stan;Walor;Giełda;K/S;Liczba;Liczba zreal;Limit;...)
 *  2) "transactions" - potwierdzenia transakcji (Walor;Giełda;K/S;Liczba;Kurs;Waluta;Wartość;Prowizja;...)
 *
 * Plik jest ładowany i w przeglądarce, i w testach Node (module.exports na końcu).
 */

const Processor = {
  EPSILON: 0.0001,

  // -------------------------------------------------------------------------
  // Wejście / CSV
  // -------------------------------------------------------------------------

  async readFileText(file) {
    if (file.size > 15 * 1024 * 1024) {
      throw new Error('Plik jest zbyt duży (limit 15 MB).');
    }
    const buffer = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buffer);
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('windows-1250').decode(buffer);
      } catch {
        /* zostawiamy UTF-8 */
      }
    }
    return text.replace(/^\uFEFF/, '');
  },

  async parseFile(file, options = {}) {
    const text = await this.readFileText(file);
    return this.parseText(text, file.name, options);
  },

  parseText(text, fileName = 'plik.csv', options = {}) {
    const clean = String(text || '').replace(/^\uFEFF/, '');
    const rows = this.parseDelimited(clean, this.detectDelimiter(clean));
    if (rows.length === 0) throw new Error('Plik jest pusty.');

    const headers = rows[0].map((header) => String(header).trim());
    const records = [];
    for (let i = 1; i < rows.length; i += 1) {
      const values = rows[i];
      if (!values || values.every((value) => String(value).trim() === '')) continue;
      const record = {};
      headers.forEach((header, index) => {
        record[header] = values[index] !== undefined ? String(values[index]).trim() : '';
      });
      records.push(record);
    }

    const format = this.detectFormat(headers);
    const result =
      format === 'orders'
        ? this.parseOrderRows(records, headers, options)
        : this.parseTransactionRows(records, headers);

    result.format = format;
    result.fileName = fileName;
    return result;
  },

  detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const candidates = [';', '\t', ','];
    let best = ';';
    let bestCount = -1;
    for (const delimiter of candidates) {
      const count = firstLine.split(delimiter).length - 1;
      if (count > bestCount) {
        bestCount = count;
        best = delimiter;
      }
    }
    return best;
  },

  parseDelimited(text, delimiter = ';') {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        row.push(field);
        field = '';
      } else if (char === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (char !== '\r') {
        field += char;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  },

  detectFormat(headers) {
    const has = (name) => headers.includes(name);
    if (has('Stan') && has('Liczba zreal') && has('Limit')) return 'orders';
    if (has('Walor') && has('K/S') && (has('Wartość') || has('Kurs') || has('Czas transakcji'))) {
      return 'transactions';
    }
    throw new Error(
      'Nierozpoznany format pliku. Obsługiwane są eksporty: historia zleceń (kolumny Stan, Liczba zreal, Limit) ' +
        'oraz historia transakcji (kolumny Walor, K/S, Kurs/Wartość).'
    );
  },

  parseOrderRows(records, headers, options) {
    const skipped = [];
    const warnings = [];
    const transactions = [];
    const seen = new Set();
    const commissionPct = Number(options.commissionPct || 0);

    const required = ['Walor', 'K/S', 'Liczba zreal', 'Limit', 'Waluta'];
    for (const column of required) {
      if (!headers.includes(column)) {
        throw new Error(`Brak wymaganej kolumny "${column}" w eksporcie zleceń.`);
      }
    }

    records.forEach((row, index) => {
      const line = index + 2;
      const status = String(row['Stan'] || '').trim();
      const normalizedStatus = status.toLocaleLowerCase('pl-PL');
      // "Niezrealizowane" zawiera "zrealizowane", dlatego jawnie wykluczamy "nie...".
      if (!/zrealizowan/.test(normalizedStatus) || /^nie/.test(normalizedStatus)) {
        skipped.push({ line, reason: `status: ${status || 'brak'}`, walor: row['Walor'] || '' });
        return;
      }
      const side = this.normalizeSide(row['K/S']);
      if (!side) {
        skipped.push({ line, reason: `nieznany kierunek: ${row['K/S'] || 'brak'}`, walor: row['Walor'] || '' });
        return;
      }
      const quantity = this.parseNumber(row['Liczba zreal']);
      if (!(quantity > 0)) {
        skipped.push({ line, reason: 'liczba zrealizowana = 0', walor: row['Walor'] || '' });
        return;
      }
      const price = this.parseNumber(row['Limit']);
      if (!(price > 0)) {
        skipped.push({ line, reason: 'brak ceny (Limit = 0)', walor: row['Walor'] || '' });
        return;
      }
      const walor = String(row['Walor'] || '').trim();
      if (!walor) {
        skipped.push({ line, reason: 'brak nazwy waloru' });
        return;
      }
      const dateRaw =
        row['Data realizacji'] ||
        row['Data transakcji'] ||
        row['Czas transakcji'] ||
        row['Data ważności'] ||
        '';
      const dateParts = this.parseDateParts(dateRaw);
      if (!dateParts) {
        skipped.push({ line, reason: `nieprawidłowa data: ${dateRaw || 'brak'}`, walor });
        return;
      }

      const currency = String(row['Waluta'] || 'PLN').trim().toUpperCase();
      const valueOriginal = quantity * price;
      const feeOriginal = commissionPct > 0 ? (valueOriginal * commissionPct) / 100 : 0;

      const transaction = this.buildTransaction({
        walor,
        exchange: String(row['Giełda'] || '').trim().toUpperCase(),
        side,
        quantity,
        price,
        currency,
        valueOriginal,
        feeOriginal,
        dateRaw,
        dateParts,
        settlementCurrency: String(row['Waluta rozliczenia'] || 'PLN').trim().toUpperCase() || 'PLN',
        fxFixed: null,
        sourceFormat: 'orders',
        orderType: String(row['Typ ważności'] || '').trim(),
      });

      if (seen.has(transaction.key)) {
        skipped.push({ line, reason: 'duplikat w pliku', walor });
        return;
      }
      seen.add(transaction.key);
      transactions.push(transaction);
    });

    if (commissionPct > 0) {
      warnings.push(`Do zleceń doliczono prowizję ${commissionPct}% (plik nie zawiera prowizji).`);
    } else {
      warnings.push('Eksport zleceń nie zawiera prowizji - zysk może być zawyżony.');
    }
    warnings.push('Ceną transakcji jest kurs zlecenia (Limit), a nie rzeczywista cena realizacji.');

    return { transactions, skipped, warnings };
  },

  parseTransactionRows(records, headers) {
    const skipped = [];
    const warnings = [];
    const transactions = [];
    const seen = new Set();

    if (!headers.includes('Walor') || !headers.includes('K/S')) {
      throw new Error('Brak wymaganych kolumn "Walor" i "K/S" w eksporcie transakcji.');
    }

    records.forEach((row, index) => {
      const line = index + 2;
      const walor = String(row['Walor'] || '').trim();
      if (!walor) {
        skipped.push({ line, reason: 'brak nazwy waloru' });
        return;
      }
      const side = this.normalizeSide(row['K/S']);
      if (!side) {
        skipped.push({ line, reason: `nieznany kierunek: ${row['K/S'] || 'brak'}`, walor });
        return;
      }
      const quantity = this.parseNumber(row['Liczba']);
      if (!(quantity > 0)) {
        skipped.push({ line, reason: 'liczba = 0', walor });
        return;
      }
      const price = this.parseNumber(row['Kurs']);
      const hasValue = row['Wartość'] !== undefined && String(row['Wartość']).trim() !== '';
      const valueOriginal = hasValue ? this.parseNumber(row['Wartość']) : quantity * price;
      const feeOriginal = this.parseNumber(row['Prowizja']);
      const dateRaw = row['Czas transakcji'] || row['Data transakcji'] || row['Data'] || '';
      const dateParts = this.parseDateParts(dateRaw);
      if (!dateParts) {
        skipped.push({ line, reason: `nieprawidłowa data: ${dateRaw || 'brak'}`, walor });
        return;
      }
      const currency = String(row['Waluta'] || 'PLN').trim().toUpperCase();
      let fxFixed = this.parseNumber(row['Kurs Przewalutowania']);
      const settlementCurrency = String(row['Waluta rozliczenia'] || 'PLN').trim().toUpperCase() || 'PLN';
      if (currency === 'PLN' && fxFixed === 0) fxFixed = 1;
      if (currency !== 'PLN' && fxFixed === 0) fxFixed = null;

      const transaction = this.buildTransaction({
        walor,
        exchange: String(row['Giełda'] || '').trim().toUpperCase(),
        side,
        quantity,
        price,
        currency,
        valueOriginal,
        feeOriginal,
        dateRaw,
        dateParts,
        settlementCurrency,
        fxFixed,
        sourceFormat: 'transactions',
        orderType: '',
      });

      if (seen.has(transaction.key)) {
        skipped.push({ line, reason: 'duplikat w pliku', walor });
        return;
      }
      seen.add(transaction.key);
      transactions.push(transaction);
    });

    return { transactions, skipped, warnings };
  },

  buildTransaction(input) {
    const dateIso = this.toIsoDate(input.dateParts);
    const quantity = input.quantity;
    const price = input.price;
    const key = this.buildKey({
      walor: input.walor,
      gielda: input.exchange,
      ks: input.side,
      liczba: quantity,
      kurs: price,
      waluta: input.currency,
      date_iso: dateIso,
    });

    return {
      key,
      walor: input.walor,
      gielda: input.exchange,
      ks: this.normalizeSide(input.side),
      liczba: quantity,
      kurs: price,
      waluta: input.currency,
      wartosc_oryginalna: input.valueOriginal,
      prowizja_oryginalna: input.feeOriginal,
      data: String(input.dateRaw || '').trim(),
      date_iso: dateIso,
      timestamp: Date.UTC(
        input.dateParts.year,
        input.dateParts.month - 1,
        input.dateParts.day,
        input.dateParts.hour,
        input.dateParts.minute,
        input.dateParts.second
      ),
      waluta_rozliczenia: input.settlementCurrency,
      kurs_przewalutowania: input.fxFixed,
      fx_fixed: input.fxFixed,
      value_pln: null,
      fee_pln: null,
      cash_flow_pln: null,
      source_format: input.sourceFormat,
      order_type: input.orderType,
      imported_at: new Date().toISOString(),
    };
  },

  buildKey(transaction) {
    const dateIso =
      transaction.date_iso ||
      (transaction.timestamp ? new Date(transaction.timestamp).toISOString().slice(0, 10) : '');
    return [
      transaction.walor || '',
      transaction.gielda || '',
      this.normalizeSide(transaction.ks),
      Number(transaction.liczba || 0).toFixed(6),
      Number(transaction.kurs || 0).toFixed(6),
      String(transaction.waluta || 'PLN').toUpperCase(),
      dateIso,
    ].join('|');
  },

  keyFromTransaction(transaction) {
    return transaction.key || this.buildKey(transaction);
  },

  normalizeSide(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (/sprzeda|^s$|^sell/.test(value)) return 'Sprzedaż';
    if (/kup|^k$|^buy/.test(value)) return 'Kupno';
    return null;
  },

  // -------------------------------------------------------------------------
  // Liczby i daty
  // -------------------------------------------------------------------------

  parseNumber(value) {
    if (value === null || value === undefined) return 0;
    let text = String(value).trim();
    if (!text) return 0;
    text = text.replace(/\s|'/g, '');
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) {
        text = text.replace(/\./g, '').replace(',', '.');
      } else {
        text = text.replace(/,/g, '');
      }
    } else if (lastComma > -1) {
      text = text.replace(',', '.');
    }
    const number = Number.parseFloat(text);
    return Number.isFinite(number) ? number : 0;
  },

  parseDateParts(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    let match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      return {
        year: Number(match[3]),
        month: Number(match[2]),
        day: Number(match[1]),
        hour: Number(match[4] || 0),
        minute: Number(match[5] || 0),
        second: Number(match[6] || 0),
      };
    }
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4] || 0),
        minute: Number(match[5] || 0),
        second: Number(match[6] || 0),
      };
    }
    return null;
  },

  toIsoDate(parts) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  },

  // -------------------------------------------------------------------------
  // Kursy walut
  // -------------------------------------------------------------------------

  async applyFx(transactions, provider, onProgress) {
    const pairs = new Map();
    for (const transaction of transactions) {
      if (transaction.fx_fixed !== null && transaction.fx_fixed !== undefined) {
        transaction.kurs_przewalutowania = transaction.fx_fixed;
        transaction.fx_source = 'z pliku';
      } else if (transaction.waluta === 'PLN') {
        transaction.kurs_przewalutowania = 1;
        transaction.fx_source = 'stały';
      } else {
        const key = `${transaction.waluta}|${transaction.date_iso}`;
        if (!pairs.has(key)) pairs.set(key, null);
        transaction.__fxKey = key;
      }
    }

    const keys = [...pairs.keys()];
    let done = 0;
    for (const key of keys) {
      const [currency, date] = key.split('|');
      try {
        pairs.set(key, await provider(currency, date));
      } catch (error) {
        pairs.set(key, { rate: null, error: error.message });
      }
      done += 1;
      if (onProgress) onProgress(done, keys.length);
    }

    for (const transaction of transactions) {
      if (transaction.__fxKey) {
        const resolved = pairs.get(transaction.__fxKey);
        if (resolved && resolved.rate != null) {
          transaction.kurs_przewalutowania = resolved.rate;
          transaction.fx_source = resolved.source || 'NBP';
          transaction.fx_date = resolved.date || transaction.date_iso;
          transaction.fx_estimated = Boolean(resolved.estimated);
        } else {
          transaction.kurs_przewalutowania = null;
          transaction.fx_error = (resolved && resolved.error) || 'brak kursu';
        }
        delete transaction.__fxKey;
      }

      if (transaction.kurs_przewalutowania == null) {
        transaction.value_pln = null;
        transaction.fee_pln = null;
        transaction.cash_flow_pln = null;
        continue;
      }
      transaction.value_pln = transaction.wartosc_oryginalna * transaction.kurs_przewalutowania;
      transaction.fee_pln = transaction.prowizja_oryginalna * transaction.kurs_przewalutowania;
      transaction.cash_flow_pln =
        transaction.ks === 'Kupno'
          ? -(transaction.value_pln + transaction.fee_pln)
          : transaction.value_pln - transaction.fee_pln;
    }
    return transactions;
  },

  // -------------------------------------------------------------------------
  // Splity
  // -------------------------------------------------------------------------

  /**
   * Doprowadza liczbę jednostek do aktualnej skali (po splitach).
   * Cena jednostkowa jest dzielona przez ten sam współczynnik, więc wartość
   * transakcji i koszt bazowy pozostają bez zmian.
   */
  applySplits(transactions, splitsBySymbol) {
    for (const transaction of transactions) {
      if (transaction.liczba_bazowa === undefined) {
        transaction.liczba_bazowa = transaction.liczba;
        transaction.kurs_bazowy = transaction.kurs;
      }
      const splits = (splitsBySymbol && splitsBySymbol[transaction.symbol]) || [];
      let factor = 1;
      for (const split of splits) {
        if (split.date > transaction.date_iso) factor *= split.ratio;
      }
      transaction.split_factor = factor;
      transaction.liczba = transaction.liczba_bazowa * factor;
      transaction.kurs = transaction.kurs_bazowy / factor;
    }
    return transactions;
  },

  mergeSplits(primary, fallback) {
    const merged = {};
    for (const source of [fallback || {}, primary || {}]) {
      for (const [symbol, splits] of Object.entries(source)) {
        const map = new Map((merged[symbol] || []).map((split) => [split.date, split]));
        for (const split of splits || []) {
          const ratio = Number(split.ratio);
          if (split.date && Number.isFinite(ratio) && ratio > 0) {
            map.set(split.date, { date: split.date, ratio });
          }
        }
        merged[symbol] = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
      }
    }
    return merged;
  },

  // -------------------------------------------------------------------------
  // Metryki
  // -------------------------------------------------------------------------

  calculateMetrics(transactions, mapping, quotes, fxRates) {
    const sorted = [...transactions].sort(
      (a, b) =>
        (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) ||
        String(a.key).localeCompare(String(b.key))
    );
    const positions = new Map();
    const warnings = [];

    for (const transaction of sorted) {
      const walor = transaction.walor;
      if (!positions.has(walor)) {
        positions.set(walor, {
          walor,
          units: 0,
          cost_basis_pln: 0,
          realized_pl_pln: 0,
          invested_pln: 0,
          withdrawn_pln: 0,
          buy_count: 0,
          sell_count: 0,
          last_transaction: transaction.date_iso,
        });
      }
      const position = positions.get(walor);
      position.last_transaction = transaction.date_iso;

      if (transaction.value_pln == null) {
        warnings.push(`${walor}: brak kursu walutowy dla ${transaction.date_iso} - transakcja pominięta w wycenie.`);
        continue;
      }

      if (transaction.ks === 'Kupno') {
        position.units += transaction.liczba;
        position.cost_basis_pln += transaction.value_pln + transaction.fee_pln;
        position.invested_pln += transaction.value_pln + transaction.fee_pln;
        position.buy_count += 1;
      } else {
        if (position.units <= this.EPSILON) {
          warnings.push(
            `${walor}: sprzedaż ${transaction.liczba} szt. w dniu ${transaction.date_iso}, ale brak posiadanych jednostek.`
          );
          position.sell_count += 1;
          // Same wpływy są realną gotówką, ale bez historii zakupu nie da się
          // policzyć zysku zrealizowanego - liczymy je tylko jako wypłatę.
          position.withdrawn_pln += transaction.value_pln - transaction.fee_pln;
          continue;
        }
        if (transaction.liczba > position.units + this.EPSILON) {
          warnings.push(
            `${walor}: sprzedaż ${transaction.liczba} szt. przekracza posiadane ${position.units.toFixed(4)} szt. (${transaction.date_iso}).`
          );
        }
        const soldUnits = Math.min(transaction.liczba, position.units);
        const averageCost = position.cost_basis_pln / position.units;
        const costOfSold = averageCost * soldUnits;
        const proceeds = transaction.value_pln - transaction.fee_pln;

        position.realized_pl_pln += proceeds - costOfSold;
        position.units -= soldUnits;
        position.cost_basis_pln -= costOfSold;
        position.withdrawn_pln += proceeds;
        position.sell_count += 1;
      }
    }

    const portfolio = [];
    const structure = {};
    const missingQuotes = [];
    let totalValue = 0;
    let totalCostBasis = 0;
    let valuedCostBasis = 0;
    let totalRealized = 0;
    let totalInvested = 0;
    let totalWithdrawn = 0;
    let complete = true;

    const estimatedFx = sorted.filter((transaction) => transaction.fx_estimated).length;
    if (estimatedFx > 0) {
      warnings.unshift(
        `${estimatedFx} transakcji używa przybliżonego kursu walutowego (bieżący zamiast historycznego NBP) - koszt i zysk mogą być istotnie zawyżone lub zaniżone.`
      );
    }

    for (const position of positions.values()) {
      totalRealized += position.realized_pl_pln;
      totalInvested += position.invested_pln;
      totalWithdrawn += position.withdrawn_pln;

      const isOpen = position.units > this.EPSILON;
      if (!isOpen) {
        continue;
      }

      const meta = mapping[position.walor] || {};
      const symbol = meta.yahoo_symbol || position.walor;
      const quote = quotes ? quotes[symbol] : null;
      const assetClass = meta.asset_class || 'Other';
      const avgCost = position.cost_basis_pln / position.units;

      let price = null;
      let pricePln = null;
      let value = null;
      let unrealized = null;
      let weight = null;
      let fxRate = null;

      const currency = (quote && quote.currency) || meta.currency || 'PLN';
      const rawRate = currency === 'PLN' ? 1 : fxRates ? fxRates[currency] : null;
      const hasFxRate = rawRate != null && Number.isFinite(Number(rawRate));

      if (quote && Number.isFinite(Number(quote.price)) && hasFxRate) {
        fxRate = Number(rawRate);
        price = Number(quote.price);
        pricePln = price * fxRate;
        value = position.units * pricePln;
        unrealized = value - position.cost_basis_pln;
        totalValue += value;
        valuedCostBasis += position.cost_basis_pln;
      } else {
        missingQuotes.push({
          walor: position.walor,
          symbol,
          reason:
            !quote || !Number.isFinite(Number(quote.price))
              ? 'brak notowania'
              : `brak kursu ${currency}`,
        });
        complete = false;
      }

      totalCostBasis += position.cost_basis_pln;

      portfolio.push({
        walor: position.walor,
        symbol,
        name: (quote && quote.name) || meta.name || position.walor,
        gielda: meta.exchange || '',
        currency,
        asset_class: assetClass,
        region: meta.region || '',
        units: position.units,
        avg_cost_pln: avgCost,
        price,
        price_pln: pricePln,
        fx_rate: fxRate,
        value_pln: value,
        unrealized_pl_pln: unrealized,
        realized_pl_pln: position.realized_pl_pln,
        weight,
        split_factor: 1,
        market_time: quote ? quote.marketTime : null,
        quote_missing: value == null,
      });
    }

    for (const item of portfolio) {
      if (item.value_pln != null && totalValue > 0) {
        item.weight = item.value_pln / totalValue;
        structure[item.asset_class] = (structure[item.asset_class] || 0) + item.weight;
      }
      const transaction = sorted.find(
        (t) => t.walor === item.walor && t.split_factor && t.split_factor !== 1
      );
      if (transaction) item.split_factor = transaction.split_factor;
    }

    portfolio.sort((a, b) => (b.value_pln || 0) - (a.value_pln || 0));

    const unrealized = totalValue - valuedCostBasis;
    const totalPl = unrealized + totalRealized;
    const totalPlPct = totalInvested > 0 ? (totalPl / totalInvested) * 100 : 0;

    return {
      summary: {
        total_value_pln: totalValue,
        cost_basis_pln: totalCostBasis,
        valued_cost_basis_pln: valuedCostBasis,
        invested_pln: totalInvested,
        withdrawn_pln: totalWithdrawn,
        net_invested_pln: totalInvested - totalWithdrawn,
        realized_pl_pln: totalRealized,
        unrealized_pl_pln: unrealized,
        total_pl_pln: totalPl,
        total_pl_pct: totalPlPct,
        positions_count: portfolio.length,
        valuation_complete: complete,
        missing_quotes: missingQuotes,
        last_updated: new Date().toLocaleString('pl-PL'),
      },
      portfolio_list: portfolio,
      struct_asset: structure,
      warnings,
    };
  },

  // -------------------------------------------------------------------------
  // Szeregi czasowe
  // -------------------------------------------------------------------------

  buildInvestedSeries(transactions) {
    const daily = new Map();
    for (const transaction of transactions) {
      if (transaction.cash_flow_pln == null) continue;
      daily.set(transaction.date_iso, (daily.get(transaction.date_iso) || 0) + transaction.cash_flow_pln);
    }
    const cashDates = [...daily.keys()].sort();
    if (cashDates.length === 0) return { dates: [], invested_pln: [] };

    // Serie dzienne do dziś, aby zakresy 1m/3m/1r nie były puste przy braku
    // nowych transakcji - ostatnia wartość jest przenoszona do przodu.
    const endDate = new Date().toISOString().slice(0, 10);
    const dates = [];
    const invested = [];
    let cumulative = 0;
    for (let day = cashDates[0]; day <= endDate; day = this.addDays(day, 1)) {
      if (daily.has(day)) cumulative += daily.get(day);
      dates.push(day);
      invested.push(-cumulative);
    }
    return { dates, invested_pln: invested };
  },

  /**
   * Buduje historię wartości portfela na podstawie dziennych zamknięć i kursów walut.
   * histories: { symbol: { dates: [], closes: [], currency } }
   * fxHistories: { USD: { dates: [], rates: [] }, ... }
   */
  buildPortfolioSeries(transactions, histories, fxHistories, options = {}) {
    const fallbackRates = options.fallbackRates || { PLN: 1 };
    const usableTransactions = transactions.filter((t) => t.value_pln != null);
    if (usableTransactions.length === 0) return null;

    const startDate = usableTransactions.map((t) => t.date_iso).sort()[0];
    const endDate = new Date().toISOString().slice(0, 10);
    const dates = [];
    for (let day = startDate; day <= endDate; day = this.addDays(day, 1)) {
      dates.push(day);
    }

    const transactionsByDate = new Map();
    for (const transaction of usableTransactions) {
      if (!transactionsByDate.has(transaction.date_iso)) {
        transactionsByDate.set(transaction.date_iso, []);
      }
      transactionsByDate.get(transaction.date_iso).push(transaction);
    }

    const series = new Map();
    const missing = new Set();
    for (const transaction of usableTransactions) {
      const symbol = transaction.symbol;
      if (!symbol || series.has(symbol)) continue;
      const history = histories && histories[symbol];
      if (!history || !history.dates || history.dates.length === 0) {
        missing.add(symbol);
        continue;
      }
      series.set(symbol, {
        dates: history.dates,
        closes: history.closes,
        currency: history.currency || 'PLN',
        index: 0,
        lastClose: null,
        lastIndex: -1,
      });
    }

    const fxSeries = new Map();
    for (const [currency, history] of Object.entries(fxHistories || {})) {
      if (currency === 'PLN') continue;
      if (!history || !history.dates || history.dates.length === 0) continue;
      fxSeries.set(currency, {
        dates: history.dates,
        rates: history.rates,
        index: 0,
        lastRate: null,
        lastIndex: -1,
      });
    }

    const units = new Map();
    const investedSeries = this.buildInvestedSeries(usableTransactions);
    const investedByDate = new Map(
      investedSeries.dates.map((date, index) => [date, investedSeries.invested_pln[index]])
    );
    let lastInvested = 0;

    const values = [];
    const investedValues = [];
    let incomplete = missing.size > 0;

    for (const day of dates) {
      const todays = transactionsByDate.get(day) || [];
      for (const transaction of todays) {
        if (!series.has(transaction.symbol)) continue;
        const current = units.get(transaction.symbol) || 0;
        units.set(
          transaction.symbol,
          transaction.ks === 'Kupno' ? current + transaction.liczba : current - transaction.liczba
        );
      }

      let dayValue = 0;
      for (const [symbol, state] of series) {
        const position = units.get(symbol) || 0;
        if (Math.abs(position) < this.EPSILON) continue;

        while (state.index + 1 < state.dates.length && state.dates[state.index + 1] <= day) {
          state.index += 1;
        }
        if (state.dates[state.index] <= day) {
          state.lastClose = state.closes[state.index];
        }
        if (state.lastClose == null) {
          incomplete = true;
          continue;
        }

        let fx = 1;
        if (state.currency !== 'PLN') {
          const fxState = fxSeries.get(state.currency);
          if (fxState) {
            while (fxState.index + 1 < fxState.dates.length && fxState.dates[fxState.index + 1] <= day) {
              fxState.index += 1;
            }
            if (fxState.dates[fxState.index] <= day) {
              fxState.lastRate = fxState.rates[fxState.index];
            }
            if (fxState.lastRate != null) {
              fx = fxState.lastRate;
            } else {
              fx = fallbackRates[state.currency] || 1;
              incomplete = true;
            }
          } else {
            fx = fallbackRates[state.currency] || 1;
            incomplete = true;
          }
        }

        dayValue += position * state.lastClose * fx;
      }

      if (investedByDate.has(day)) lastInvested = investedByDate.get(day);
      values.push(dayValue);
      investedValues.push(lastInvested);
    }

    return {
      dates,
      invested_pln: investedValues,
      portfolio_value_pln: values,
      incomplete,
      missing_symbols: [...missing],
      mode: 'valuation',
    };
  },

  addDays(iso, days) {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  },

  // -------------------------------------------------------------------------
  // Rekomendacje
  // -------------------------------------------------------------------------

  buildRecommendations(structure, targets, portfolio, threshold = 0.05) {
    const items = [];
    for (const [assetClass, target] of Object.entries(targets || {})) {
      const current = structure[assetClass] || 0;
      const difference = current - target;
      if (difference < -threshold) {
        items.push({
          type: 'NIEDOWAGA',
          category: assetClass,
          current,
          target,
          message: `Kategoria "${assetClass}" jest niedoważona o ${Math.abs(difference * 100).toFixed(1)} p.p.`,
        });
      } else if (difference > threshold) {
        items.push({
          type: 'PRZEWAGA',
          category: assetClass,
          current,
          target,
          message: `Kategoria "${assetClass}" jest przeważona o ${(difference * 100).toFixed(1)} p.p.`,
        });
      }
    }
    for (const item of portfolio || []) {
      if (item.weight != null && item.weight > 0.2) {
        items.push({
          type: 'KONCENTRACJA',
          category: item.walor,
          current: item.weight,
          target: 0.2,
          message: `Walor "${item.walor}" to ${(item.weight * 100).toFixed(1)}% portfela - ryzyko koncentracji.`,
        });
      }
    }
    return items;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Processor;
}
