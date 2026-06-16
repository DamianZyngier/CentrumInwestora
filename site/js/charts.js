function initCharts(timeseries, assetStruct) {
    // Timeseries Chart
    const tsCtx = document.getElementById('timeseriesChart').getContext('2d');
    new Chart(tsCtx, {
        type: 'line',
        data: {
            labels: timeseries.dates,
            datasets: [
                {
                    label: 'Kapitał Wpłacony',
                    data: timeseries.invested_pln,
                    borderColor: '#94a3b8',
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.1
                },
                {
                    label: 'Wartość Portfela',
                    data: timeseries.portfolio_value_pln,
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.1)',
                    fill: true,
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#f8fafc' } }
            },
            scales: {
                x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
                y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });

    // Asset Structure Chart
    const asCtx = document.getElementById('assetStructChart').getContext('2d');
    new Chart(asCtx, {
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
