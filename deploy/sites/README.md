# Adapter publicznego demo Sites

Worker obsługuje sesję, CSRF, limity, NFZ i statyczne pliki aplikacji. AI jest w tym adapterze wyłączone.
Pełny backend Fastify pozostaje w `apps/api`. Baza D1 przechowuje stan techniczny, a sejf użytkownika pozostaje
w przeglądarce. Adapter wymaga bindingów `DB`, `ASSETS` oraz prywatnego `PLANB_SESSION_SECRET` i `APP_ORIGIN`.

```sh
pnpm assets:prepare
pnpm build
pnpm exec tsc -p apps/api/tsconfig.build.json
node scripts/prepare-sites.mjs
node --test deploy/sites/worker.test.mjs
```

Skrypt tworzy `.runtime/public-site` z bieżących wyników buildu, Workerem i migracją.
Nie publikuje i nie zawiera identyfikatora istniejącego projektu ani sekretów. Podłącz własny projekt Sites,
binding `DB` do bazy D1 i zastosuj `drizzle/0000_technical_state.sql`. Własny hosting musi skierować żądania
przez Worker oraz udostępnić binding `ASSETS`, zgodnie z wygenerowanym `dist/server/wrangler.json`.
Plik `schema.ts` jest metadanymi dla narzędzi Sites/Drizzle, nie wejściem głównego buildu TypeScript.
Zawiera import `drizzle-orm/sqlite-core` dostarczany przez środowisko migracji; kod runtime i testy używają SQL
i nie wymagają dodawania Drizzle do zależności aplikacji.

Pakiet źródeł nie zawiera filmu ani prezentacji. Katalog `/materialy/` z oryginalnego wdrożenia nie jest
odtwarzany; [aktualne materiały](https://plan-b-defozo.defozo.chatgpt.site/materialy/) są dostępne osobno.
Trasa filmu w oryginalnym Workerze wymaga dodatkowego zasobu `_planb/demo.bin`, jeśli operator zdecyduje się
samodzielnie hostować te materiały. Własny pakiet nie kopiuje ich automatycznie.
Testy Workera używają testowego, publicznego sekretu wyłącznie w pamięci i lokalnej bazy SQLite.
