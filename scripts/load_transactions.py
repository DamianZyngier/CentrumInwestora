import pandas as pd
from pathlib import Path
import hashlib

COLUMNS = [
    "Walor", "Giełda", "K/S", "Liczba", "Kurs", "Waluta",
    "Wartość", "Prowizja", "Czas transakcji",
    "Waluta rozliczenia", "Kurs Przewalutowania",
]

def clean_numeric(series):
    return pd.to_numeric(series.astype(str).str.replace(",", "."), errors='coerce')

def read_single_csv(path: Path) -> pd.DataFrame:
    print(f"Reading {path}...")
    df = pd.read_csv(
        path,
        sep=";",
        decimal=",",
        dtype=str,
        encoding="utf-8-sig",
    )
    
    # Ensure all required columns exist
    for col in COLUMNS:
        if col not in df.columns:
            df[col] = ""
            
    df = df[COLUMNS].copy()

    # Data conversion
    df["Liczba"] = clean_numeric(df["Liczba"])
    df["Kurs"] = clean_numeric(df["Kurs"])
    df["Wartość"] = clean_numeric(df["Wartość"])
    df["Prowizja"] = clean_numeric(df["Prowizja"]).fillna(0.0)
    
    # Currency conversion rate logic
    df["Kurs Przewalutowania"] = clean_numeric(df["Kurs Przewalutowania"])
    # If settlement is PLN and rate is missing/empty, it's 1.0
    df.loc[(df["Waluta rozliczenia"] == "PLN") & (df["Kurs Przewalutowania"].isna()), "Kurs Przewalutowania"] = 1.0
    # Fill remaining NaNs with 1.0 as fallback
    df["Kurs Przewalutowania"] = df["Kurs Przewalutowania"].fillna(1.0)

    df["Czas transakcji"] = pd.to_datetime(df["Czas transakcji"], format="%d.%m.%Y %H:%M:%S", errors='coerce')
    
    return df

def merge_and_clean_transactions(raw_dir: Path, processed_dir: Path) -> pd.DataFrame:
    frames = []
    for csv_path in raw_dir.glob("*.csv"):
        frames.append(read_single_csv(csv_path))

    if not frames:
        print("No CSV files found in data/raw/")
        return pd.DataFrame(columns=COLUMNS)

    df = pd.concat(frames, ignore_index=True)

    # Deduplication based on content hash
    # We use string representation for hashing to be safe
    df["row_hash"] = df.apply(lambda r: hashlib.md5(str(r.to_dict()).encode()).hexdigest(), axis=1)
    
    initial_len = len(df)
    df = df.drop_duplicates(subset=["row_hash"]).drop(columns=["row_hash"])
    print(f"Merged {len(frames)} files. Removed {initial_len - len(df)} duplicates. Total: {len(df)} transactions.")

    # Calculate PLN values
    df["value_pln"] = df["Wartość"] * df["Kurs Przewalutowania"]
    df["fee_pln"] = df["Prowizja"] * df["Kurs Przewalutowania"]

    # Cash flow: buy is negative (outflow), sell is positive (inflow)
    df["cash_flow_pln"] = df.apply(
        lambda r: -(r["value_pln"] + r["fee_pln"]) if r["K/S"] == "Kupno"
        else (r["value_pln"] - r["fee_pln"]),
        axis=1,
    )

    processed_dir.mkdir(parents=True, exist_ok=True)
    df.to_parquet(processed_dir / "transactions_merged.parquet", index=False)
    df.to_csv(processed_dir / "transactions_merged.csv", index=False, sep=";")
    
    return df

if __name__ == "__main__":
    BASE_DIR = Path(__file__).resolve().parent.parent
    merge_and_clean_transactions(
        raw_dir=BASE_DIR / "data" / "raw",
        processed_dir=BASE_DIR / "data" / "processed"
    )
