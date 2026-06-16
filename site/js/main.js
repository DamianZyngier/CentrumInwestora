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
});

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
