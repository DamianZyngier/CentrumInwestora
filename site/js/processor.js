const Processor = {
    parseCSV(file) {
        return new Promise((resolve) => {
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                delimiter: ";",
                complete: (results) => {
                    const normalized = results.data.map(row => this.normalizeRow(row));
                    resolve(normalized);
                }
            });
        });
    },

    normalizeRow(row) {
        const cleanNum = (val) => {
            if (!val) return 0;
            return parseFloat(String(val).replace(',', '.').replace(/\s/g, '')) || 0;
        };

        const kursPrze = cleanNum(row['Kurs Przewalutowania']);
        const rate = (row['Waluta rozliczenia'] === 'PLN' && kursPrze === 0) ? 1.0 : (kursPrze || 1.0);

        const value_pln = cleanNum(row['Wartość']) * rate;
        const fee_pln = cleanNum(row['Prowizja']) * rate;

        return {
            walor: row['Walor'],
            gielda: row['Giełda'],
            ks: row['K/S'],
            liczba: cleanNum(row['Liczba']),
            kurs: cleanNum(row['Kurs']),
            waluta: row['Waluta'],
            wartosc: cleanNum(row['Wartość']),
            prowizja: cleanNum(row['Prowizja']),
            data: row['Czas transakcji'],
            timestamp: this.parseDate(row['Czas transakcji']),
            waluta_rozliczenia: row['Waluta rozliczenia'],
            kurs_przewalutowania: rate,
            value_pln: value_pln,
            fee_pln: fee_pln,
            cash_flow_pln: row['K/S'] === 'Kupno' ? -(value_pln + fee_pln) : (value_pln - fee_pln)
        };
    },

    parseDate(dateStr) {
        if (!dateStr) return 0;
        // Format: 23.02.2026 09:04:48
        const parts = dateStr.split(' ');
        const dateParts = parts[0].split('.');
        return new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${parts[1] || '00:00:00'}`).getTime();
    },

    async calculateMetrics(transactions, mapping, targets, quotes, fxRates) {
        const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
        const positions = {}; // walor -> {units, cost_basis_pln, realized_pl_pln}

        for (const t of sorted) {
            const w = t.walor;
            if (!positions[w]) positions[w] = { units: 0, cost_basis_pln: 0, realized_pl_pln: 0 };

            if (t.ks === 'Kupno') {
                positions[w].units += t.liczba;
                positions[w].cost_basis_pln += t.value_pln + t.fee_pln;
            } else {
                if (positions[w].units > 0) {
                    const avg_cost = positions[w].cost_basis_pln / positions[w].units;
                    const cost_of_sold = avg_cost * t.liczba;
                    const sale_proceeds = t.value_pln - t.fee_pln;
                    
                    positions[w].realized_pl_pln += (sale_proceeds - cost_of_sold);
                    positions[w].units -= t.liczba;
                    positions[w].cost_basis_pln -= cost_of_sold;
                }
            }
        }

        let total_value_pln = 0;
        let total_cost_basis_pln = 0;
        let total_realized_pl_pln = 0;
        const portfolio_list = [];

        for (const [walor, pos] of Object.entries(positions)) {
            if (pos.units <= 0.0001 && pos.realized_pl_pln === 0) continue;

            const m = mapping[walor] || {};
            const quote = quotes[walor] || { last_close: 0 };
            const fxRate = fxRates[`${m.currency || 'PLN'}PLN=X`] || 1.0;

            const current_price_pln = quote.last_close * fxRate;
            const current_value_pln = pos.units * current_price_pln;
            const unrealized_pl_pln = current_value_pln - pos.cost_basis_pln;

            total_value_pln += current_value_pln;
            total_cost_basis_pln += pos.cost_basis_pln;
            total_realized_pl_pln += pos.realized_pl_pln;

            portfolio_list.push({
                walor,
                asset_class: m.asset_class || 'Other',
                units: pos.units,
                avg_cost_pln: pos.units > 0 ? pos.cost_basis_pln / pos.units : 0,
                current_price_pln,
                current_value_pln,
                unrealized_pl_pln,
                realized_pl_pln: pos.realized_pl_pln,
                weight: 0
            });
        }

        // Finalize weights and structures
        const struct_asset = {};
        portfolio_list.forEach(p => {
            p.weight = total_value_pln > 0 ? p.current_value_pln / total_value_pln : 0;
            struct_asset[p.asset_class] = (struct_asset[p.asset_class] || 0) + p.weight;
        });

        // Timeseries
        const daily_cf = {};
        sorted.forEach(t => {
            if (!t.data || typeof t.data !== 'string') return;
            const d = t.data.split(' ')[0];
            daily_cf[d] = (daily_cf[d] || 0) + t.cash_flow_pln;
        });
        
        const dates = Object.keys(daily_cf).sort();
        let cum_invested = 0;
        const invested_pln = dates.map(d => {
            cum_invested += daily_cf[d];
            return -cum_invested;
        });

        return {
            summary: {
                total_value_pln,
                total_cost_basis_pln,
                realized_pl_pln: total_realized_pl_pln,
                last_updated: new Date().toLocaleString()
            },
            portfolio_list,
            struct_asset,
            timeseries: {
                dates,
                invested_pln,
                portfolio_value_pln: [...invested_pln] // simplified placeholder
            }
        };
    }
};
