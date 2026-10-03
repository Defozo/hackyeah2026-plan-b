# Źródła i wykorzystane zasoby

**Plan B**, **DEFOZO SOFTWARE HOUSE**, **Michał Kiełtyka** (jedyny członek zespołu).
Własna kompozycja produktu, kod aplikacji, model intencji, silnik, sejf i adaptery powstały ze wsparciem AI.
Nie przypisujemy zespołowi autorstwa bibliotek, modeli ani ogólnych parserów.

Wersje są przypięte w `package.json` i `pnpm-lock.yaml`. Zestawione istniejące informacje licencyjne
z grafu zależności produkcyjnych znajdują się w `licenses/THIRD-PARTY-LICENSES.txt`.
`pnpm assets:prepare` odtwarza zestawienie z zainstalowanych pakietów i dołącza je do zasobów aplikacji.
Zachowaj również informacje dostarczone w dystrybucjach poszczególnych pakietów.

- Inter pochodzi z `@fontsource/inter`, SIL Open Font License 1.1: `licenses/Inter-OFL.txt`.
- Noto Sans WOFF2 pochodzi z `@fontsource/noto-sans`, SIL OFL 1.1: `licenses/NotoSans-Fontsource-OFL.txt`.
- Noto Sans TTF w `packages/importers/assets` ma przypięte źródło i SHA-256 w `font-source.json`.
  Jego oryginalna informacja copyright i licencja są w `licenses/NotoSans-Regular-NOTICE.txt` oraz
  `licenses/NotoSans-Regular-OFL.txt`.
- PDF.js, Tesseract.js i Tesseract.js core: teksty licencji w `licenses/`.
- Modele OCR pol/eng pochodzą z `@tesseract.js-data`; są odtwarzane przez instalację i przygotowanie zasobów.
- React, React Aria, Lucide, Dexie, Temporal/Luxon, Papa Parse, ical.js, Garmin FIT SDK, React PDF,
  Fastify i Groq SDK oraz narzędzia testowe zachowują własne licencje w pakietach.
- Obraz bazowy Node.js 24.13.0 bookworm-slim ma digest w Dockerfile. Kontener instaluje FFmpeg z Debiana.
- Publiczne dane o terminach: API NFZ Terminy Leczenia v1.4, `https://apinfz.nfz.gov.pl/app-itl-api-pcus/`.
  Aplikacja podaje źródło i datę, nie rezerwuje wizyt.

Profile demo, CSV/ICS/FIT, obrazy, PDF i audio są syntetyczne. Skrypt `fixtures/imports/generate-fixtures.mjs`
odtwarza pliki testowe przez Playwright i Garmin SDK. Polska próbka audio powstała z własnego tekstu
przez eSpeak NG 1.52.0 oraz FFmpeg. `apps/api/create-audio-fixture.ts` udostępnia generator;
wymaga zewnętrznej instalacji eSpeak NG i FFmpeg. Ich binaria nie są częścią eksportu źródeł.
Oryginalne materiały organizatora, nagrania i prezentacja nie są częścią tego repozytorium.
Materiały zgłoszenia: https://plan-b-defozo.defozo.chatgpt.site/materialy/.

Nie dodano nowej licencji kodu projektu. Powyższe licencje dotyczą zasobów i zależności ich autorów.
