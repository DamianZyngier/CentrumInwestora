let tsChart = null;
let asChart = null;

function initCharts(timeseries, assetStruct) {
    updateTimeseriesChart(timeseries);

    // Asset Structure Chart
    const asCtx = document.getElementById('assetStructChart').getContext('2d');
    asChart = new Chart(asCtx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(assetStruct),
            datasets: [{
                data: Object.values(assetStruct),
                backgroundColor: [
                    '#38bdf8', '#818cf8', '#fb7185', '#fbbf24', '#34d399', '#a78bfa'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { 
                    position: 'bottom',
                    labels: { color: '#f8fafc', padding: 20 } 
                }
            }
        }
    });
}

function updateTimeseriesChart(data) {
    const tsCtx = document.getElementById('timeseriesChart').getContext('2d');
    
    if (tsChart) {
        tsChart.destroy();
    }

    tsChart = new Chart(tsCtx, {
        type: 'line',
        data: {
            labels: data.dates,
            datasets: [
                {
                    label: 'Kapitał Wpłacony',
                    data: data.invested_pln,
                    borderColor: '#94a3b8',
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0
                },
                {
                    label: 'Wartość Portfela',
                    data: data.portfolio_value_pln,
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 2,
                    pointBackgroundColor: '#38bdf8'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { labels: { color: '#f8fafc' } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: { 
                    ticks: { color: '#94a3b8', maxRotation: 0 }, 
                    grid: { color: '#334155' } 
                },
                y: { 
                    ticks: { 
                        color: '#94a3b8',
                        callback: (value) => value >= 1000 ? (value/1000).toFixed(0) + 'k' : value
                    }, 
                    grid: { color: '#334155' } 
                }
            }
        }
    });
}
