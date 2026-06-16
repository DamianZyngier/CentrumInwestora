# Plan Implementacji: Centrum Inwestora (Local-First)

Projekt dashboardu inwestycyjnego działającego w 100% w przeglądarce. Dane są prywatne i przechowywane lokalnie.

## 1. Architektura Systemu
System działa w trybie **Client-Side**: **User Upload CSV -> JS Processor -> IndexedDB -> Dashboard**.

### Główne komponenty:
- **UI Importu**: Możliwość wgrania wielu plików CSV jednocześnie.
- **IndexedDB**: Lokalna baza danych w przeglądarce do przechowywania transakcji.
- **JS Processor**: Logika obliczeniowa (PLN, FIFO, struktura) przepisana z Pythona.
- **API Market Data**: Pobieranie kursów walut i cen akcji bezpośrednio przez przeglądarkę.

## 2. Nowa struktura plików
- `site/js/db.js`: Zarządzanie bazą IndexedDB.
- `site/js/processor.js`: Parsowanie CSV i obliczenia finansowe.
- `site/js/api.js`: Integracja z darmowymi API giełdowymi (np. Yahoo Finance przez CORS proxy).
- `data/reference/`: Pozostaje w repo (mapowanie instrumentów), ale dashboard pobiera go jako zasób statyczny.

## 3. Kamienie milowe
1. [ ] Implementacja interfejsu wgrywania plików (Drag & Drop).
2. [ ] Parser CSV (PapaParse) i logika deduplikacji w JS.
3. [ ] Integracja z IndexedDB (trwałość danych).
4. [ ] Obliczenia portfela w JS (zastąpienie skryptów Python).
5. [ ] Dynamiczne pobieranie cen rynkowych z poziomu przeglądarki.

## Status Realizacji (Nowa Architektura)
- [ ] UI: Sekcja Importu
- [ ] JS: Parser i Baza Danych
- [ ] JS: Logika Portfela
- [ ] Usunięcie zależności od skryptów Python w procesie budowania danych
- [x] GitHub Actions (tylko wdrożenie kodu)
