'use strict';

let tsChart = null;
let asChart = null;

const CHART_COLORS = ['#38bdf8', '#818cf8', '#fb7185', '#fbbf24', '#34d399', '#a78bfa', '#f472b6', '#22d3ee'];

function rateForYear(rates, year) {
  if (!rates || typeof rates !== 'object') return 0;
  if (rates[year] != null && Number.isFinite(Number(rates[year]))) return Number(rates[year]);
  const years = Object.keys(rates)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (years.length === 0) return 0;
  const nearest = years.reduce((best, candidate) =>
    Math.abs(candidate - year) < Math.abs(best - year) ? candidate : best
  );
  return Number(rates[nearest]) || 0;
}

function inflationFactor(fromDate, toDate, rates) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return 1;
  if (from > to) return 1 / inflationFactor(toDate, fromDate, rates);

  let factor = 1;
  let cursor = from;
  while (cursor < to) {
    const year = new Date(cursor).getUTCFullYear();
    const yearEnd = Date.UTC(year + 1, 0, 1);
    const segmentEnd = Math.min(to, yearEnd);
    const fraction = (segmentEnd - cursor) / (yearEnd - Date.UTC(year, 0, 1));
    factor *= Math.pow(1 + rateForYear(rates, year) / 100, fraction);
    cursor = segmentEnd;
  }
  return factor;
}

function realValues(nominal, dates, rates) {
  if (!Array.isArray(nominal) || !Array.isArray(dates) || nominal.length === 0) return null;
  if (!rates || Object.keys(rates).length === 0) return null;
  // Wartość realna w cenach z początku wybranego zakresu: linia startuje
  // razem z nominalną, a potem rośnie wolniej o skumulowaną inflację.
  const base = dates[0];
  return nominal.map((value, index) =>
    value == null ? null : value / inflationFactor(base, dates[index], rates)
  );
}

function destroyCharts() {
  if (tsChart) {
    tsChart.destroy();
    tsChart = null;
  }
  if (asChart) {
    asChart.destroy();
    asChart = null;
  }
}

function initCharts(timeseries, assetStruct, inflation) {
  updateTimeseriesChart(timeseries, inflation);
  updateAssetStructChart(assetStruct);
}

function updateAssetStructChart(assetStruct) {
  const canvas = document.getElementById('assetStructChart');
  if (!canvas) return;
  if (asChart) {
    asChart.destroy();
    asChart = null;
  }
  const entries = Object.entries(assetStruct || {}).filter(([, value]) => value > 0);
  asChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: entries.map(([label]) => label),
      datasets: [
        {
          data: entries.map(([, value]) => value),
          backgroundColor: entries.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#f8fafc', padding: 16 } },
        tooltip: {
          callbacks: {
            label(context) {
              return ` ${context.label}: ${(context.parsed * 100).toFixed(1)}%`;
            },
          },
        },
      },
    },
  });
}

function isAxisBoundary(label, unit) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return false;
  const [, month, day] = label.split('-');
  if (day !== '01') return false;
  if (unit === 'year') return month === '01';
  if (unit === 'quarter') return ['01', '04', '07', '10'].includes(month);
  return true;
}

function formatAxisPeriod(label, unit) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return label;
  const [year, month] = label.split('-');
  if (unit === 'year') return year;
  if (unit === 'quarter') {
    const quarter = Math.floor((Number(month) - 1) / 3) + 1;
    return `${['I', 'II', 'III', 'IV'][quarter - 1]} kw. ${year}`;
  }
  const months = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  return `${months[Number(month) - 1]} ${year}`;
}

function updateTimeseriesChart(data, inflation) {
  const canvas = document.getElementById('timeseriesChart');
  if (!canvas || !data) return;
  if (tsChart) {
    tsChart.destroy();
    tsChart = null;
  }

  const rates = inflation && inflation.rates ? inflation.rates : inflation;
  const hasValuation = Array.isArray(data.portfolio_value_pln);
  const dates = Array.isArray(data.dates) ? data.dates : [];
  const spanDays =
    dates.length > 1
      ? (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000
      : 0;
  // Krótkie zakresy: miesiące, średnie: kwartały, najdłuższe (5 lat/ALL): lata.
  const axisUnit = spanDays <= 200 ? 'month' : spanDays <= 1095 ? 'quarter' : 'year';
  const datasets = [];

  if (hasValuation) {
    datasets.push({
      label: 'Wartość portfela',
      data: data.portfolio_value_pln,
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56, 189, 248, 0.12)',
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
    });
    const real = realValues(data.portfolio_value_pln, dates, rates);
    if (real) {
      datasets.push({
        label: 'Wartość realna (ceny z początku zakresu)',
        data: real,
        borderColor: '#fbbf24',
        borderDash: [4, 3],
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
      });
    }
  }

  datasets.push({
    label: 'Kapitał netto zaangażowany',
    data: data.invested_pln,
    borderColor: '#94a3b8',
    borderDash: [6, 4],
    fill: false,
    tension: 0.1,
    pointRadius: 0,
    borderWidth: 1.5,
  });

  tsChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: data.dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#f8fafc' } },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.parsed.y;
              if (value == null) return `${context.dataset.label}: brak danych`;
              return `${context.dataset.label}: ${formatCurrency(value)}`;
            },
          },
        },
      },
      scales: {
        x: {
          afterBuildTicks(axis) {
            const labels = axis.chart.data.labels || [];
            const ticks = [];
            const seen = new Set();
            labels.forEach((label, index) => {
              if (!isAxisBoundary(label, axisUnit)) return;
              const period = formatAxisPeriod(label, axisUnit);
              if (seen.has(period)) return;
              seen.add(period);
              ticks.push({ value: index, label });
            });
            // Przy krótkim zakresie pierwszy miesiąc/kwartał/rok może nie mieć
            // swojego początku w widoku. Dodaj go na pierwszym punkcie, ale
            // tylko gdy nie zleje się z pierwszą prawdziwą granicą okresu.
            if (labels.length > 0) {
              const firstLabel = labels[0];
              const firstPeriod = formatAxisPeriod(firstLabel, axisUnit);
              const firstBoundary = ticks[0];
              const samePeriod =
                firstBoundary && formatAxisPeriod(firstBoundary.label, axisUnit) === firstPeriod;
              const boundaryIndex = firstBoundary ? firstBoundary.value : labels.length - 1;
              const share = labels.length > 1 ? boundaryIndex / (labels.length - 1) : 1;
              if (!samePeriod && share >= 0.12) {
                ticks.unshift({ value: 0, label: firstLabel });
              }
            }
            axis.ticks = ticks;
          },
          ticks: {
            color: '#94a3b8',
            minRotation: 30,
            maxRotation: 45,
            autoSkip: false,
            callback(value) {
              const raw = this.getLabelForValue ? this.getLabelForValue(value) : value;
              return formatAxisPeriod(String(raw == null ? '' : raw), axisUnit);
            },
          },
          grid: { color: 'rgba(51, 65, 85, 0.6)' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#94a3b8',
            callback: (value) =>
              Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)} tys.` : value,
          },
          grid: { color: 'rgba(51, 65, 85, 0.6)' },
        },
      },
    },
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency: 'PLN',
    maximumFractionDigits: 2,
  }).format(value);
}
