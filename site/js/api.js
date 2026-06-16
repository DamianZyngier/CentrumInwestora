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

    getMapping: () => API.fetchYaml('../data/reference/instruments_mapping.yaml'),
    getTargets: () => API.fetchYaml('../data/reference/asset_classes.yaml'),

    async getMarketData(walory, mapping) {
        const quotes = {};
        const fxRates = { "PLNPLN=X": 1.0 };

        try {
            // Fetch FX Rates from NBP (Poland's Central Bank) - no API key needed
            const [usd, eur, gbp] = await Promise.all([
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json').then(r => r.json()),
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json').then(r => r.json()),
                fetch('https://api.nbp.pl/api/exchangerates/rates/a/gbp/?format=json').then(r => r.json())
            ]);

            fxRates["USDPLN=X"] = usd.rates[0].mid;
            fxRates["EURPLN=X"] = eur.rates[0].mid;
            fxRates["GBPPLN=X"] = gbp.rates[0].mid;
        } catch (e) {
            console.error("Failed to fetch real FX rates, using fallbacks:", e);
            fxRates["USDPLN=X"] = 4.0;
            fxRates["EURPLN=X"] = 4.3;
            fxRates["GBPPLN=X"] = 5.0;
        }

        // For stocks, we use a mock price for now. 
        // Real-time stock prices in browser require an API key (e.g. Finnhub, Alpha Vantage)
        for (const walor of walory) {
            quotes[walor] = { last_close: 100.0 }; // Placeholder
        }
        
        return { quotes, fxRates };
    }
};
