# Plan B

**DEFOZO SOFTWARE HOUSE** · **Michał Kiełtyka**, jedyny członek zespołu.

Plan B pomaga dopasować plan ruchu i odpoczynku do zmieniającego się dnia.
Łączy intencje, kalendarz, importy dokumentów i przygotowanie materiałów przed konsultacją.
To prototyp kategorii SPORT & HEALTHCARE, zgłoszenie New Idea. Nie diagnozuje i nie rezerwuje wizyt.

- [Publiczne demo](https://plan-b-defozo.defozo.chatgpt.site/)
- [Prezentacja, film i przewodnik jury](https://plan-b-defozo.defozo.chatgpt.site/materialy/)

## Wymagania

Node.js **24.13.0 lub nowszy z linii 24**, pnpm **10.33.0** i współczesna przeglądarka.
Node 24 jest wymagany również przez backend i testy korzystające z `node:sqlite`.
FFmpeg jest potrzebny przy obsłudze przesyłanego audio; obraz Docker zawiera go.
Instalacja pobiera pakiety z rejestru npm. Dane i modele OCR oraz fonty są następnie serwowane lokalnie.

## Uruchomienie lokalne

```sh
npm install --global pnpm@10.33.0
pnpm install --frozen-lockfile
pnpm assets:prepare
pnpm dev
```

Otwórz `http://localhost:5181`. W drugim terminalu uruchom `pnpm dev:api`, jeśli chcesz używać API NFZ
lub backendu. Vite przekazuje `/api` i `/health` na port 8791. Podstawowy plan i sejf działają w przeglądarce.
Przy pierwszym uruchomieniu wybierz przykład z danymi syntetycznymi albo utwórz lokalny sejf.
Dane sejfu pozostają w IndexedDB tej przeglądarki. Kod nie zawiera danych rzeczywistego pacjenta.

**AI jest domyślnie wyłączone.** Publiczny adapter Sites również utrzymuje AI wyłączone.
Do podstawowego działania nie potrzeba klucza Groq. Wywołania NFZ wymagają sieci i dostępności publicznego API.
Nie umieszczaj sekretów w źródłach, konfiguracji klienta ani commitach.
Opcjonalna konfiguracja serwera i granice AI są w [AI_USAGE.md](AI_USAGE.md).

## Build i kontener

```sh
pnpm assets:prepare
pnpm build
pnpm exec tsc -p apps/api/tsconfig.build.json
```

Frontend trafia do `apps/web/dist`, backend do `dist/api`. `pnpm preview` pokazuje frontend pod portem 4181;
nie uruchamia API. Przy ręcznym uruchomieniu skompilowanego backendu skopiuj fixture
`apps/api/fixtures/polish-note.wav` do `dist/api/fixtures/polish-note.wav`.

```sh
docker compose up --build
```

Kontener udostępnia całą aplikację pod `http://localhost:8181`. AI pozostaje wyłączone.
Docker buduje frontend i API oraz kopiuje fixture. Wolumen `api-budget` przechowuje techniczny stan API.
Przy własnym hostingu ustaw poprawne `APP_ORIGIN`; dostosuj port i HTTPS do środowiska.

## Testy

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

Testy jednostkowe używają danych syntetycznych i atrap dostawcy AI. Testy przeglądarkowe wymagają przygotowanych
zasobów; konfiguracja uruchamia Vite. `live.spec.ts` domyślnie pomija integracje live. Ustawienie
`E2E_LIVE_SERVICES=true` wymaga osobnej świadomej konfiguracji usług i może naliczyć koszt dostawcy AI.
Nie stanowi to warunku zwykłego uruchomienia ani buildu. Raporty testów powstają w ignorowanych katalogach.

Testy adaptera Sites i przygotowanie jego pakietu opisuje [deploy/sites/README.md](deploy/sites/README.md).
Ten eksport nie zawiera zapisanych wyników prywatnych ani nagrań testowych.
[Spis plików](docs/SOURCE_MANIFEST.json) zawiera rozmiary i SHA-256;
[kontrola eksportu](docs/SOURCE_VALIDATION.json) podaje wykonane sprawdzenia i ich ograniczenia.

## Struktura i pochodzenie

- `apps/web`: React, lokalny sejf, widoki planu i konsultacji.
- `apps/api`: opcjonalne API Fastify, NFZ, sesje i ograniczenia dostępu do AI.
- `packages/domain`: deterministyczny model i silnik planowania.
- `packages/importers`: CSV, ICS, FIT, PDF i lokalne OCR.
- `fixtures/imports`, `apps/api/fixtures`: pliki syntetyczne i narzędzia ich odtworzenia.
- `deploy/sites`: adapter publicznego demo oraz migracja technicznej bazy D1.

Pełne wersje zależności są przypięte w `package.json` i `pnpm-lock.yaml`.
Źródła zewnętrznych zasobów i licencje opisuje [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
Nie dodano nowej licencji kodu projektu. Publiczna dostępność kodu sama w sobie nie udziela dodatkowych praw
do jego redystrybucji. Licencje bibliotek i fontów pozostają licencjami ich autorów.
