# Utrzymanie Plan B

## Sposób udostępniania i koszty

Plan B pozwala użytkownikowi zmienić własny plan bez ponownego układania całego tygodnia. Porównanie celu, czasu i kompromisu pomaga wybrać następne działanie, a zapis rezultatu i raport porządkują własne obserwacje przed konsultacją.

Publiczne demo działa bez konta. Kod można uruchomić lokalnie lub na własnym serwerze zgodnie z warunkami opisanymi w README i licencjami zależności. Sejf, plan, importy, OCR i raporty nie wymagają płatnych wywołań AI. Operator własnego serwera odpowiada za koszt hostingu, utrzymanie konfiguracji i ewentualne użycie dostawcy AI. Aplikacja nie zawiera modułu rozliczania subskrypcji ani płatności.

## Konfiguracja kontenera

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app
```

Domyślny adres to `http://localhost:8181`. Compose publikuje port na `127.0.0.1`; do udostępnienia aplikacji poza komputerem użyj reverse proxy z HTTPS. `APP_ORIGIN` musi zawierać dokładny origin przeglądarki, z protokołem i ewentualnym portem, bez ścieżki i końcowego ukośnika.

| Zmienna | Zastosowanie |
| --- | --- |
| `PLANB_HTTP_PORT` | Port hosta używany przez Compose, domyślnie `8181`. |
| `APP_ORIGIN` | Origin klienta, domyślnie `http://localhost:8181` w Compose. |
| `AI_ENABLED` | Opcjonalne AI; domyślnie `false`. |
| `GROQ_API_KEY` | Sekret dostawcy potrzebny przy włączonym AI. |
| `PLANB_SESSION_SECRET` | Sekret podpisywania sesji, co najmniej 32 znaki; wymagany przy włączonym AI. |
| `AI_DAILY_BUDGET_USD` | Dzienny limit kosztu AI, domyślnie `5`. |
| `BUDGET_DB_PATH` | Baza techniczna API; w Compose `/app/data/budget.sqlite`. |

Przy zmianie portu ustaw także odpowiedni `APP_ORIGIN`. Dane dostępu podawaj przez prywatny mechanizm konfiguracji serwera. Nie umieszczaj sekretów w repozytorium ani w zmiennych frontendu. Włączenie przetwarzania danych osobistych przez AI wymaga oddzielnej konfiguracji i zgód opisanych w [AI_USAGE.md](../AI_USAGE.md); samo ustawienie klucza dostawcy go nie włącza.

## Dane i kopie

Sejf użytkownika znajduje się w IndexedDB jego przeglądarki. W „Moje dane” można pobrać zaszyfrowaną kopię, odtworzyć ją, zmienić frazę i usunąć profil. Do odtworzenia potrzebne są plik kopii i właściwa fraza. Wyczyszczenie danych witryny albo zmiana urządzenia nie przenosi sejfu automatycznie. Zmiana domeny lub portu oznacza także inny magazyn przeglądarki.

Wolumen Docker `api-budget` przechowuje stan techniczny sesji, limitów i budżetu. Nie jest kopią sejfów użytkowników. Przed aktualizacją wykonaj kopię tego wolumenu przy zatrzymanej usłudze `app`, stosując procedurę backupu właściwą dla swojego hostingu. Zachowaj konfigurację i sekrety oddzielnie. Usunięcie wolumenu usuwa historię technicznych limitów; nie używaj `docker compose down -v` jako zwykłej procedury aktualizacji.

## Aktualizacja i sprawdzenie działania

Zachowaj identyfikator używanej wersji, obraz kontenera i kopie danych. Pobierz nową wersję kodu, zainstaluj przypięte zależności i wykonaj kontrolę:

```sh
pnpm install --frozen-lockfile
pnpm assets:prepare
pnpm build
pnpm exec tsc -p apps/api/tsconfig.build.json
pnpm test
```

Następnie zbuduj i uruchom kontener poleceniem `docker compose up --build -d`. Zachowuj wolumen pomiędzy wersjami. W razie problemu wróć do zachowanego obrazu i konfiguracji; odtwarzanie bazy wykonuj z kopii zgodnej z tą wersją.

API udostępnia `GET /health/live` i `GET /health/ready`. Gotowość procesu nie zastępuje sprawdzenia przepływu w przeglądarce: otwórz przykład, zaakceptuj zmianę planu, zapisz rezultat i odśwież stronę. Osobno sprawdź wyszukiwanie NFZ, jeśli jest potrzebne w danym wdrożeniu.

Po aktualizacji otwórz aplikację online i poczekaj na pobranie zasobów. Do testu offline używaj builda produkcyjnego i komunikatu „Gotowe offline”. Pierwsze pobranie aplikacji, fontów i modeli OCR ma około 61 MB. NFZ wymaga połączenia z siecią również po przygotowaniu aplikacji do pracy offline.

## Gdy funkcja jest niedostępna

- **NFZ:** sprawdź dostępność API, sieć i konfigurację originu. Błąd połączenia nie oznacza braku placówek.
- **AI lub transkrypcja:** w publicznym demo są wyłączone. We własnym backendzie sprawdź konfigurację, limit kosztu i zgody; obsługa audio wymaga FFmpeg.
- **Sejf:** użyj tej samej przeglądarki i originu albo odtwórz zaszyfrowaną kopię. Serwer nie odzyska zapomnianej frazy.
- **OCR offline:** najpierw pobierz zasoby online. Odczytane pola wymagają przeglądu użytkownika przed zapisaniem.

## Adapter Sites

Publiczne demo korzysta z osobnego Workera, którego przygotowanie opisuje [deploy/sites/README.md](../deploy/sites/README.md). Jego baza D1 zawiera stan techniczny, a dane sejfu pozostają w przeglądarce. AI jest w tym adapterze wyłączone. Prezentacja i filmy są odrębnymi materiałami i nie wchodzą do paczki kodu.
