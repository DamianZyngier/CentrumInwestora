document.addEventListener('DOMContentLoaded', async () => {
    await refreshDashboard();

    // File Upload Handling
    const fileInput = document.getElementById('csv-file-input');
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const statusEl = document.getElementById('import-status');
        statusEl.textContent = `Przetwarzanie ${files.length} plików...`;

        let totalNew = 0;
        for (const file of files) {
            const transactions = await Processor.parseCSV(file);
            await DB.saveTransactions(transactions);
            totalNew += transactions.length;
        }

        statusEl.textContent = `Pomyślnie załadowano ${totalNew} transakcji.`;
        await refreshDashboard();
    });

    // Clear DB Handling
    document.getElementById('clear-db-btn').addEventListener('click', async () => {
        if (confirm('Czy na pewno chcesz usunąć wszystkie załadowane dane?')) {
            await DB.clearAll();
            location.reload();
        }
    });

    // Range Selector
    document.getElementById('time-range-selector').addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const range = e.target.dataset.range;
            document.querySelectorAll('#time-range-selector button').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');
            // Re-render chart with new range
            // (Requires storing last metrics)
            if (window.lastMetrics) {
                const filtered = filterTimeseriesData(window.lastMetrics.timeseries, range);
                updateTimeseriesChart(filtered);
            }
        }
    });

    // Filters
    document.getElementById('search-ticker').addEventListener('input', () => {
        if (window.lastTransactions) filterTransactions(window.lastTransactions);
    });
    document.getElementById('filter-type').addEventListener('change', () => {
        if (window.lastTransactions) filterTransactions(window.lastTransactions);
    });
});

async function refreshDashboard() {
    const transactions = await DB.getAllTransactions();
    if (transactions.length === 0) {
        document.getElementById('dashboard-content').style.display = 'none';
        return;
    }

    document.getElementById('dashboard-content').style.display = 'block';
    
    // Load reference data
    const mapping = await API.getMapping();
    const targets = await API.getTargets();
    
    // Get market data
    const walory = [...new Set(transactions.map(t => t.walor))];
    const { quotes, fxRates } = await API.getMarketData(walory, mapping);

    // Calculate metrics
    const metrics = await Processor.calculateMetrics(transactions, mapping, targets, quotes, fxRates);
    window.lastMetrics = metrics;
    window.lastTransactions = transactions;

    // Render
    renderSummary(metrics.summary);
    initCharts(metrics.timeseries, metrics.struct_asset);
    renderPortfolio(metrics.portfolio_list);
    renderRecommendations(metrics.summary, metrics.struct_asset, targets.targets);
    renderTransactions(transactions);
}

function filterTimeseriesData(data, range) {
    if (range === 'all') return data;
    const now = new Date();
    let cutoff = new Date();
    if (range === '1m') cutoff.setMonth(now.getMonth() - 1);
    else if (range === '3m') cutoff.setMonth(now.getMonth() - 3);
    else if (range === '6m') cutoff.setMonth(now.getMonth() - 6);
    else if (range === '1y') cutoff.setFullYear(now.getFullYear() - 1);
    else if (range === '2y') cutoff.setFullYear(now.getFullYear() - 2);
    else if (range === '5y') cutoff.setFullYear(now.getFullYear() - 5);

    const cutoffStr = cutoff.toISOString().split('T')[0];
    const indices = data.dates.map((d, i) => d >= cutoffStr ? i : -1).filter(i => i !== -1);
    
    return {
        dates: indices.map(i => data.dates[i]),
        invested_pln: indices.map(i => data.invested_pln[i]),
        portfolio_value_pln: indices.map(i => data.portfolio_value_pln[i])
    };
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

function renderRecommendations(summary, struct, targets) {
    const container = document.getElementById('recommendations-container');
    const recs = [];

    for (const [cat, target] of Object.entries(targets)) {
        const current = struct[cat] || 0;
        const diff = current - target;
        if (diff < -0.05) {
            recs.push({ type: 'NIEDOWAGA', category: cat, message: `Kategoria '${cat}' niedoważona o ${Math.abs(diff*100).toFixed(1)}%.`, current: `${(current*100).toFixed(1)}%`, target: `${(target*100).toFixed(1)}%` });
        } else if (diff > 0.05) {
            recs.push({ type: 'PRZEWAGA', category: cat, message: `Kategoria '${cat}' przeważona o ${(diff*100).toFixed(1)}%.`, current: `${(current*100).toFixed(1)}%`, target: `${(target*100).toFixed(1)}%` });
        }
    }

    if (recs.length === 0) {
        container.innerHTML = '<p class="rec-msg">Portfel jest zrównoważony. Brak uwag.</p>';
        return;
    }

    container.innerHTML = recs.map(item => `
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
    tbody.innerHTML = [...data].sort((a,b) => b.timestamp - a.timestamp).map(t => `
        <tr>
            <td>${t.data}</td>
            <td>${t.walor}</td>
            <td>${t.ks}</td>
            <td>${t.liczba}</td>
            <td>${t.kurs} ${t.waluta}</td>
            <td>${formatPLN(t.value_pln)}</td>
            <td>${formatPLN(t.fee_pln)}</td>
        </tr>
    `).join('');
}

function filterTransactions(data) {
    const search = document.getElementById('search-ticker').value.toLowerCase();
    const type = document.getElementById('filter-type').value;

    const filtered = data.filter(t => {
        const matchSearch = t.walor.toLowerCase().includes(search);
        const matchType = type === "" || t.ks === type;
        return matchSearch && matchType;
    });

    renderTransactions(filtered);
}

function formatPLN(val) {
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(val);
}
