'use strict';

let tsChart = null;
let asChart = null;

const CHART_COLORS = ['#38bdf8', '#818cf8', '#fb7185', '#fbbf24', '#34d399', '#a78bfa', '#f472b6', '#22d3ee'];

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

function initCharts(timeseries, assetStruct) {
  updateTimeseriesChart(timeseries);
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

function updateTimeseriesChart(data) {
  const canvas = document.getElementById('timeseriesChart');
  if (!canvas || !data) return;
  if (tsChart) {
    tsChart.destroy();
    tsChart = null;
  }

  const hasValuation = Array.isArray(data.portfolio_value_pln);
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
          ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
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
