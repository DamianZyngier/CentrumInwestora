'use strict';

let refreshing = false;
let refreshQueued = false;
let currentRange = 'all';
let currentTimeseries = null;
let currentMapping = {};
let currentTargets = {};

function plural(count, one, few, many) {
  const abs = Math.abs(Number(count) || 0);
  if (abs === 1) return one;
  const last = abs % 10;
  const tens = abs % 100;
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

document.addEventListener('DOMContentLoaded', () => {
  initCommissionInput();
  bindEvents();
  refreshDashboard().catch((error) => {
    console.error(error);
    showBanner('error', [error.message]);
    setImportStatus(`Błąd inicjalizacji: ${error.message}`, 'error');
  });
});

function bindEvents() {
  const fileInput = document.getElementById('csv-file-input');
  fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    try {
      await importCsvFiles(files);
    } catch (error) {
      console.error(error);
      setImportStatus(`Błąd importu: ${error.message}`, 'error');
    }
    fileInput.value = '';
  });

  document.getElementById('clear-db-btn').addEventListener('click', async () => {
    if (!confirm('Czy na pewno chcesz usunąć wszystkie załadowane dane?')) return;
    await DB.clearAll();
    window.location.reload();
  });

  document.getElementById('time-range-selector').addEventListener('click', (event) => {
    if (event.target.tagName !== 'BUTTON') return;
    currentRange = event.target.dataset.range || 'all';
    document
      .querySelectorAll('#time-range-selector button')
      .forEach((button) => button.classList.toggle('active', button === event.target));
    renderChart();
  });

  document.getElementById('search-ticker').addEventListener('input', () => {
    if (window.lastTransactions) renderTransactions(window.lastTransactions);
  });
  document.getElementById('filter-type').addEventListener('change', () => {
    if (window.lastTransactions) renderTransactions(window.lastTransactions);
  });
  document.getElementById('filter-year').addEventListener('change', () => {
    if (window.lastTransactions) renderTransactions(window.lastTransactions);
  });

  document.getElementById('export-json-btn').addEventListener('click', exportBackup);
  document.getElementById('import-json-input').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) await importBackup(file);
  });
}

function initCommissionInput() {
  const input = document.getElementById('commission-pct');
  try {
    const saved = localStorage.getItem('investor:commissionPct');
    if (saved !== null && saved !== '') input.value = saved;
  } catch {
    /* localStorage może być zablokowany */
  }
  input.addEventListener('change', () => {
    const value = Math.max(0, Math.min(5, Number(input.value) || 0));
    input.value = String(value);
    try {
      localStorage.setItem('investor:commissionPct', String(value));
    } catch {
      /* ignorujemy */
    }
  });
}

// ---------------------------------------------------------------------------
// Import / eksport
// ---------------------------------------------------------------------------

async function importCsvFiles(files) {
  const status = document.getElementById('import-status');
  const errors = [];
  const skipped = [];
  const warnings = [];
  const transactions = [];
  const commissionPct = Number(document.getElementById('commission-pct').value) || 0;

  setImportStatus(`Przetwarzanie ${files.length} ${plural(files.length, 'pliku', 'plików', 'plików')}...`, 'info');

  for (const file of files) {
    try {
      const parsed = await Processor.parseFile(file, { commissionPct });
      transactions.push(...parsed.transactions);
      parsed.skipped.forEach((item) => skipped.push({ file: file.name, ...item }));
      parsed.warnings.forEach((warning) => warnings.push(`${file.name}: ${warning}`));
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }

  if (transactions.length === 0) {
    setImportStatus(`Nie znaleziono transakcji do importu. ${errors.join(' ')}`, 'error');
    return;
  }

  setImportStatus('Pobieram historyczne kursy walut (NBP)...', 'info');
  let fxErrors = 0;
  await Processor.applyFx(
    transactions,
    (currency, date) => API.getFxRate(currency, date),
    (done, total) => setImportStatus(`Kursy walut: ${done}/${total}...`, 'info')
  );
  fxErrors = transactions.filter((transaction) => transaction.value_pln == null).length;
  const estimatedFx = transactions.filter((transaction) => transaction.fx_estimated).length;
  if (estimatedFx > 0) {
    warnings.push(
      `${estimatedFx} ${plural(
        estimatedFx,
        'transakcja używa',
        'transakcje używają',
        'transakcji używa'
      )} przybliżonego kursu walutowego (bieżący zamiast historycznego NBP).`
    );
  }

  const result = await DB.saveTransactions(transactions);
  await refreshDashboard();

  const parts = [
    `Dodano ${result.added} ${plural(result.added, 'transakcję', 'transakcje', 'transakcji')}`,
    result.skipped > 0
      ? `pominięto ${result.skipped} ${plural(result.skipped, 'duplikat', 'duplikaty', 'duplikatów')}`
      : null,
    skipped.length > 0
      ? `odrzucono ${skipped.length} ${plural(skipped.length, 'wiersz', 'wiersze', 'wierszy')}`
      : null,
  ].filter(Boolean);

  const details = [];
  if (skipped.length > 0) {
    const byReason = new Map();
    for (const item of skipped) {
      const key = item.reason || 'inny powód';
      byReason.set(key, (byReason.get(key) || 0) + 1);
    }
    details.push(
      `<details><summary>Pominięte wiersze (${skipped.length})</summary><ul>${[...byReason.entries()]
        .map(([reason, count]) => `<li>${escapeHtml(reason)}: ${count}</li>`)
        .join('')}</ul></details>`
    );
  }
  if (warnings.length > 0) {
    details.push(
      `<details><summary>Uwagi (${warnings.length})</summary><ul>${warnings
        .slice(0, 10)
        .map((warning) => `<li>${escapeHtml(warning)}</li>`)
        .join('')}</ul></details>`
    );
  }
  if (errors.length > 0) {
    details.push(
      `<details><summary>Błędy plików (${errors.length})</summary><ul>${errors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join('')}</ul></details>`
    );
  }
  if (fxErrors > 0) {
    details.push(
      `<p class="negative">${fxErrors} ${plural(fxErrors, 'transakcja', 'transakcje', 'transakcji')} bez kursu walutowego - nie weszły do wyceny.</p>`
    );
  }

  const statusType = result.added > 0 ? 'success' : 'info';
  setImportStatus(`${parts.join(', ')}.`, statusType, details.join(''));
}

function exportBackup() {
  const transactions = (window.lastTransactions || []).map((transaction) => ({
    key: transaction.key,
    walor: transaction.walor,
    gielda: transaction.gielda,
    ks: transaction.ks,
    liczba: transaction.liczba_bazowa !== undefined ? transaction.liczba_bazowa : transaction.liczba,
    kurs: transaction.kurs_bazowy !== undefined ? transaction.kurs_bazowy : transaction.kurs,
    waluta: transaction.waluta,
    wartosc_oryginalna: transaction.wartosc_oryginalna,
    prowizja_oryginalna: transaction.prowizja_oryginalna,
    data: transaction.data,
    date_iso: transaction.date_iso,
    timestamp: transaction.timestamp,
    waluta_rozliczenia: transaction.waluta_rozliczenia,
    kurs_przewalutowania: transaction.fx_fixed !== null ? transaction.fx_fixed : transaction.kurs_przewalutowania,
    fx_fixed: transaction.fx_fixed,
    fx_source: transaction.fx_source,
    fx_date: transaction.fx_date,
    fx_estimated: transaction.fx_estimated,
    value_pln: transaction.value_pln,
    fee_pln: transaction.fee_pln,
    cash_flow_pln: transaction.cash_flow_pln,
    source_format: transaction.source_format,
    order_type: transaction.order_type,
    imported_at: transaction.imported_at,
  }));

  const payload = {
    app: 'Centrum Inwestora',
    version: 2,
    exported_at: new Date().toISOString(),
    transactions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `centrum-inwestora-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const transactions = Array.isArray(parsed) ? parsed : parsed.transactions;
    if (!Array.isArray(transactions)) throw new Error('Plik nie zawiera listy transakcji.');

    const normalized = transactions.map((transaction) => {
      const copy = { ...transaction };
      delete copy.id;
      copy.date_iso =
        copy.date_iso ||
        (copy.timestamp ? new Date(copy.timestamp).toISOString().slice(0, 10) : '');
      copy.key = copy.key || Processor.buildKey(copy);
      if (!Number.isFinite(Number(copy.timestamp)) && /^\d{4}-\d{2}-\d{2}$/.test(copy.date_iso)) {
        copy.timestamp = Date.parse(`${copy.date_iso}T00:00:00Z`);
      }
      return copy;
    });

    const missingFx = normalized.filter((transaction) => transaction.value_pln == null);
    if (missingFx.length > 0) {
      await Processor.applyFx(missingFx, (currency, date) => API.getFxRate(currency, date));
    }

    const result = await DB.saveTransactions(normalized);
    setImportStatus(`Import kopii: dodano ${result.added}, pominięto ${result.skipped}.`, 'success');
    await refreshDashboard();
  } catch (error) {
    setImportStatus(`Nie udało się zaimportować kopii: ${error.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function refreshDashboard() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const transactions = await DB.getAllTransactions();
    window.lastTransactions = transactions;
    populateYearFilter(transactions);

    if (transactions.length === 0) {
      document.getElementById('dashboard-content').style.display = 'none';
      showBanner('info', ['Brak danych. Wgraj plik CSV, aby zobaczyć portfel.']);
      return;
    }
    document.getElementById('dashboard-content').style.display = 'block';

    const mapping = await API.getMapping();
    currentMapping = mapping || {};
    currentTargets = (await API.getTargets()) || {};

    for (const transaction of transactions) {
      transaction.symbol = API.symbolFor(transaction.walor, currentMapping, transaction.gielda);
    }
    const symbols = [...new Set(transactions.map((transaction) => transaction.symbol).filter(Boolean))];
    const firstDate = transactions.map((transaction) => transaction.date_iso).sort()[0];

    const invested = Processor.buildInvestedSeries(transactions);
    currentTimeseries = { ...invested, portfolio_value_pln: null, mode: 'invested' };
    setChartTitle(false);
    renderChart();

    setChartStatus('Pobieram notowania i historię (pierwsze uruchomienie może potrwać)...');
    const warnings = [];
    if (!currentMapping || Object.keys(currentMapping).length === 0) {
      warnings.push(
        'Nie udało się wczytać mapowania instrumentów (data/reference/instruments_mapping.yaml) - używam symboli zastępczych.'
      );
    }
    const snapshot = await API.getSnapshot(symbols, firstDate);

    Processor.applySplits(transactions, snapshot.splits);

    const metrics = Processor.calculateMetrics(
      transactions,
      currentMapping,
      snapshot.quotes,
      snapshot.rates
    );
    window.lastMetrics = metrics;

    renderSummary(metrics.summary);
    renderPortfolio(metrics.portfolio_list);
    updateAssetStructChart(metrics.struct_asset);
    renderRecommendations(metrics);
    renderTransactions(transactions);
    updateMarketTimestamp(snapshot);

    if (snapshot.error) warnings.push(snapshot.error);
    if (snapshot.stale) warnings.push('Użyto zapisanych notowań (cache) - mogą być nieaktualne.');
    const quoteErrors = (snapshot.errors || []).filter((item) => item.symbol !== 'FX');
    const fxError = (snapshot.errors || []).find((item) => item.symbol === 'FX');
    if (quoteErrors.length > 0 && !snapshot.error) {
      const reasons = [...new Set(quoteErrors.map((item) => item.message))];
      warnings.push(`Powód braku notowań: ${reasons.slice(0, 2).join(' | ')}`);
    }
    if (fxError) warnings.push(`Brak aktualnych kursów walut: ${fxError.message}`);
    if (metrics.summary.missing_quotes.length > 0) {
      const missing = metrics.summary.missing_quotes;
      const list = missing
        .slice(0, 8)
        .map((item) =>
          `${item.walor} (${item.symbol}${
            item.reason && item.reason !== 'brak notowania' ? `, ${item.reason}` : ''
          })`
        )
        .join(', ');
      const rest = missing.length > 8 ? ` i ${missing.length - 8} innych` : '';
      warnings.push(`Brak wyceny dla: ${list}${rest}. Wycena portfela jest niepełna.`);
    }
    for (const warning of metrics.warnings.slice(0, 5)) warnings.push(warning);
    if (metrics.warnings.length > 5) {
      warnings.push(`...oraz ${metrics.warnings.length - 5} innych ostrzeżeń.`);
    }
    showBanner(warnings.length > 0 ? 'warning' : 'info', warnings);

    if (snapshot.histories && Object.keys(snapshot.histories).length > 0) {
      const histories = snapshot.histories;
      const currencies = [
        ...new Set([
          ...Object.values(histories).map((history) => history.currency),
          ...transactions.map((transaction) => transaction.waluta),
        ]),
      ];
      const fxHistories = await API.getFxHistories(currencies, firstDate);
      const series = Processor.buildPortfolioSeries(transactions, histories, fxHistories, {
        fallbackRates: snapshot.rates,
      });

      if (series && series.portfolio_value_pln.some((value) => value > 0)) {
        if (metrics.summary.valuation_complete && !series.incomplete && series.portfolio_value_pln.length > 0) {
          series.portfolio_value_pln[series.portfolio_value_pln.length - 1] =
            metrics.summary.total_value_pln;
        }
        currentTimeseries = series;
        setChartTitle(true);
        renderChart();
        if (series.incomplete) {
          setChartStatus('Historia niepełna - brak notowań części walorów.');
        } else if (quoteErrors.length > 0) {
          setChartStatus(`Historia częściowa (${quoteErrors.length} błędów notowań).`);
        } else {
          setChartStatus('');
        }
      } else {
        setChartStatus('Historia wyceny niedostępna - pokazano kapitał netto zaangażowany.');
      }
    } else {
      setChartStatus('Historia wyceny niedostępna - pokazano kapitał netto zaangażowany.');
    }
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshDashboard().catch((error) => {
        console.error(error);
        showBanner('error', [error.message]);
      });
    }
  }
}

function renderSummary(summary) {
  const incomplete = summary.valuation_complete ? '' : ' *';
  setText('total-value', `${formatPLN(summary.total_value_pln)}${incomplete}`);
  setText('total-invested', formatPLN(summary.net_invested_pln));
  document.getElementById('total-invested').title =
    'Suma zakupów pomniejszona o wpływy ze sprzedaży (bez wpłat gotówki na rachunek).';

  const plElement = document.getElementById('total-pl');
  plElement.textContent = formatPLN(summary.total_pl_pln);
  plElement.className = `value ${classNameFor(summary.total_pl_pln)}`;

  const plPercent = document.getElementById('total-pl-percent');
  plPercent.textContent = `${summary.total_pl_pct >= 0 ? '+' : ''}${summary.total_pl_pct.toFixed(2)}%`;
  plPercent.className = `subvalue ${classNameFor(summary.total_pl_pln)}`;

  const realized = document.getElementById('total-realized');
  realized.textContent = formatPLN(summary.realized_pl_pln);
  realized.className = `value ${classNameFor(summary.realized_pl_pln)}`;

  const unrealized = document.getElementById('total-unrealized');
  unrealized.textContent = formatPLN(summary.unrealized_pl_pln);
  unrealized.className = `value ${classNameFor(summary.unrealized_pl_pln)}`;

  if (!summary.valuation_complete) {
    document.getElementById('total-value').title =
      'Wycena niepełna - brak notowań części instrumentów. Wartość i zysk są zaniżone.';
  } else {
    document.getElementById('total-value').title = '';
  }

  setText('last-updated', summary.last_updated);
}

function renderPortfolio(list) {
  const tbody = document.getElementById('portfolio-body');
  if (!list || list.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="empty">Brak otwartych pozycji (wszystkie zostały sprzedane).</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map((item) => {
      const plClass = classNameFor(item.unrealized_pl_pln);
      const splitBadge =
        item.split_factor && item.split_factor !== 1
          ? `<span class="badge" title="Uwzględniono split">×${formatNumber(item.split_factor, 0)}</span>`
          : '';
      const priceTitle =
        item.price != null && item.currency && item.currency !== 'PLN'
          ? ` title="Cena ${formatNumber(item.price, 2)} ${escapeHtml(item.currency)}"`
          : '';
      return `<tr>
                <td>
                  <strong>${escapeHtml(item.walor)}</strong>${splitBadge}
                  <div class="muted small">${escapeHtml(item.symbol)}</div>
                </td>
                <td>${escapeHtml(item.asset_class)}</td>
                <td>${escapeHtml(item.gielda || '—')}</td>
                <td>${formatNumber(item.units, 4)}</td>
                <td>${formatPLN(item.avg_cost_pln)}</td>
                <td${priceTitle}>${item.price_pln == null ? '—' : formatPLN(item.price_pln)}</td>
                <td>${item.value_pln == null ? '—' : formatPLN(item.value_pln)}</td>
                <td class="${plClass}">${
                  item.unrealized_pl_pln == null ? '—' : formatPLN(item.unrealized_pl_pln)
                }</td>
                <td>${item.weight == null ? '—' : `${(item.weight * 100).toFixed(1)}%`}</td>
              </tr>`;
    })
    .join('');
}

function renderTransactions(data) {
  const tbody = document.getElementById('transactions-body');
  const search = document.getElementById('search-ticker').value.trim().toLowerCase();
  const type = document.getElementById('filter-type').value;
  const year = document.getElementById('filter-year').value;

  const filtered = [...data]
    .filter((transaction) => {
      const matchesSearch = String(transaction.walor || '')
        .toLowerCase()
        .includes(search);
      const matchesType = !type || transaction.ks === type;
      const matchesYear = !year || String(transaction.date_iso || '').startsWith(year);
      return matchesSearch && matchesType && matchesYear;
    })
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Brak transakcji dla wybranych filtrów.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map((transaction) => {
      const splitBadge =
        transaction.split_factor && transaction.split_factor !== 1
          ? ` <span class="badge" title="Po splicie ×${formatNumber(
              transaction.split_factor,
              0
            )}: ${formatNumber(transaction.liczba, 4)} szt. po ${formatNumber(
              transaction.kurs,
              4
            )} ${escapeHtml(transaction.waluta)} (pierwotnie ${formatNumber(
              transaction.liczba_bazowa,
              4
            )} szt. po ${formatNumber(transaction.kurs_bazowy, 4)} ${escapeHtml(
              transaction.waluta
            )})">×${formatNumber(transaction.split_factor, 0)}</span>`
          : '';
      const fee =
        transaction.fee_pln == null || transaction.fee_pln === 0
          ? '—'
          : formatPLN(transaction.fee_pln);
      const value =
        transaction.value_pln == null
          ? '—'
          : `${formatPLN(transaction.value_pln)}${
              transaction.fx_estimated
                ? ' <span class="badge" title="Kurs walutowy przybliżony: użyto kursu bieżącego zamiast historycznego NBP">~</span>'
                : ''
            }`;
      return `<tr>
                <td>${escapeHtml(formatDate(transaction))}</td>
                <td>${escapeHtml(transaction.walor)}${splitBadge}
                  <div class="muted small">${escapeHtml(transaction.symbol || transaction.gielda || '')}</div>
                </td>
                <td>${escapeHtml(transaction.gielda || '—')}</td>
                <td class="${transaction.ks === 'Sprzedaż' ? 'negative' : 'positive'}">${escapeHtml(
                  transaction.ks
                )}</td>
                <td>${formatNumber(transaction.liczba, 4)}</td>
                <td>${formatNumber(transaction.kurs, 4)} ${escapeHtml(transaction.waluta)}</td>
                <td>${value}</td>
                <td>${fee}</td>
              </tr>`;
    })
    .join('');
}

function renderRecommendations(metrics) {
  const container = document.getElementById('recommendations-container');
  if (!currentTargets || Object.keys(currentTargets).length === 0) {
    container.innerHTML =
      '<p class="rec-msg">Nie udało się wczytać celów alokacji (data/reference/asset_classes.yaml).</p>';
    return;
  }
  if (!metrics.summary.valuation_complete || metrics.summary.positions_count === 0) {
    container.innerHTML =
      '<p class="rec-msg">Rekomendacje niedostępne, dopóki wycena portfela jest niepełna lub brak otwartych pozycji.</p>';
    return;
  }
  const items = Processor.buildRecommendations(
    metrics.struct_asset,
    currentTargets,
    metrics.portfolio_list
  );

  if (items.length === 0) {
    container.innerHTML = '<p class="rec-msg">Portfel jest zrównoważony względem przyjętych celów. Brak uwag.</p>';
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `<div class="recommendation-item ${item.type}">
        <div class="rec-header">
          <span>${escapeHtml(item.type)}: ${escapeHtml(item.category)}</span>
          <span>${(item.current * 100).toFixed(1)}% (cel: ${(item.target * 100).toFixed(1)}%)</span>
        </div>
        <div class="rec-msg">${escapeHtml(item.message)}</div>
      </div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Wykres
// ---------------------------------------------------------------------------

function renderChart() {
  if (!currentTimeseries) return;
  updateTimeseriesChart(filterTimeseries(currentTimeseries, currentRange));
}

function filterTimeseries(data, range) {
  if (!data || range === 'all') return data;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === '1m') cutoff.setMonth(now.getMonth() - 1);
  else if (range === '3m') cutoff.setMonth(now.getMonth() - 3);
  else if (range === '6m') cutoff.setMonth(now.getMonth() - 6);
  else if (range === '1y') cutoff.setFullYear(now.getFullYear() - 1);
  else if (range === '2y') cutoff.setFullYear(now.getFullYear() - 2);
  else if (range === '5y') cutoff.setFullYear(now.getFullYear() - 5);

  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const indices = [];
  data.dates.forEach((date, index) => {
    if (date >= cutoffIso) indices.push(index);
  });

  return {
    ...data,
    dates: indices.map((index) => data.dates[index]),
    invested_pln: indices.map((index) => data.invested_pln[index]),
    portfolio_value_pln: data.portfolio_value_pln
      ? indices.map((index) => data.portfolio_value_pln[index])
      : null,
  };
}

function setChartTitle(hasValuation) {
  document.getElementById('timeseries-title').textContent = hasValuation
    ? 'Wartość Portfela w Czasie'
    : 'Kapitał Netto Zaangażowany w Czasie';
}

function setChartStatus(text) {
  document.getElementById('chart-status').textContent = text || '';
}

// ---------------------------------------------------------------------------
// Pomocnicze UI
// ---------------------------------------------------------------------------

function populateYearFilter(transactions) {
  const select = document.getElementById('filter-year');
  const years = [...new Set(transactions.map((transaction) => String(transaction.date_iso || '').slice(0, 4)))]
    .filter((year) => /^\d{4}$/.test(year))
    .sort()
    .reverse();
  const current = select.value;
  select.innerHTML = '<option value="">Wszystkie</option>' + years.map((year) => `<option value="${year}">${year}</option>`).join('');
  if (years.includes(current)) select.value = current;
}

function updateMarketTimestamp(market) {
  const element = document.getElementById('market-updated');
  if (!market || (!market.fetchedAt && !market.quotes)) {
    element.textContent = '';
    return;
  }
  const quoteTimes = Object.values(market.quotes || {})
    .map((quote) => quote && quote.marketTime)
    .filter(Boolean)
    .sort();
  const stamp = quoteTimes.length > 0 ? quoteTimes[quoteTimes.length - 1] : market.fetchedAt;
  const fetched = new Date(stamp);
  element.textContent = ` | Notowania: ${fetched.toLocaleString('pl-PL')}${market.stale ? ' (cache)' : ''}`;
}

function showBanner(type, messages) {
  const banner = document.getElementById('app-banner');
  const items = (messages || []).filter(Boolean);
  if (items.length === 0) {
    banner.className = 'banner hidden';
    banner.innerHTML = '';
    return;
  }
  banner.className = `banner ${type || 'info'}`;
  banner.innerHTML = items.length === 1
    ? escapeHtml(items[0])
    : `<ul>${items.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
}

function setImportStatus(message, type = 'info', detailsHtml = '') {
  const element = document.getElementById('import-status');
  element.className = `status-msg ${type}`;
  element.innerHTML = `${escapeHtml(message)}${detailsHtml}`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function formatPLN(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatDate(transaction) {
  return String(transaction.data || transaction.date_iso || '').replace(/ 00:00:00$/, '');
}

function classNameFor(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) === 0) return 'neutral';
  return Number(value) > 0 ? 'positive' : 'negative';
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}
