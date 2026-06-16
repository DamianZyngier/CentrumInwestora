document.addEventListener('DOMContentLoaded', async () => {
    const [summary, timeseries, assetStruct, portfolio, transactions, recs] = await Promise.all([
        API.getSummary(),
        API.getTimeseries(),
        API.getStructureAsset(),
        API.getPortfolioList(),
        API.getTransactions(),
        API.getRecommendations()
    ]);

    if (!summary) return;

    renderSummary(summary);
    initCharts(timeseries, assetStruct);
    renderPortfolio(portfolio);
    renderRecommendations(recs);
    renderTransactions(transactions);

    // Filters
    document.getElementById('search-ticker').addEventListener('input', () => filterTransactions(transactions));
    document.getElementById('filter-type').addEventListener('change', () => filterTransactions(transactions));

    // Time Range Selector
    document.getElementById('time-range-selector').addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const range = e.target.dataset.range;
            
            // Toggle active class
            document.querySelectorAll('#time-range-selector button').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');

            const filteredData = filterTimeseriesData(timeseries, range);
            updateTimeseriesChart(filteredData);
        }
    });
});

function filterTimeseriesData(data, range) {
    if (range === 'all') return data;

    const now = new Date();
    let cutoffDate = new Date();

    if (range === '1m') cutoffDate.setMonth(now.getMonth() - 1);
    else if (range === '3m') cutoffDate.setMonth(now.getMonth() - 3);
    else if (range === '6m') cutoffDate.setMonth(now.getMonth() - 6);
    else if (range === '1y') cutoffDate.setFullYear(now.getFullYear() - 1);
    else if (range === '2y') cutoffDate.setFullYear(now.getFullYear() - 2);
    else if (range === '5y') cutoffDate.setFullYear(now.getFullYear() - 5);

    const cutoffStr = cutoffDate.toISOString().split('T')[0];
    
    const indices = data.dates.map((d, i) => d >= cutoffStr ? i : -1).filter(i => i !== -1);
    
    return {
        dates: indices.map(i => data.dates[i]),
        invested_pln: indices.map(i => data.invested_pln[i]),
        portfolio_value_pln: indices.map(i => data.portfolio_value_pln[i])
    };
}

function formatPLN(val) {
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(val);
}

function renderSummary(s) {
    document.getElementById('total-value').textContent = formatPLN(s.total_value_pln);
    document.getElementById('total-invested').textContent = formatPLN(s.total_cost_basis_pln);
    
    const pl = s.total_value_pln - s.total_cost_basis_pln;
    const plPercent = s.total_cost_basis_pln > 0 ? (pl / s.total_cost_basis_pln) * 100 : 0;
    
    const plEl = document.getElementById('total-pl');
    plEl.textContent = formatPLN(pl);
    plEl.className = 'value ' + (pl >= 0 ? 'positive' : 'negative');

    const plpEl = document.getElementById('total-pl-percent');
    plpEl.textContent = plPercent.toFixed(2) + '%';
    plpEl.className = 'value ' + (pl >= 0 ? 'positive' : 'negative');

    document.getElementById('last-updated').textContent = s.last_updated;
}

function renderPortfolio(list) {
    const tbody = document.getElementById('portfolio-body');
    tbody.innerHTML = list.map(item => `
        <tr>
            <td><strong>${item.walor}</strong></td>
            <td>${item.asset_class}</td>
            <td>${item.units.toFixed(4)}</td>
            <td>${formatPLN(item.avg_cost_pln)}</td>
            <td>${formatPLN(item.current_price_pln)}</td>
            <td>${formatPLN(item.current_value_pln)}</td>
            <td class="${item.unrealized_pl_pln >= 0 ? 'positive' : 'negative'}">
                ${formatPLN(item.unrealized_pl_pln)}
            </td>
            <td>${(item.weight * 100).toFixed(1)}%</td>
        </tr>
    `).join('');
}

function renderRecommendations(recs) {
    const container = document.getElementById('recommendations-container');
    if (!recs || recs.items.length === 0) {
        container.innerHTML = '<p class="rec-msg">Portfel jest zrównoważony. Brak uwag.</p>';
        return;
    }

    container.innerHTML = recs.items.map(item => `
        <div class="recommendation-item ${item.type}">
            <div class="rec-header">
                <span>${item.type}: ${item.category}</span>
                <span>${item.current} (cel: ${item.target})</span>
            </div>
            <div class="rec-msg">${item.message}</div>
        </div>
    `).join('');
}

function renderTransactions(data) {
    const tbody = document.getElementById('transactions-body');
    tbody.innerHTML = data.map(t => `
        <tr>
            <td>${t['Czas transakcji']}</td>
            <td>${t['Walor']}</td>
            <td>${t['K/S']}</td>
            <td>${t['Liczba']}</td>
            <td>${t['Kurs']} ${t['Waluta']}</td>
            <td>${formatPLN(t['value_pln'])}</td>
            <td>${formatPLN(t['fee_pln'])}</td>
        </tr>
    `).join('');
}

function filterTransactions(data) {
    const search = document.getElementById('search-ticker').value.toLowerCase();
    const type = document.getElementById('filter-type').value;

    const filtered = data.filter(t => {
        const matchSearch = t['Walor'].toLowerCase().includes(search);
        const matchType = type === "" || t['K/S'] === type;
        return matchSearch && matchType;
    });

    renderTransactions(filtered);
}
