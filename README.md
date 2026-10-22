# Centrum Inwestora

Prywatny dashboard inwestycyjny działający w modelu **local-first**: transakcje
są przechowywane wyłącznie w przeglądarce (IndexedDB), a lokalny serwer służy
tylko do serwowania strony i pośredniczenia w pobieraniu notowań.

```
CSV (Bossa) → parser w przeglądarce → IndexedDB → metryki → wykresy
                                      ↑
                    lokalny serwer (TradingView/Yahoo/NBP + cache)
```

## Źródła danych

- **Notowania bieżące** – TradingView (jedno zapytanie dla wszystkich symboli,
  cache 5 minut). To główne źródło wyceny portfela i zysku/straty.
- **Historia notowań i splity** – Yahoo Finance. Gdy Yahoo zwróci limit HTTP 429,
  historia jest automatycznie pobierana przez publiczny reader `r.jina.ai`
  (to samo zapytanie do Yahoo, tylko z innego adresu IP). Wykres portfela działa
  również wtedy; dane są dzienne z 10 lat, a cache trzymany jest 6 godzin.
- **Kursy walut** – NBP (kurs bieżący i pełna historia dzienna do wykresu;
  weekendy i święta są uzupełniane ostatnim kursem).

Notowania z GPW i Xetry w TradingView mogą być opóźnione o ok. 15 minut; w stopce
pojawia się wtedy oznaczenie „(opóźnione)”.

## Dlaczego lokalnie, a nie GitHub Pages?

GitHub Pages potrafi hostować tylko pliki statyczne. Pobieranie notowań z Yahoo
Finance z przeglądarki wymaga obejścia CORS. Dotychczas używane
`corsproxy.io` wymaga już klucza API, dlatego notowania przestały działać.
Lokalny serwer rozwiązuje problem u źródła:

- jedno miejsce na proxy i cache (mniej zapytań do źródeł danych i mniejsze ryzyko limitów 429),
- brak wysyłania danych portfela na zewnątrz (serwer widzi tylko symbole),
- brak zależności od GitHub Actions i limitów darmowych minut,
- działa w sieci domowej, także gdy GitHub jest niedostępny.

Dell Wyse z Ubuntu i Dockerem w zupełności wystarczy — aplikacja jest statyczna,
a serwer to lekki proces Node.js bez zależności npm.

## Szybki start (Windows / Linux, bez Dockera)

Wymagany Node.js 20+.

```bash
npm start
```

Otwórz <http://localhost:8080>. Dane referencyjne są serwowane z
`data/reference/`, więc nie trzeba nic kopiować.

Jeśli port 8080 jest zajęty:

```bash
PORT=8099 npm start                 # Linux / macOS
$env:PORT=8099; npm start           # PowerShell
```

Testy:

```bash
npm test
```

## Wdrożenie na Dell Wyse (Ubuntu + Docker)

Dell Wyse pełni rolę serwera — wykresy liczy przeglądarka na komputerze lub
telefonie. Wystarczy:

- 64-bitowy procesor (`uname -m` → `x86_64`),
- ok. 1 GB wolnego RAM i 2 GB miejsca na dysku,
- Ubuntu Server 22.04/24.04 LTS,
- stałe połączenie z siecią domową (Wi-Fi lub Ethernet).

Wyłącz usypianie maszyny (`sudo systemctl mask sleep.target suspend.target
hibernate.target hybrid-sleep.target`), inaczej serwer zniknie z sieci.

### 1. Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
sudo systemctl enable --now docker
```

### 2. Uruchomienie

```bash
git clone https://github.com/DamianZyngier/CentrumInwestora.git
cd CentrumInwestora
docker compose up -d --build
```

Sprawdź adres IP maszyny:

```bash
hostname -I
```

Otwórz w przeglądarce: `http://<IP_Dell_Wyse>:8080`.

### 3. Zapora sieciowa

```bash
sudo ufw allow 8080/tcp
```

Aplikacja **nie ma logowania**. Udostępniaj ją tylko w zaufanej sieci domowej.
Jeśli chcesz dostęp z zewnątrz, postaw reverse proxy (Caddy/Traefik) z HTTPS
i autoryzacją albo użyj VPN — nie przekierowuj portu 8080 bezpośrednio.

### 4. Aktualizacja

```bash
git pull
docker compose up -d --build
```

### 5. Logi i cache

```bash
docker compose logs -f
docker compose down -v   # usuwa też cache notowań (dane portfela są w przeglądarce)
```

Cache notowań jest w wolumenie `cache-data`; pierwsze pobranie historii może
potrwać kilkadziesiąt sekund, kolejne są natychmiastowe.

### 6. Stały adres

Nadaj Dellowi stały adres IP (rezerwacja DHCP) albo użyj nazwy mDNS, np.
`http://dell.local:8080`. Adres jest istotny: IndexedDB jest przypisana do
originu, więc `localhost:8080` i `192.168.1.50:8080` to dwie różne bazy.

## Import danych

### Format 1: historia zleceń (Bossa)

Kolumny: `Stan`, `Walor`, `Giełda`, `K/S`, `Liczba`, `Liczba zreal`, `Limit`,
`Waluta`, `Data ważności`, ...

- importowane są tylko wiersze `Stan = Zrealizowane` (oraz częściowo zrealizowane),
- wiersze `Niezrealizowane`, `Unieważnione`, `Zamknięte` itp. są pomijane,
- liczba jednostek = `Liczba zreal`,
- cena = `Limit` (to **kurs zlecenia**, nie zawsze rzeczywista cena realizacji);
  zlecenia z `Limit = 0` są pomijane,
- data = `Data realizacji`, a jeśli jej brak — `Data ważności` (dla zleceń DAY
  są to zwykle te same dni),
- plik nie zawiera prowizji — można opcjonalnie ustawić procent w polu
  „Prowizja dla plików zleceń”,
- brak kursu przewalutowania → aplikacja pobiera kurs historyczny NBP z dnia
  transakcji (z cofaniem do 7 dni dla weekendów/świąt).

### Format 2: historia transakcji

Kolumny: `Walor`, `Giełda`, `K/S`, `Liczba`, `Kurs`, `Waluta`, `Wartość`,
`Prowizja`, `Czas transakcji`, `Waluta rozliczenia`, `Kurs Przewalutowania`.

Ten format jest dokładniejszy (rzeczywista cena, wartość i prowizja) — jeśli
Twój broker potrafi go wyeksportować, używaj go zamiast historii zleceń.

> **Nie mieszaj obu formatów dla tych samych transakcji.** Klucz deduplikacji
> zawiera cenę, a historia zleceń ma `Limit`, natomiast historia transakcji —
> rzeczywistą cenę realizacji. Ta sama transakcja z dwóch plików zostałaby
> policzona podwójnie.

### Deduplikacja i splity

- Każda transakcja ma stabilny klucz; ponowne wgranie tego samego pliku nie
  dubluje danych.
- Splity są pobierane z Yahoo Finance, a dodatkowo zabezpieczone ręcznie w
  `data/reference/splits.yaml` (BLOOBER 1:10 z 2021-03-18, DINOPL 1:10 z
  2025-07-31). Bez tego liczba jednostek byłaby błędna.
- Dywidendy i inne zdarzenia korporacyjne nie są uwzględniane.

### Dodawanie nowych instrumentów

Nowy walor z CSV dopisz do `data/reference/instruments_mapping.yaml`:

```yaml
"NAZWA Z KOLUMNY WALOR":
  name: "Pełna nazwa"
  exchange: "WWA"          # kod z pliku CSV: WWA, DEU, LON...
  yahoo_symbol: "TICKER.WA"
  asset_class: "Equity - Poland"   # klasa z asset_classes.yaml
  region: "Poland"
  currency: "PLN"          # waluta zlecenia, nie notowania
```

Bez wpisu aplikacja próbuje zgadnąć ticker (np. `CDPROJEKT` + `WWA` →
`CDPROJEKT.WA`), ale dla nietypowych nazw może się to nie udać — wtedy
pozycja pojawi się jako niewyceniona.

## Prywatność i kopie zapasowe

- Transakcje są w `IndexedDB` przeglądarki. Serwer ich nie widzi.
- Do TradingView/Yahoo trafiają tylko symbole instrumentów, do NBP — pary walutowe.
- Historia walut pochodzi wyłącznie z NBP, a nie z Yahoo, więc limit 429 jej nie dotyczy.
- Gdy bezpośrednie Yahoo zwraca 429, historia notowań jest pobierana przez
  `r.jina.ai`; przesyłane są wyłącznie symbole (bez transakcji i kwot).
  Fallback można wyłączyć zmienną środowiskową `JINA_FALLBACK=0`.
- Wyczyszczenie danych przeglądarki usuwa portfel. Rób kopie:
  **Eksport kopii (JSON)** w sekcji „Zarządzanie danymi”. Import kopii odtworzy
  dane na innym urządzeniu/originie.

## Ograniczenia

- `Limit` z historii zleceń nie jest gwarantowaną ceną realizacji.
- Brak informacji o wpłatach/wypłatach gotówki — „kapitał netto zaangażowany”
  to suma zakupów minus wpływy ze sprzedaży, a nie stan rachunku.
- Brak wyceny gotówki i obligacji; cele portfela zakładają 10% „Cash / Bonds”,
  więc rekomendacja niedowagi gotówki może się pojawiać.
- Rentowność to proste ROI (zysk / suma zakupów), nie XIRR.
- Notowania mogą być opóźnione (GPW/Xetra ok. 15 min w TradingView); pierwsze
  pobranie historii może być wolniejsze z powodu limitu Yahoo (HTTP 429).
  Serwer od razu przełącza się wtedy na fallback `r.jina.ai`, więc wykres
  portfela nadal się wypełnia. Bieżąca wycena zawsze pochodzi z TradingView.

## Rozwiązywanie problemów

### „Błąd naruszenia bezpieczeństwa: ... nie może zostać wczytana lub powiązana z file:///”

Strona została otwarta z pliku na dysku (`file:///...`), a nie z serwera.
Przeglądarka blokuje wtedy zapytania do `http://192.168.8.100:8090`. Otwórz
dokładnie adres `http://192.168.8.100:8090/` (nie plik `index.html`). Jeśli masz
skrót na pulpicie, zmień jego adres na HTTP.

### Zysk/Strata pokazuje tylko zysk zrealizowany (np. 1 176,20 zł)

To objaw braku notowań bieżących: podsumowanie liczy wtedy wyłącznie sprzedaże.
Sprawdź, czy strona jest otwarta przez HTTP, oraz czy w stopce jest
„Notowania: ... - TradingView”. Jeśli TradingView jest niedostępny, serwer
użyje ostatnich notowań z cache przeglądarki.

### Historia wykresu niedostępna, ale wycena jest poprawna

Serwer najpierw próbuje Yahoo, a przy HTTP 429 automatycznie pobiera historię
przez `r.jina.ai`. Jeśli oba źródła zawiodą, bieżące notowania z TradingView
nadal poprawnie wyceniają portfel, a wykres pokazuje kapitał netto zaangażowany.
Sprawdź połączenie z internetem i spróbuj ponownie później — cache historii
Jina odświeża się po 6 godzinach, a bezpośrednie Yahoo po 12 godzinach.

## Struktura projektu

```
server/server.js        statyczny serwer + proxy TradingView/Yahoo/NBP/Jina + cache
site/                   frontend (HTML/CSS/JS, bez builda)
site/js/processor.js    parser CSV, FX, splity, metryki, szeregi czasowe
site/js/api.js          klient lokalnego API
site/js/db.js           IndexedDB + deduplikacja
site/js/main.js         UI
data/reference/         mapowanie instrumentów, cele, splity
tests/                  testy parsera i metryk (node --test)
scripts/                stary pipeline Python (legacy, nieużywany w deployu)
```

## GitHub Pages (opcjonalnie)

Workflow `.github/workflows/build-dashboard.yml` jest uruchamiany ręcznie
(`workflow_dispatch`) i publikuje sam statyczny frontend. Bez backendu nie ma
notowań na żywo — to tylko awaryjny podgląd. Docelowo używaj Dockera na Dell
Wyse.
