import json
import yaml
from pathlib import Path
import pandas as pd
import yfinance as yf

def load_config(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

def fetch_all_market_data(processed_dir: Path, reference_dir: Path):
    print("Fetching market data...")
    mapping = load_config(reference_dir / "instruments_mapping.yaml")
    
    # Load transactions to see what we actually need
    transactions_path = processed_dir / "transactions_merged.parquet"
    if not transactions_path.exists():
        print("No processed transactions found. Run load_transactions.py first.")
        return

    df = pd.read_parquet(transactions_path)
    walory = df["Walor"].unique().tolist()
    
    # 1. Fetch Latest Quotes
    latest_quotes = {}
    for walor in walory:
        if walor in mapping:
            symbol = mapping[walor]["yahoo_symbol"]
            print(f"Fetching quote for {walor} ({symbol})...")
            try:
                ticker = yf.Ticker(symbol)
                # Use fast_info if available or history
                info = ticker.history(period="1d")
                if not info.empty:
                    latest_quotes[walor] = {
                        "symbol": symbol,
                        "last_close": float(info["Close"].iloc[-1]),
                        "currency": mapping[walor]["currency"]
                    }
                else:
                    print(f"Warning: No data for {symbol}")
            except Exception as e:
                print(f"Error fetching {symbol}: {e}")

    # 2. Fetch FX Rates
    # Common pairs against PLN
    fx_pairs = ["EURPLN=X", "USDPLN=X", "GBPPLN=X"]
    fx_latest = {"PLNPLN=X": 1.0}
    
    for pair in fx_pairs:
        print(f"Fetching FX rate for {pair}...")
        try:
            ticker = yf.Ticker(pair)
            info = ticker.history(period="1d")
            if not info.empty:
                fx_latest[pair] = float(info["Close"].iloc[-1])
            else:
                print(f"Warning: No data for FX {pair}")
        except Exception as e:
            print(f"Error fetching FX {pair}: {e}")

    # Save outputs
    output_dir = processed_dir
    with open(output_dir / "quotes_latest.json", "w", encoding="utf-8") as f:
        json.dump(latest_quotes, f, indent=2)
    
    with open(output_dir / "fx_rates_latest.json", "w", encoding="utf-8") as f:
        json.dump(fx_latest, f, indent=2)
    
    print("Market data fetched and saved.")

if __name__ == "__main__":
    BASE_DIR = Path(__file__).resolve().parent.parent
    fetch_all_market_data(
        processed_dir=BASE_DIR / "data" / "processed",
        reference_dir=BASE_DIR / "data" / "reference"
    )
