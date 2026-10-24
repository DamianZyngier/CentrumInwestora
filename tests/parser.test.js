'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Processor = require('../site/js/processor.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parser: eksport zleceń - filtruje statusy i używa liczby zrealizowanej', () => {
  const result = Processor.parseText(`\uFEFF${fixture('orders_2024.csv')}`, 'orders_2024.csv');

  assert.equal(result.format, 'orders');
  assert.equal(result.transactions.length, 5);
  assert.equal(result.skipped.length, 2);

  const asbis = result.transactions.find((t) => t.walor === 'ASBIS');
  assert.equal(asbis.liczba, 10);
  assert.equal(asbis.kurs, 20);
  assert.equal(asbis.waluta, 'PLN');
  assert.equal(asbis.wartosc_oryginalna, 200);
  assert.equal(asbis.date_iso, '2024-03-15');
  assert.equal(asbis.ks, 'Kupno');
  assert.ok(asbis.key.includes('2024-03-15'));

  const partial = result.transactions.find((t) => t.walor === 'CDPROJEKT');
  assert.equal(partial.liczba, 4, 'bierzemy Liczbę zreal, nie Liczbę');
  assert.equal(partial.wartosc_oryginalna, 400);

  const sale = result.transactions.find((t) => t.walor === 'EMXC LN ETF');
  assert.equal(sale.ks, 'Sprzedaż');
  assert.equal(sale.wartosc_oryginalna, 30);
});

test('parser: eksport transakcji (stary format) i kurs z pliku', () => {
  const result = Processor.parseText(fixture('transactions_legacy.csv'), 'legacy.csv');

  assert.equal(result.format, 'transactions');
  assert.equal(result.transactions.length, 3);

  const buy = result.transactions.find((t) => t.walor === 'DINOPL' && t.ks === 'Kupno');
  assert.equal(buy.wartosc_oryginalna, 3000);
  assert.equal(buy.prowizja_oryginalna, 5);
  assert.equal(buy.fx_fixed, 1);
  assert.equal(buy.date_iso, '2021-12-06');

  const foreign = result.transactions.find((t) => t.walor === 'SGLN LN ETC');
  assert.equal(foreign.fx_fixed, 4.9656);
});

test('parser: transakcje walutowe rozliczane w PLN nie są przeliczane drugi raz', async () => {
  const csv = [
    'Walor;Giełda;K/S;Liczba;Kurs;Waluta;Wartość;Prowizja;Czas transakcji;Waluta rozliczenia;Kurs Przewalutowania',
    'IUSA GR ETF;DEU;Kupno;41;36,52200000;EUR;7029,55;20,39;13.01.2023 09:04:19;PLN;4,6945',
  ].join('\n');

  const parsed = Processor.parseText(csv, 'transakcje_fx.csv');
  const transaction = parsed.transactions[0];
  assert.equal(transaction.value_currency, 'PLN');
  assert.equal(transaction.wartosc_oryginalna, 7029.55);
  assert.equal(transaction.fx_fixed, 4.6945);

  await Processor.applyFx(parsed.transactions, async (currency, date) => {
    throw new Error(`Nie powinno pobierać kursu ${currency} dla ${date}`);
  });

  assert.equal(transaction.kurs_przewalutowania, 1);
  assert.equal(transaction.value_pln, 7029.55);
  assert.equal(transaction.fee_pln, 20.39);
  assert.ok(Math.abs(transaction.cash_flow_pln + 7049.94) < 0.0001);
});

test('parser: dwie osobne transakcje o tych samych podstawowych polach nie są duplikatem', () => {
  const csv = [
    'Walor;Giełda;K/S;Liczba;Kurs;Waluta;Wartość;Prowizja;Czas transakcji;Waluta rozliczenia;Kurs Przewalutowania',
    'SJPA LN ETF;LON;Kupno;2;37,52000000;GBP;400,01;19,00;22.07.2021 09:00:00;PLN;5,3307',
    'SJPA LN ETF;LON;Kupno;2;37,52000000;GBP;400,02;0,00;22.07.2021 09:00:00;PLN;5,3307',
  ].join('\n');

  const result = Processor.parseText(csv, 'DZ_2021.csv');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.notEqual(
    Processor.identityKey(result.transactions[0]),
    Processor.identityKey(result.transactions[1])
  );
});

test('migracja: naprawia stare podwójne przeliczenie FX w IndexedDB', () => {
  const legacy = {
    source_format: 'transactions',
    walor: 'IUSA GR ETF',
    ks: 'Kupno',
    liczba: 41,
    kurs: 36.522,
    waluta: 'EUR',
    waluta_rozliczenia: 'PLN',
    wartosc_oryginalna: 7029.55,
    prowizja_oryginalna: 20.39,
    fx_fixed: 4.6945,
    value_pln: 7029.55 * 4.6945,
    fee_pln: 20.39 * 4.6945,
    cash_flow_pln: -((7029.55 + 20.39) * 4.6945),
  };

  const changed = Processor.normalizeStoredTransactions([legacy]);
  assert.equal(changed.length, 1);
  assert.equal(legacy.value_currency, 'PLN');
  assert.equal(legacy.fee_currency, 'PLN');
  assert.equal(legacy.value_pln, 7029.55);
  assert.equal(legacy.fee_pln, 20.39);
  assert.ok(Math.abs(legacy.cash_flow_pln + 7049.94) < 0.0001);

  const current = { ...legacy };
  assert.equal(Processor.normalizeStoredTransactions([current]).length, 0);
});

test('parser: pominięte wiersze mają numer linii z pliku i dane do sprawdzenia', () => {
  const csv = [
    'Stan;Walor;Giełda;K/S;Liczba;Liczba zreal;Limit;Waluta;Data ważności;Data realizacji',
    '',
    'Unieważnione;CDPROJEKT;WWA;Kupno;10;10;100,00;PLN;01.01.2024;02.01.2024',
    'Zamknięte;ASBIS;WWA;Kupno;10;0;20,00;PLN;01.01.2024;03.01.2024',
  ].join('\n');

  const result = Processor.parseText(csv, 'pominiete.csv');
  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0].line, 3);
  assert.equal(result.skipped[0].walor, 'CDPROJEKT');
  assert.equal(result.skipped[0].date, '02.01.2024');
  assert.equal(result.skipped[0].side, 'Kupno');
  assert.equal(result.skipped[0].quantity, '10');
  assert.equal(result.skipped[0].price, '100,00');
  assert.match(result.skipped[0].reason, /Unieważnione/);
  assert.equal(result.skipped[1].line, 4);
  assert.match(result.skipped[1].reason, /Zamknięte/);
});

test('parser: odrzuca nieznany format', () => {
  assert.throws(
    () => Processor.parseText('foo;bar\n1;2', 'unknown.csv'),
    /Nierozpoznany format/
  );
});

test('parser: nie importuje statusu "Niezrealizowane", nieznanego kierunku i woli datę realizacji', () => {
  const csv = [
    'Stan;Walor;Giełda;K/S;Liczba;Liczba zreal;Limit;Waluta;Data ważności;Data realizacji',
    'Niezrealizowane;ASBIS;WWA;Kupno;10;10;20,00;PLN;01.01.2024;02.01.2024',
    'Zrealizowane;CDPROJEKT;WWA;Nieznany;10;10;100,00;PLN;01.01.2024;02.01.2024',
    'Zrealizowane;DINOPL;WWA;Kupno;10;10;340,00;PLN;01.01.2024;05.01.2024',
  ].join('\n');

  const result = Processor.parseText(csv, 'statusy.csv');
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].walor, 'DINOPL');
  assert.equal(result.transactions[0].date_iso, '2024-01-05');
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /status: Niezrealizowane/);
  assert.match(result.skipped[1].reason, /nieznany kierunek/);
});

test('kursy walut: przelicza wartość, prowizję i cash flow', async () => {
  const parsed = Processor.parseText(fixture('orders_2024.csv'), 'orders.csv');
  await Processor.applyFx(parsed.transactions, async (currency) => ({
    currency,
    rate: currency === 'GBP' ? 5 : currency === 'USD' ? 4 : 1,
    source: 'test',
  }));

  const sgl = parsed.transactions.find((t) => t.walor === 'SGLN LN ETC');
  assert.equal(sgl.value_pln, 500);
  assert.equal(sgl.fee_pln, 0);
  assert.equal(sgl.cash_flow_pln, -500);

  const sale = parsed.transactions.find((t) => t.walor === 'EMXC LN ETF');
  assert.equal(sale.value_pln, 120);
  assert.equal(sale.cash_flow_pln, 120);
});

test('splity: korygują jednostki i cenę, są idempotentne', () => {
  const parsed = Processor.parseText(fixture('orders_2024.csv'), 'orders.csv');
  const transaction = parsed.transactions.find((t) => t.walor === 'DINOPL');
  transaction.symbol = 'DNP.WA';

  Processor.applySplits(parsed.transactions, { 'DNP.WA': [{ date: '2025-07-31', ratio: 10 }] });
  assert.equal(transaction.liczba, 10);
  assert.equal(transaction.kurs, 34);
  assert.equal(transaction.wartosc_oryginalna, 340);

  Processor.applySplits(parsed.transactions, { 'DNP.WA': [{ date: '2025-07-31', ratio: 10 }] });
  assert.equal(transaction.liczba, 10, 'drugie wywołanie nie może mnożyć ponownie');
  assert.equal(transaction.kurs, 34);
});

test('metryki: średni koszt, zysk zrealizowany i niezrealizowany', () => {
  const mapping = {
    ASBIS: { yahoo_symbol: 'ASB.WA', asset_class: 'Equity - Poland', exchange: 'WWA' },
    'SGLN LN ETC': { yahoo_symbol: 'SGLN.L', asset_class: 'Gold', exchange: 'LON' },
  };
  const quotes = {
    'ASB.WA': { price: 25, currency: 'PLN', name: 'ASBIS' },
    'SGLN.L': { price: 60, currency: 'GBP', name: 'Gold' },
  };
  const fxRates = { PLN: 1, GBP: 5 };

  const transactions = [
    {
      walor: 'ASBIS', gielda: 'WWA', ks: 'Kupno', liczba: 10, kurs: 20, waluta: 'PLN',
      date_iso: '2024-01-01', timestamp: Date.UTC(2024, 0, 1), value_pln: 200,
      fee_pln: 0, symbol: 'ASB.WA',
    },
    {
      walor: 'ASBIS', gielda: 'WWA', ks: 'Sprzedaż', liczba: 2, kurs: 30, waluta: 'PLN',
      date_iso: '2024-02-01', timestamp: Date.UTC(2024, 1, 1), value_pln: 60,
      fee_pln: 0, symbol: 'ASB.WA',
    },
    {
      walor: 'SGLN LN ETC', gielda: 'LON', ks: 'Kupno', liczba: 2, kurs: 50, waluta: 'GBP',
      date_iso: '2024-03-01', timestamp: Date.UTC(2024, 2, 1), value_pln: 500,
      fee_pln: 0, symbol: 'SGLN.L',
    },
  ];

  const metrics = Processor.calculateMetrics(transactions, mapping, quotes, fxRates);
  const summary = metrics.summary;
  const asbis = metrics.portfolio_list.find((p) => p.walor === 'ASBIS');

  assert.equal(asbis.units, 8);
  assert.equal(asbis.avg_cost_pln, 20);
  assert.equal(asbis.value_pln, 200);
  assert.equal(asbis.unrealized_pl_pln, 40);
  assert.equal(asbis.realized_pl_pln, 20);

  assert.equal(summary.realized_pl_pln, 20);
  assert.equal(summary.unrealized_pl_pln, 140);
  assert.equal(summary.total_pl_pln, 160);
  assert.equal(summary.total_value_pln, 800);
  assert.equal(summary.valuation_complete, true);
  assert.ok(Math.abs(summary.total_pl_pct - (160 / 700) * 100) < 1e-9);
  assert.ok(Math.abs(metrics.struct_asset.Gold - 0.75) < 1e-9);
});

test('metryki: brak notowania oznacza wycenę niepełną', () => {
  const transactions = [
    {
      walor: 'UNKNOWN', gielda: 'WWA', ks: 'Kupno', liczba: 1, kurs: 100, waluta: 'PLN',
      date_iso: '2024-01-01', timestamp: Date.UTC(2024, 0, 1), value_pln: 100,
      fee_pln: 0, symbol: 'UNKNOWN.WA',
    },
  ];
  const metrics = Processor.calculateMetrics(transactions, {}, {}, { PLN: 1 });
  assert.equal(metrics.summary.valuation_complete, false);
  assert.equal(metrics.summary.missing_quotes.length, 1);
  assert.equal(metrics.portfolio_list[0].value_pln, null);
});

test('metryki: brak kursu walutowego oznacza wycenę niepełną', () => {
  const transactions = [
    {
      walor: 'X', gielda: 'SWX', ks: 'Kupno', liczba: 1, kurs: 100, waluta: 'CHF',
      date_iso: '2024-01-01', timestamp: Date.UTC(2024, 0, 1), value_pln: 460,
      fee_pln: 0, symbol: 'X.SW',
    },
  ];
  const quotes = { 'X.SW': { symbol: 'X.SW', price: 100, currency: 'CHF' } };
  const mapping = { X: { yahoo_symbol: 'X.SW' } };
  const metrics = Processor.calculateMetrics(transactions, mapping, quotes, { PLN: 1 });
  assert.equal(metrics.summary.valuation_complete, false);
  assert.equal(metrics.summary.missing_quotes.length, 1);
  assert.match(metrics.summary.missing_quotes[0].reason, /brak kursu CHF/);
  assert.equal(metrics.portfolio_list[0].value_pln, null);
});

test('metryki: sprzedaż bez pozycji jest wypłatą, ale nie tworzy zysku', () => {
  const transactions = [
    {
      walor: 'EMXC LN ETF', gielda: 'LON', ks: 'Sprzedaż', liczba: 1, kurs: 30,
      waluta: 'USD', date_iso: '2026-05-18', timestamp: Date.UTC(2026, 4, 18),
      value_pln: 120, fee_pln: 0, symbol: 'EMXC.L',
    },
  ];
  const metrics = Processor.calculateMetrics(transactions, {}, {}, { PLN: 1 });
  assert.equal(metrics.summary.realized_pl_pln, 0);
  assert.equal(metrics.summary.withdrawn_pln, 120);
  assert.equal(metrics.summary.net_invested_pln, -120);
  assert.match(metrics.warnings[0], /brak posiadanych jednostek/);
});

test('szereg czasowy: wartość portfela z historii i splitów', () => {
  const transactions = [
    {
      walor: 'DINOPL', gielda: 'WWA', ks: 'Kupno', liczba: 10, kurs: 34, waluta: 'PLN',
      date_iso: '2021-12-06', timestamp: Date.UTC(2021, 11, 6), value_pln: 340,
      fee_pln: 0, cash_flow_pln: -340, symbol: 'DNP.WA',
    },
  ];
  const histories = {
    'DNP.WA': {
      currency: 'PLN',
      dates: ['2021-12-06', '2021-12-07', '2021-12-08'],
      closes: [34, 35, 36],
    },
  };
  const series = Processor.buildPortfolioSeries(transactions, histories, {}, { fallbackRates: { PLN: 1 } });
  const investedSeries = Processor.buildInvestedSeries(transactions);

  assert.equal(series.mode, 'valuation');
  // Dzień przed pierwszą transakcją: punkt zerowy i widoczny odcinek do zakupu.
  assert.equal(series.dates[0], '2021-12-05');
  assert.equal(series.portfolio_value_pln[0], 0);
  assert.equal(series.invested_pln[0], 0);
  assert.equal(investedSeries.dates[0], '2021-12-05');
  assert.equal(investedSeries.invested_pln[0], 0);
  assert.equal(investedSeries.invested_pln[1], 340);
  assert.equal(series.portfolio_value_pln[series.dates.indexOf('2021-12-06')], 340);
  assert.equal(series.portfolio_value_pln[series.dates.indexOf('2021-12-07')], 350);
  assert.equal(series.invested_pln[series.dates.indexOf('2021-12-06')], 340);
  // Ostatni punkt = ostatnia znana cena (forward fill).
  assert.equal(series.portfolio_value_pln.at(-1), 360);
  assert.equal(series.incomplete, false);
});

test('zysk roczny: nominalny i realny bez wpłat oraz wypłat', () => {
  const series = {
    dates: ['2020-12-31', '2021-12-31', '2022-12-31'],
    invested_pln: [1000, 1000, 1000],
    portfolio_value_pln: [1000, 1200, 900],
  };
  const rows = Processor.calculateAnnualReturns(series, {
    rates: { 2020: 3.4, 2021: 5, 2022: 10 },
    ytd: {},
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].profit_pln, 0);
  assert.equal(rows[1].profit_pln, 200);
  assert.ok(Math.abs(rows[1].return_pct - 20) < 1e-9);
  assert.ok(Math.abs(rows[1].real_return_pct - ((1.2 / 1.05 - 1) * 100)) < 1e-9);
  assert.ok(Math.abs(rows[1].real_profit_pln - (1000 * (1.2 / 1.05 - 1))) < 1e-9);

  assert.equal(rows[2].profit_pln, -300);
  assert.ok(Math.abs(rows[2].return_pct + 25) < 1e-9);
  assert.ok(Math.abs(rows[2].real_return_pct - ((0.75 / 1.1 - 1) * 100)) < 1e-9);
  assert.ok(Math.abs(rows[2].real_profit_pln - (1200 * (0.75 / 1.1 - 1))) < 1e-9);
});

test('zysk roczny: procent od średniego kapitału uwzględnia moment wpłaty', () => {
  const series = {
    dates: ['2025-01-01', '2025-07-01', '2025-12-31'],
    invested_pln: [1000, 1500, 1500],
    portfolio_value_pln: [1000, 1500, 1650],
  };
  const [row] = Processor.calculateAnnualReturns(series, { rates: { 2025: 0 }, ytd: {} });

  assert.equal(row.profit_pln, 150, 'wpłata 500 zł nie jest zyskiem');
  assert.ok(row.average_capital_pln > 1250 && row.average_capital_pln < 1260);
  assert.ok(row.return_pct > 11.9 && row.return_pct < 12.1);
});

test('zysk roczny: bieżący rok i inflacja YTD są oznaczone', () => {
  const series = {
    dates: ['2026-01-01', '2026-10-24'],
    invested_pln: [1000, 1000],
    portfolio_value_pln: [1000, 1050],
  };
  const [row] = Processor.calculateAnnualReturns(series, {
    rates: { 2026: 2.65 },
    ytd: { 2026: true },
  });

  assert.equal(row.label, '2026 (YTD)');
  assert.equal(row.inflation_ytd, true);
  assert.equal(row.inflation_pct, 2.65);
  assert.ok(Math.abs(row.return_pct - 5) < 1e-9);
});

test('rekomendacje: niedowaga, przewaga i koncentracja', () => {
  const items = Processor.buildRecommendations(
    { 'Equity - Developed': 0.8, Gold: 0.1 },
    { 'Equity - Developed': 0.5, 'Equity - Emerging': 0.2, Gold: 0.1 },
    [{ walor: 'X', weight: 0.4 }]
  );
  assert.ok(items.some((item) => item.type === 'PRZEWAGA' && item.category === 'Equity - Developed'));
  assert.ok(items.some((item) => item.type === 'NIEDOWAGA' && item.category === 'Equity - Emerging'));
  assert.ok(items.some((item) => item.type === 'KONCENTRACJA' && item.category === 'X'));
});
