# Plan Implementacji: Centrum Inwestora

Projekt dashboardu inwestycyjnego opartego na danych statycznych (GitHub Actions + GitHub Pages).

## 1. Architektura Systemu
System działa w cyklu: **CSV (Raw) -> Python Pipeline -> JSON (Output) -> JS Dashboard**.

### Struktura Katalogów
- [x] `data/raw/`: Wejściowe pliki CSV od brokera (separator `;`).
- [x] `data/processed/`: Dane po oczyszczeniu i deduplikacji (format Parquet/CSV).
- [x] `data/reference/`: 
    - [x] `instruments_mapping.yaml`: Mapowanie nazwy z CSV na symbol Yahoo Finance i klasę aktywów.
    - [x] `asset_classes.yaml`: Definicja docelowej struktury portfela (rebalancing).
- [x] `data/output/`: Pliki JSON dla frontendu (`portfolio_summary.json`, `portfolio_timeseries.json`, itd.).
- [x] `scripts/`: Logika przetwarzania w Pythonie.
- [x] `site/`: Statyczny dashboard HTML/JS.
- [x] `.github/workflows/`: Automatyzacja wdrożenia.

## 2. Moduły Python (scripts/)
1. [x] **load_transactions.py**:
    - Czytanie wszystkich plików z `data/raw/`.
    - Normalizacja (przecinek na kropkę, formaty dat).
    - Obliczanie `cash_flow_pln` (uwzględnianie prowizji i kursów walut).
    - Deduplikacja na podstawie unikalnego hasha wiersza.
2. [x] **fetch_market_data.py**:
    - Pobieranie cen przez `yfinance`.
    - Pobieranie kursów walut (FX).
3. [x] **calc_portfolio.py**:
    - Obliczanie aktualnych pozycji (liczba jednostek).
    - Obliczanie kosztu nabycia (metoda średniej ważonej lub FIFO).
    - Generowanie serii czasowej (wartość portfela vs wpłaty).
4. [x] **recommendations.py**:
    - Porównywanie aktualnego stanu z `asset_classes.yaml`.
    - Generowanie komunikatów o niedowadze/przewadze.
5. [x] **pipeline.py**: Orchestrator uruchamiający powyższe moduły.

## 3. Frontend (site/)
- [x] **Technologia**: Vanilla JS + Chart.js + CSS Grid.
- [x] **Funkcje**:
    - Filtrowanie tabeli transakcji.
    - Wykresy kołowe struktury.
    - Wykres liniowy wzrostu kapitału.
    - Karty z metrykami (Total Value, P/L, Invested).

## 4. Dane wejściowe (CSV)
Wymagane kolumny: `Walor`, `Giełda`, `K/S`, `Liczba`, `Kurs`, `Waluta`, `Wartość`, `Prowizja`, `Czas transakcji`, `Waluta rozliczenia`, `Kurs Przewalutowania`.

## 5. Workflow CI/CD
[x] `build-dashboard.yml` uruchamia pipeline przy każdym pushu do `data/raw/` i publikuje folder `site/` na GitHub Pages.

## Status Realizacji
- [x] Struktura katalogów
- [x] Parser transakcji (`load_transactions.py`)
- [x] Pobieranie danych rynkowych (`fetch_market_data.py`)
- [x] Obliczenia portfela
- [x] Pliki referencyjne (YAML)
- [x] Dashboard (HTML/CSS/JS)
- [x] GitHub Actions Workflow
