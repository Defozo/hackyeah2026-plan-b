# Plan B

Plan B pomaga osobom pracującym w nieregularnych godzinach dopasować własną aktywność i odpoczynek do zmieniającego się dnia. Gdy dyżur się przedłuży albo zmieni się dojazd, możesz sprawdzić, co nadal mieści się w grafiku i służy wybranemu przez Ciebie celowi.

Trening z przygotowaniem i dojazdem zajmuje 50 minut, a po zmianie grafiku zostało 20. Podajesz przeszkodę i cel aktywności. Aplikacja porównuje do trzech wariantów, pokazuje zachowany cel i zakres zmiany, a Ty wybierasz działanie, odpoczynek lub odłożenie decyzji. Wybór i późniejszy rezultat zapisujesz oddzielnie, więc historia pokazuje zarówno zamiar, jak i to, co udało się zrobić.

**DEFOZO SOFTWARE HOUSE · Michał Kiełtyka**, jedyny członek zespołu. Projekt kategorii SPORT & HEALTHCARE, etap New Idea.

- [Otwórz demo](https://plan-b-defozo.defozo.chatgpt.site/)
- [Prezentacja, filmy i przewodnik jury](https://plan-b-defozo.defozo.chatgpt.site/materialy/)
- [Pobierz kod aktualnej wersji](https://github.com/Defozo/hackyeah2026-plan-b/archive/refs/heads/main.zip)

## Jak działa

- **Dzisiaj:** porównanie wariantów z czasem przygotowania, dojazdem i dostępnością potrzebnych zasobów. Widzisz zachowany cel oraz zmiany godziny, długości, miejsca i towarzystwa. Zatwierdzenie zmiany należy do użytkownika.
- **Mój tydzień:** grafik, dostępność, zasoby i chroniony odpoczynek. Plan można wyeksportować do ICS.
- **Historia:** decyzje i rezultaty z 7 lub 28 dni, z informacją o źródłach danych.
- **Przed wizytą:** wybór faktów i pytań do raportu PDF lub HTML oraz wyszukiwanie placówek w NFZ.
- **Moje dane:** import ICS, CSV, FIT, PDF i zdjęć, lokalne OCR, przegląd odczytanych pól, zaszyfrowana kopia i odtworzenie danych.

Silnik stosuje jawne reguły do podanego grafiku, chronionego odpoczynku i własnych wariantów aktywności. Przy odrzuconej propozycji podaje przyczynę, a wariant wymagający potwierdzenia dojazdu lub zasobu oznacza jako warunkowy. Dzięki temu możesz uzupełnić konkretną informację i ponownie sprawdzić plan. Obliczenia podstawowego planu działają lokalnie, bez modelu AI.

Do rozpoczęcia wystarczy jedna własna aktywność. Nie potrzeba konta ani zegarka. Sejf jest szyfrowany i zapisany w przeglądarce. Po pobraniu zasobów plan, OCR i raport działają offline; wyszukiwanie NFZ wymaga sieci.

Demo zawiera dane syntetyczne. Podstawowy plan, OCR i raport korzystają z lokalnych danych; [opcjonalne funkcje AI i transkrypcji](AI_USAGE.md) mają osobną konfigurację i zgody. Plan B organizuje własny plan i informacje do rozmowy ze specjalistą; nie diagnozuje ani nie rezerwuje wizyt. Wyniki NFZ przedstawiają prognozowany czas udzielenia świadczenia.

## Uruchomienie lokalne

Wymagania: **Node.js 24.13.0 lub nowszy z linii 24**, **pnpm 10.33.0** i współczesna przeglądarka. Web Crypto i mikrofon wymagają localhost lub HTTPS. FFmpeg jest potrzebny do obsługi przesyłanego audio; obraz Docker zawiera go.

```sh
npm install --global pnpm@10.33.0
pnpm install --frozen-lockfile
pnpm assets:prepare
pnpm dev
```

Otwórz **http://localhost:5181**. Wybierz „Zobacz przykład” dla danych syntetycznych albo utwórz własny sejf. Zachowaj frazę i pobierz zaszyfrowaną kopię w „Moje dane”. Nie ma serwerowego odzyskiwania frazy ani automatycznej synchronizacji sejfu między przeglądarkami.

W drugim terminalu uruchom opcjonalne API dla NFZ i funkcji serwerowych:

```sh
pnpm dev:api
```

Vite przekazuje `/api` i `/health` na port 8791. Podstawowy plan, historia i sejf działają bez API. Instalacja zależności i pierwsze przygotowanie zasobów wymagają dostępu do pakietów npm. Fonty i modele OCR aplikacja udostępnia następnie lokalnie.

**AI jest domyślnie wyłączone.** Klucz Groq nie jest potrzebny do podstawowego działania. [Konfiguracja AI](AI_USAGE.md) opisuje opcjonalne zmienne serwera, zgody, limity i sposób przetwarzania danych. Sekretów nie należy umieszczać w kodzie, commitach ani zmiennych `VITE_*`.

## Build i Docker

```sh
pnpm assets:prepare
pnpm build
pnpm exec tsc -p apps/api/tsconfig.build.json
```

Frontend trafia do `apps/web/dist`, backend do `dist/api`. `pnpm preview` udostępnia frontend na porcie 4181; API uruchamia się osobno. Przy ręcznym uruchamianiu skompilowanego backendu skopiuj `apps/api/fixtures/polish-note.wav` do `dist/api/fixtures/polish-note.wav`.

```sh
docker compose up --build -d
```

Otwórz **http://localhost:8181**. Kontener obsługuje frontend i API; AI pozostaje wyłączone. Własny hosting wymaga HTTPS i poprawnego `APP_ORIGIN`. Instrukcje konfiguracji, kopii danych, aktualizacji i diagnostyki są w [Utrzymaniu](docs/OPERATIONS.md).

## Testy

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

Testy jednostkowe korzystają z danych syntetycznych i kontrolowanych odpowiedzi dostawcy AI. Testy przeglądarkowe wymagają przygotowanych zasobów; konfiguracja uruchamia Vite. Integracje live są domyślnie pomijane. `E2E_LIVE_SERVICES=true` wymaga osobnej konfiguracji usług i może naliczyć koszt AI.

Odbiór źródeł z 4 października 2026: build frontendu i API, **96/96 testów aplikacji** oraz **11/11 testów adaptera Sites**. Są to wyniki testów oprogramowania na danych syntetycznych, nie badanie skuteczności zdrowotnej. Polecenia dla adaptera znajdują się w [deploy/sites/README.md](deploy/sites/README.md).

## Struktura i licencje

- `apps/web`: interfejs React, lokalny sejf, plan i karta konsultacji.
- `apps/api`: Fastify, NFZ, sesje i opcjonalne AI.
- `packages/domain`: deterministyczny model i silnik planowania.
- `packages/importers`: CSV, ICS, FIT, PDF i lokalne OCR.
- `fixtures/imports`, `apps/api/fixtures`: syntetyczne próbki i ich generatory.
- `deploy/sites`: adapter publicznego demo i migracja technicznej bazy D1.

Wersje zależności są przypięte w `package.json` i `pnpm-lock.yaml`. [Spis plików](docs/SOURCE_MANIFEST.json) zawiera rozmiary i SHA-256. [ATTRIBUTIONS.md](ATTRIBUTIONS.md) opisuje pochodzenie zasobów i licencje, a [AI_USAGE.md](AI_USAGE.md) wykorzystanie AI przy tworzeniu projektu.

Nie dodano nowej licencji kodu projektu. Publiczna dostępność kodu sama w sobie nie udziela dodatkowych praw do jego redystrybucji. Licencje bibliotek i fontów pozostają licencjami ich autorów.
