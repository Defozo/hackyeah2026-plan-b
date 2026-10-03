# Wykorzystanie AI

Projekt Plan B przygotował Michał Kiełtyka, DEFOZO SOFTWARE HOUSE, ze wsparciem narzędzi AI przy implementacji,
testach i redakcji. Biblioteki, modele i parsery zewnętrzne są przypisane ich autorom w ATTRIBUTIONS.md.

Silnik planowania jest deterministyczny. Opcjonalny backend Groq porządkuje zatwierdzony zakres informacji
lub transkrybuje zatwierdzone audio. Propozycja wymaga przeglądu; nie jest diagnozą ani poradą lekarską.
Modele zapisane w kodzie: `openai/gpt-oss-120b`, `whisper-large-v3-turbo` i opcjonalnie `whisper-large-v3`.

Domyślnie `AI_ENABLED=false` i `ALLOW_PERSONAL_DATA_TO_AI=false`. Adapter Sites nie włącza AI.
Backend lokalny czyta zmienne środowiska procesu. Do świadomego uruchomienia AI w trybie demo potrzebne są
`AI_ENABLED=true`, `GROQ_API_KEY` i losowy `PLANB_SESSION_SECRET` o co najmniej 32 znakach.
`APP_ORIGIN` musi być dokładnym originem klienta. Klucze dostarcza operator prywatnym mechanizmem swojego hostingu.
Nie zapisuje się ich w repozytorium ani nie przekazuje do buildu frontendu.

`APP_MODE` domyślnie ma wartość `demo`. Wysłanie danych osobistych pozostaje zablokowane bez osobnej konfiguracji
`APP_MODE=personal`, `ALLOW_PERSONAL_DATA_TO_AI=true` i `PERSONAL_AI_REVIEW_ID`, która oznacza przegląd operatora.
Ustawienie tych wartości nie zastępuje tego przeglądu. Interfejs dodatkowo wymaga zgody na wybrany zakres.
`AI_DAILY_BUDGET_USD` domyślnie wynosi 5, a `BUDGET_DB_PATH` wskazuje lokalną bazę techniczną.
FFmpeg normalizuje zatwierdzone audio. Testy jednostkowe nie używają płatnego dostawcy.

Kod i fixture nie stanowią dowodu klinicznej skuteczności ani walidacji na pacjentach.
