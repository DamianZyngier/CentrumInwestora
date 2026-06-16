const API = {
    async fetchYaml(path) {
        try {
            const response = await fetch(path);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const text = await response.text();
            return jsyaml.load(text);
        } catch (e) {
            console.error(`Failed to load ${path}:`, e);
            return null;
        }
    },

    getMapping: () => API.fetchYaml('data/reference/instruments_mapping.yaml'),
    getTargets: () => API.fetchYaml('data/reference/asset_classes.yaml'),

    async getMarketData(assets, mapping) {
        const quotes = {};
        const fxRates = { "PLNPLN=X": 1.0 };
        const safeMapping = mapping || {};

        try {
            // 1. Fetch ALL FX Rates from NBP Table A
            const response = await fetch('https://api.nbp.pl/api/exchangerates/tables/a/?format=json');
            const data = await response.json();
            if (data && data[0] && data[0].rates) {
                data[0].rates.forEach(r => {
                    fxRates[`${r.code}PLN=X`] = r.mid;
                });
            }
        } catch (e) {
            console.error("Failed to fetch FX rates from NBP:", e);
            // Fallbacks for main currencies
            fxRates["USDPLN=X"] = 4.0; fxRates["EURPLN=X"] = 4.3; fxRates["GBPPLN=X"] = 5.1;
        }

        // 2. Fetch Stock Quotes in Parallel
        const proxy = "https://corsproxy.io/?";
        const fetchQuote = async (walor, gielda) => {
            let symbol = safeMapping[walor]?.yahoo_symbol;
            
            // Dynamic inference if not in mapping
            if (!symbol) {
                const ticker = walor.split(' ')[0].toUpperCase();
                const suffixMap = {
                    'WWA': '.WA',
                    'DEU': '.DE',
                    'XETR': '.DE',
                    'LON': '.L',
                    'LSE': '.L',
                    'FRA': '.F',
                    'PAR': '.PA',
                    'AMS': '.AS',
                    'MIL': '.MI',
                    'MAD': '.MC'
                };
                symbol = ticker + (suffixMap[gielda] || '');
            }

            try {
                const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`)}`;
                const response = await fetch(url);
                const data = await response.json();
                
                const meta = data.chart.result[0].meta;
                quotes[walor] = {
                    last_close: meta.regularMarketPrice || meta.chartPreviousClose,
                    currency: meta.currency,
                    symbol: symbol
                };
            } catch (e) {
                console.error(`Failed to fetch quote for ${symbol} (${walor}):`, e);
                quotes[walor] = { last_close: 0 };
            }
        };

        await Promise.all(Object.entries(assets).map(([walor, gielda]) => fetchQuote(walor, gielda)));
        
        return { quotes, fxRates };
    }
};
