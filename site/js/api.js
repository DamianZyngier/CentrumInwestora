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

    async getMarketData(walory, mapping) {
        const quotes = {};
        const fxRates = { "PLNPLN=X": 1.0 };
        const safeMapping = mapping || {};

        try {
            // 1. Fetch FX Rates from NBP
            const [usd, eur, gbp] = await Promise.all([
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json').then(r => r.json()),
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json').then(r => r.json()),
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/gbp/?format=json').then(r => r.json())
            ]);

            fxRates["USDPLN=X"] = usd.rates[0].mid;
            fxRates["EURPLN=X"] = eur.rates[0].mid;
            fxRates["GBPPLN=X"] = gbp.rates[0].mid;
        } catch (e) {
            console.error("Failed to fetch FX rates:", e);
            // Basic fallbacks
            fxRates["USDPLN=X"] = 4.1; fxRates["EURPLN=X"] = 4.3; fxRates["GBPPLN=X"] = 5.1;
        }

        // 2. Fetch Stock Quotes from Yahoo Finance via CORS Proxy
        // We use a public proxy to bypass CORS restrictions
        const proxy = "https://corsproxy.io/?";
        
        for (const walor of walory) {
            const symbol = safeMapping[walor]?.yahoo_symbol;
            if (!symbol) {
                quotes[walor] = { last_close: 0 };
                continue;
            }

            try {
                const url = `${proxy}${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`)}`;
                const response = await fetch(url);
                const data = await response.json();
                
                const meta = data.chart.result[0].meta;
                quotes[walor] = {
                    last_close: meta.regularMarketPrice || meta.chartPreviousClose,
                    currency: meta.currency
                };
            } catch (e) {
                console.error(`Failed to fetch quote for ${symbol}:`, e);
                quotes[walor] = { last_close: 0 };
            }
        }
        
        return { quotes, fxRates };
    }
};
