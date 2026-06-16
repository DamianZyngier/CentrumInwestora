async function fetchJson(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (e) {
        console.error(`Failed to load ${path}:`, e);
        return null;
    }
}

const API = {
    getSummary: () => fetchJson('data/portfolio_summary.json'),
    getTimeseries: () => fetchJson('data/portfolio_timeseries.json'),
    getStructureExchange: () => fetchJson('data/portfolio_structure_exchange.json'),
    getStructureAsset: () => fetchJson('data/portfolio_structure_asset_class.json'),
    getPortfolioList: () => fetchJson('data/portfolio_list.json'),
    getTransactions: () => fetchJson('data/transactions_table.json'),
    getRecommendations: () => fetchJson('data/recommendations.json')
};
