import pandas as pd
import json
import yaml
from pathlib import Path

def load_json(path: Path):
    if not path.exists(): return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def load_yaml(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def build_all_metrics(processed_dir: Path, reference_dir: Path, output_dir: Path):
    print("Calculating portfolio metrics...")
    df = pd.read_parquet(processed_dir / "transactions_merged.parquet")
    quotes = load_json(processed_dir / "quotes_latest.json")
    fx_rates = load_json(processed_dir / "fx_rates_latest.json")
    mapping = load_yaml(reference_dir / "instruments_mapping.yaml")
    
    # 1. Calculate Current Positions
    df = df.sort_values("Czas transakcji")
    positions = {} # Walor -> {units, cost_basis_pln, realized_pl_pln}
    
    for _, row in df.iterrows():
        walor = row["Walor"]
        if walor not in positions:
            positions[walor] = {"units": 0.0, "cost_basis_pln": 0.0, "realized_pl_pln": 0.0}
        
        if row["K/S"] == "Kupno":
            # Add to units and cost basis
            positions[walor]["units"] += row["Liczba"]
            positions[walor]["cost_basis_pln"] += row["value_pln"] + row["fee_pln"]
        else:
            # Sell: Calculate realized P/L based on average cost
            if positions[walor]["units"] > 0:
                avg_cost = positions[walor]["cost_basis_pln"] / positions[walor]["units"]
                sold_units = row["Liczba"]
                cost_of_sold = avg_cost * sold_units
                sale_proceeds = row["value_pln"] - row["fee_pln"]
                
                positions[walor]["realized_pl_pln"] += (sale_proceeds - cost_of_sold)
                positions[walor]["units"] -= sold_units
                positions[walor]["cost_basis_pln"] -= cost_of_sold
            else:
                # Short selling not handled or data error
                positions[walor]["units"] -= row["Liczba"]

    # 2. Market Valuation
    portfolio_list = []
    total_value_pln = 0.0
    total_cost_basis_pln = 0.0
    total_realized_pl_pln = 0.0
    
    for walor, pos in positions.items():
        if pos["units"] <= 0.0001 and pos["realized_pl_pln"] == 0: continue
        
        quote = quotes.get(walor, {})
        last_price = quote.get("last_close", 0.0)
        currency = quote.get("currency", "PLN")
        
        # FX conversion
        fx_key = f"{currency}PLN=X"
        fx_rate = fx_rates.get(fx_key, 1.0)
        
        current_price_pln = last_price * fx_rate
        current_value_pln = pos["units"] * current_price_pln
        unrealized_pl_pln = current_value_pln - pos["cost_basis_pln"] if pos["units"] > 0 else 0.0
        
        total_value_pln += current_value_pln
        total_cost_basis_pln += pos["cost_basis_pln"]
        total_realized_pl_pln += pos["realized_pl_pln"]
        
        portfolio_list.append({
            "walor": walor,
            "giełda": mapping.get(walor, {}).get("exchange", "Unknown"),
            "units": pos["units"],
            "avg_cost_pln": pos["cost_basis_pln"] / pos["units"] if pos["units"] > 0 else 0,
            "current_price_pln": current_price_pln,
            "current_value_pln": current_value_pln,
            "unrealized_pl_pln": unrealized_pl_pln,
            "realized_pl_pln": pos["realized_pl_pln"],
            "asset_class": mapping.get(walor, {}).get("asset_class", "Other"),
            "weight": 0.0 # Will calculate after total
        })

    # Calculate weights
    for item in portfolio_list:
        if total_value_pln > 0:
            item["weight"] = item["current_value_pln"] / total_value_pln

    # 3. Summary
    summary = {
        "total_value_pln": total_value_pln,
        "total_cost_basis_pln": total_cost_basis_pln,
        "unrealized_pl_pln": total_value_pln - total_cost_basis_pln,
        "realized_pl_pln": total_realized_pl_pln,
        "total_pl_pln": (total_value_pln - total_cost_basis_pln) + total_realized_pl_pln,
        "last_updated": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S")
    }

    # 4. Timeseries (Simplified: Daily cumulative cash flow)
    df["date"] = df["Czas transakcji"].dt.date
    ts_invested = df.groupby("date")["cash_flow_pln"].sum().cumsum()
    
    # Portfolio value over time requires historical quotes, for now we show invested capital
    # and use the latest value for the 'today' point
    timeseries = {
        "dates": [d.isoformat() for d in ts_invested.index],
        "invested_pln": ts_invested.values.tolist(),
        # For a true timeseries we'd need historical quotes. Placeholder:
        "portfolio_value_pln": ts_invested.values.tolist() 
    }
    # Add today's point
    today_str = pd.Timestamp.now().date().isoformat()
    if today_str not in timeseries["dates"]:
        timeseries["dates"].append(today_str)
        timeseries["invested_pln"].append(-df["cash_flow_pln"].sum()) # Invested is negative of sum of CFs
        timeseries["portfolio_value_pln"].append(total_value_pln)
    else:
        timeseries["portfolio_value_pln"][-1] = total_value_pln

    # 5. Structure
    struct_exchange = {}
    struct_asset = {}
    for item in portfolio_list:
        struct_exchange[item["giełda"]] = struct_exchange.get(item["giełda"], 0.0) + item["weight"]
        struct_asset[item["asset_class"]] = struct_asset.get(item["asset_class"], 0.0) + item["weight"]

    # Save all to output
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / "portfolio_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    with open(output_dir / "portfolio_timeseries.json", "w", encoding="utf-8") as f:
        json.dump(timeseries, f, indent=2)
    with open(output_dir / "portfolio_structure_exchange.json", "w", encoding="utf-8") as f:
        json.dump(struct_exchange, f, indent=2)
    with open(output_dir / "portfolio_structure_asset_class.json", "w", encoding="utf-8") as f:
        json.dump(struct_asset, f, indent=2)
    with open(output_dir / "portfolio_list.json", "w", encoding="utf-8") as f:
        json.dump(portfolio_list, f, indent=2)
    
    # Transactions for table
    df_table = df.copy()
    df_table["Czas transakcji"] = df_table["Czas transakcji"].dt.strftime("%Y-%m-%d %H:%M:%S")
    df_table.to_json(output_dir / "transactions_table.json", orient="records", date_format="iso")

    print("Portfolio metrics calculated and saved.")
    return {"portfolio_list": portfolio_list, "structure_asset_class": struct_asset}

if __name__ == "__main__":
    BASE_DIR = Path(__file__).resolve().parent.parent
    build_all_metrics(
        processed_dir=BASE_DIR / "data" / "processed",
        reference_dir=BASE_DIR / "data" / "reference",
        output_dir=BASE_DIR / "data" / "output"
    )
