# Ceny aukcji Margonem (Duckling)

![Napisane w Duckling](https://img.shields.io/badge/napisane%20w-Duckling-f2c94c)

Dodatek do gry Margonem, który pamięta ceny Twoich przedmiotów na aukcji i podpowiada je przy wystawianiu. Logika i baza cen działają jako mały lokalny serwer napisany w języku [Duckling](https://github.com/ducktype-org/duckling), a z grą łączy go skrypt Tampermonkeya.

- **Przy wystawianiu przedmiotu** obok okna ,,Wystaw przedmiot'' pojawia się panel z ceną z bazy dla tego świata; ,,Wstaw'' wpisuje ją w pola gry (przeliczoną na liczbę sztuk). Są też ceny z innych światów i edycja.
- **W zakładce ,,Twoje aukcje''** przycisk ,,Zczytaj ceny'' zapisuje ceny wystawionych przedmiotów do bazy, pyta przy różnicach i zaznacza w tabeli wystawienia z ceną inną niż w bazie.
- **Edytor cen** w przeglądarce (`http://127.0.0.1:48730/`): tabela z obrazkami i ramkami rang, filtry, sortowanie kliknięciem w nagłówek, edycja, usuwanie i kopiowanie cen między światami z podglądem zmian.

> **Duckling** to nowy, statycznie typowany język programowania rozwijany przez DuckType.
> Repozytorium języka: **https://github.com/ducktype-org/duckling**
> · [dokumentacja](https://docs.duckling.pl/) · [strona](https://duckling.pl/) · [wydania](https://github.com/ducktype-org/duckling/releases)
> · [społeczność](https://duckling.pl/get_involved/)
>
> Duckling jest w fazie alfa: składnia i biblioteki wciąż się zmieniają.

Dodatek niczego nie klika za gracza: tylko czyta dane z gry i wpisuje ceny w pola; ,,Wystaw'' klika się samemu. Przedmiot jest rozpoznawany po nazwie, poziomie, typie, profesjach, randze, ulepszeniu (+0 do +5) i płatnym odwiązaniu; ceny są zapisywane osobno dla każdego świata.

## Szybki start

1. Zainstaluj kompilator Ducklinga `duckc` i menedżer paczek `duck` (patrz [Instalacja kompilatora Ducklinga](#instalacja-kompilatora-ducklinga)) i dodaj je do `PATH`.
2. Zbuduj bibliotekę C (raz):
   ```bash
   make -C duckling/margonem-net/c
   ```
3. Uruchom serwer (pierwsze uruchomienie zbuduje wszystkie paczki):
   ```bash
   cd duckling/margonem-auction-server && duck run
   ```
   Serwer wypisze `Serwer dodatków słucha na http://127.0.0.1:48730` i działa do Ctrl+C. Baza cen powstanie przy pierwszym zapisie w `duckling/margonem-auction-server/dane/ceny.csv`.
4. Zainstaluj w Chrome rozszerzenie Tampermonkey, a w nim skrypt `tampermonkey/margonem-auction-prices.user.js` (nowy skrypt w panelu Tampermonkeya, wkleić zawartość pliku, zapisać). Przy pierwszym połączeniu Tampermonkey może zapytać o zgodę na `127.0.0.1` - trzeba zezwolić.
5. Odśwież grę. Przy Aukcjonerze w ,,Twoje aukcje'' kliknij ,,Zczytaj ceny'', a przy wystawianiu korzystaj z panelu obok okna. Edytor cen: http://127.0.0.1:48730/

Serwer musi działać, gdy grasz; bez niego panel w grze pokaże ,,Brak połączenia z serwerem Ducklinga''.

## Architektura

```
Gra w Chrome                                   Ten komputer
┌──────────────────────────────┐   HTTP       ┌──────────────────────────────────┐
│ Tampermonkey: skrypt JS      │ ───────────► │ margonem-auction-server          │
│ margonem-auction-prices      │ 127.0.0.1    │  ├─ http, string-utils           │
│  - czyta dane gry (Engine)   │ :48730       │  ├─ auction_prices ─► files ─► C │
│  - panel przy wystawianiu    │ ◄─────────── │  └─ net ─► C (gniazda TCP)       │
│  - "Zczytaj ceny"            │   tekst/CSV  │                                  │
└──────────────────────────────┘              │  dane/ceny.csv   (baza)          │
Przeglądarka: edytor cen ──── GET / ───────►  │  strona/ceny.html, swiaty, typy  │
(HTML + JS buduje tabelę)                     └──────────────────────────────────┘
```

- **C** - tylko warstwa systemowa. `net/c/net_socket.c` obsługuje gniazda TCP (nasłuch wyłącznie na 127.0.0.1, więc inne komputery nie mają dostępu); paczka `files` deklaruje funkcje biblioteki C (`fopen`, `fread`, `fwrite`, `rename`) przez `extern("C")`. Błędy C są zamieniane na `?T` już w tych paczkach.
- **Duckling** - cała logika serwera: połączenia (`net`), pliki (`files`), funkcje na napisach (`string-utils`), minimalne HTTP (`http`), model wpisu, baza CSV, klucz przedmiotu i porównywanie cen za sztukę (`auction_prices`), trasy serwera (`margonem-auction-server`). Nazwy w nawiasach to krótkie nazwy importu; pełne nazwy paczek mają przedrostek `margonem-`.
- **JS w grze** (Tampermonkey) - czyta dane przedmiotu z gry (nazwa, poziom, typ i ranga z opisu gry, profesje, ulepszenie, liczba sztuk, obrazek) i ceny z tabeli ,,Twoje aukcje'', wysyła je do serwera (`GM_xmlhttpRequest`, linie `klucz=wartość`), rysuje panel przy ,,Wystaw przedmiot'' i okienko wyników zczytywania, wpisuje ceny w pola gry.
- **HTML + JS w przeglądarce** (edytor) - serwer tylko podaje plik HTML i dane (tekst/CSV); wyświetla wszystko przeglądarka: JS strony pobiera `/auction/all`, `/worlds`, `/item-types`, filtruje, sortuje i buduje tabelę, ramki rang (obrazek ramek z serwera gry) i okienka kopiowania, a zmiany wysyła `fetch`.

Trasy serwera: `POST /auction/find`, `/auction/save`, `/auction/delete` (linie `klucz=wartość`), `GET /auction/all`, `/worlds`, `/item-types`, `/` (edytor).

Baza `dane/ceny.csv` to zwykły plik CSV (UTF-8, separator `;`), który można też edytować ręcznie; serwer czyta go przy każdym zapytaniu. Kolumny: `serwer;nazwa;poziom;typ;profesje;ranga;ulepszenie;platne_odwiazanie;liczba;licytacja_m;kup_teraz_m;smocze_lzy;data;grafika`. Złoto jest w milionach (`12.1g` = `12100`), ceny dotyczą `liczba` sztuk, przy płatnym odwiązaniu `kup_teraz_m` to dopłata, a `smocze_lzy` kwota SŁ.

## Wymagania

- Kompilator Ducklinga `duckc 0.3-alpha (f49326c51, 2026-11-20)` i menedżer paczek `duck` z tego samego commita repozytorium Ducklinga (albo nowszego). Na tej wersji projekt jest zbudowany i sprawdzony.
- `make` i kompilator C (biblioteka C paczki `margonem-net`).
- Chrome z rozszerzeniem Tampermonkey.
- Linux (sprawdzone na Ubuntu 24.04; warstwa C używa gniazd POSIX).

## Instalacja kompilatora Ducklinga

Oficjalne wydania Ducklinga (v0.3 z 8.10.2026 i `dev-weekly` z 19.10.2026) nie wystarczą: projekt korzysta z `external-libs` w `quackconfig.yaml` (dołączanie biblioteki C, od 16.11.2026) oraz z `break` / `continue` (od 20.11.2026). Do czasu wydania 0.4 Ducklinga trzeba zbudować ze źródeł z publicznego repozytorium [ducktype-org/duckling](https://github.com/ducktype-org/duckling). Sprawdzone na Ubuntu 24.04 z: CMake 3.28, Ninja 1.11, g++-14, LLVM 19 (`/usr/lib/llvm-19`), Rust 1.90.0 przez `rustup` (wersję wybiera plik `dev/rust-toolchain.toml`), Python 3 z pakietami z `dev/requirements.txt`.

```bash
git clone https://github.com/ducktype-org/duckling.git
cd duckling && git checkout f49326c51
```

Kompilator `duckc`, maszyna wirtualna `VM` i formatter `duckfmt` (budowa od zera trwa ok. godziny; `yes ''` przyjmuje domyślne odpowiedzi na pytania skryptu; ścieżki do `g++-14` / `gcc-14` zmienić, jeśli kompilator jest gdzie indziej):

```bash
cd dev && yes '' | python3 toolbox.py setup-build -b build-main -s Ninja -t DevOpt -x /usr/bin/g++-14 -c /usr/bin/gcc-14 --no-docs
cd build-main && ninja duckc VM duckfmt
```

Menedżer paczek `duck` (kilka minut):

```bash
cd ../src/duck && cargo build
```

Narzędzia w `PATH` (w każdym nowym terminalu albo dopisane do `~/.bashrc`); `<duckling>` to katalog klonu:

```bash
export PATH=<duckling>/dev/build-main/bin:<duckling>/dev/src/duck/target/debug:$PATH
```

Uwaga: pakiet `duck` z `apt` to inny program o tej samej nazwie - nie instalować go.

## Układ

Paczki mają w nazwie przedrostek `margonem-`, bo `duck` trzyma jedno środowisko na nazwę paczki i dwa projekty z paczkami o tej samej nazwie (np. `http`) blokowałyby się na jednym komputerze. W kodzie paczki są importowane krótko (`import http;`) dzięki aliasom w `quackconfig.yaml` (`duck add --local ../margonem-http margonem-http --alias http`).

- `duckling/margonem-net` (`import net;`) - połączenia TCP; wywołania gniazd w C są w `c/net_socket.c` (budowane przez `c/Makefile`).
- `duckling/margonem-string-utils` (`import string_utils;`) - funkcje na napisach, których brakuje w bibliotece standardowej (`substring`, `findText`, `textEquals`, `matchesAt`, `split`, `lineValue`...).
- `duckling/margonem-files` (`import files;`) - czytanie i zapisywanie całych plików przez bibliotekę C (zapis przez plik tymczasowy i `rename`).
- `duckling/margonem-http` (`import http;`) - minimalne HTTP/1.1 (jedno zapytanie na połączenie, `Content-Length`, odpowiedź tekstowa lub HTML).
- `duckling/margonem-auction-prices` (`import auction_prices;`) - baza cen aukcji w CSV.
- `duckling/margonem-auction-server` - program (serwer); razem z nim:
  - `strona/ceny.html` - edytor cen podawany pod `/`,
  - `strona/swiaty.csv` - oficjalne światy Margonem (bez prywatnych), podawane pod `/worlds`,
  - `strona/typy.csv` - typy przedmiotów z gry (numer `cl` i nazwa), podawane pod `/item-types`,
  - `dane/` - baza cen `ceny.csv` (prywatna, poza repozytorium).
- `tampermonkey/margonem-auction-prices.user.js` - skrypt do gry.

## Budowanie

Każdy katalog w `duckling/` to paczka menedżera `duck` (`quackconfig.yaml` + `src/`), założona przez `duck init`, z zależnościami dodanymi przez `duck add --local ... --alias ...`. `duck` nie kompiluje plików C, dlatego biblioteka paczki `margonem-net` ma własny `Makefile`:

```bash
make -C duckling/margonem-net/c
```

Budowanie i uruchomienie serwera (zależne paczki `duck` zbuduje sam; serwer szuka `dane/` i `strona/` w katalogu swojej paczki, a `duck run` uruchamia go właśnie tam):

```bash
cd duckling/margonem-auction-server && duck run
```

Samo budowanie: `duck build` w tym samym katalogu.

Aktualizacja skryptu w Tampermonkeyu: wkleić nową wersję pliku albo udostępnić katalog `tampermonkey/` lokalnie (`python3 -m http.server 48731 --bind 127.0.0.1`) i otworzyć w Chrome `http://127.0.0.1:48731/margonem-auction-prices.user.js` - Tampermonkey sam pokaże przycisk instalacji lub aktualizacji.

## Licencja

MIT - patrz [LICENSE](LICENSE).
