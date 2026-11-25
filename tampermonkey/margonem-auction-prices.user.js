// ==UserScript==
// @name         Margonem - ceny aukcji (Duckling)
// @namespace    https://github.com/JakubPiotrowicz/margonem-auction-prices
// @version      0.4.4
// @description  Podpowiada ceny przy wystawianiu i zapisuje ceny Twoich aukcji w bazie w Ducklingu
// @match        https://*.margonem.pl/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    "use strict";

    const SERVER_URL = "http://127.0.0.1:48730";
    const CHECK_INTERVAL_MS = 500;
    const COLUMNS = [
        "serwer", "nazwa", "poziom", "typ", "profesje", "ranga", "ulepszenie",
        "platne_odwiazanie", "liczba", "licytacja_m", "kup_teraz_m", "smocze_lzy", "data", "grafika",
    ];
    const RANK_NAMES = {
        common: "Zwykły",
        unique: "Unikatowy",
        heroic: "Heroiczny",
        upgraded: "Ulepszony",
        legendary: "Legendarny",
        artefact: "Artefakt",
    };

    // Tampermonkey runs the script in a sandbox; game objects live on the page's own window.
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const serverName = location.hostname.split(".")[0];

    let shownListingKey = null;
    let pricePanel = null;
    let resultPanel = null;
    // Table row of every listing read from "Twoje aukcje", used to mark rows that need attention.
    const rowOfListing = new WeakMap();

    // ---------------------------------------------------------------- server

    // Sends `key=value` lines and resolves with the response text; rejects with a message.
    function post(path, fields) {
        const body = Object.entries(fields)
            .map(([key, value]) => `${key}=${value ?? ""}`)
            .join("\n");
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: SERVER_URL + path,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
                data: body,
                onload: (response) => {
                    // Tampermonkey gives no text at all for an empty response.
                    const text = response.responseText ?? "";
                    if (response.status === 200) {
                        resolve(text);
                    } else {
                        reject(`Serwer Ducklinga: ${text}`);
                    }
                },
                onerror: () => reject("Brak połączenia z serwerem Ducklinga"),
            });
        });
    }

    function entryFromCsvLine(line) {
        const values = line.split(";");
        return Object.fromEntries(COLUMNS.map((column, index) => [column, values[index] ?? ""]));
    }

    function findEntries(item) {
        return post("/auction/find", item).then((text) =>
            text.split("\n").filter((line) => line.length > 0).map(entryFromCsvLine));
    }

    // Resolves with { status, previous }, where status is dodano, bez_zmian, podmieniono or konflikt.
    function saveEntry(entry, replaceExisting) {
        const fields = { ...entry, podmien: replaceExisting ? "tak" : "nie" };
        return post("/auction/save", fields).then((text) => {
            const [status, previousLine] = text.split("\n");
            return { status, previous: previousLine ? entryFromCsvLine(previousLine) : null };
        });
    }

    // ---------------------------------------------------------------- prices

    // Gold as the auction shows it ("12.1g", "500m") to whole millions; null when unreadable.
    function parseGoldMillions(text) {
        const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([mg])$/i);
        if (!match) {
            return null;
        }
        const amount = Number(match[1]);
        return Math.round(match[2].toLowerCase() === "g" ? amount * 1000 : amount);
    }

    function formatGold(millions) {
        if (millions === "" || millions === null) {
            return "";
        }
        const value = Number(millions);
        return value >= 1000 ? `${value / 1000}g` : `${value}m`;
    }

    // Reads a buy-now cell such as "12.1g" or "24g + 6750SŁ".
    function parseBuyNowCell(text) {
        const parts = text.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
        let goldMillions = null;
        let dragonTears = null;
        for (const part of parts) {
            const tears = part.match(/^(\d+)\s*SŁ$/i);
            if (tears) {
                dragonTears = Number(tears[1]);
            } else {
                goldMillions = parseGoldMillions(part);
                if (goldMillions === null) {
                    return null;
                }
            }
        }
        return { goldMillions, dragonTears };
    }

    // A price saved for `fromPieceCount` pieces, recalculated for `toPieceCount` pieces in whole millions.
    function scaledMillions(millions, fromPieceCount, toPieceCount) {
        if (millions === "") {
            return "";
        }
        const scaled = Math.round(Number(millions) * Number(toPieceCount) / Number(fromPieceCount));
        return String(Math.max(1, scaled));
    }

    function scaledEntry(entry, pieceCount) {
        return {
            ...entry,
            liczba: String(pieceCount),
            licytacja_m: scaledMillions(entry.licytacja_m, entry.liczba, pieceCount),
            kup_teraz_m: scaledMillions(entry.kup_teraz_m, entry.liczba, pieceCount),
        };
    }

    function describePrices(entry) {
        const parts = [];
        if (entry.licytacja_m !== "") {
            parts.push(`licytacja ${formatGold(entry.licytacja_m)}`);
        }
        if (entry.kup_teraz_m !== "" || entry.smocze_lzy !== "") {
            const tears = entry.smocze_lzy !== "" ? ` + ${entry.smocze_lzy}SŁ` : "";
            const label = entry.platne_odwiazanie === "tak" ? "dopłata" : "kup teraz";
            parts.push(`${label} ${formatGold(entry.kup_teraz_m)}${tears}`);
        }
        const pieces = entry.liczba !== "1" ? ` (za ${entry.liczba} szt.)` : "";
        return parts.length > 0 ? parts.join(", ") + pieces : "brak cen";
    }

    // ---------------------------------------------------------------- items

    function itemStats(item) {
        const stats = {};
        for (const part of (item.stat || "").split(";")) {
            const separator = part.indexOf("=");
            if (separator < 0) {
                stats[part] = "";
            } else {
                stats[part.slice(0, separator)] = part.slice(separator + 1);
            }
        }
        return stats;
    }

    // Type and rank exactly as the game writes them in the item tooltip.
    function tooltipNames(item) {
        const container = document.createElement("div");
        container.innerHTML = String(page.MargoTipsParser?.getTip(item) ?? "");
        const typeText = container.querySelector(".item-type")?.textContent ?? "";
        const rankText = container.querySelector(".item-rarity")?.textContent ?? "";
        return {
            itemType: typeText.replace("Typ:", "").trim() || `cl${item.cl}`,
            rank: rankText.trim() || RANK_NAMES[item.itemTypeName] || item.itemTypeName,
        };
    }

    // Local date, not UTC, so a save just after midnight gets today's date.
    function today() {
        const now = new Date();
        const twoDigits = (number) => String(number).padStart(2, "0");
        return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
    }

    // The fields that identify an item in the database, with empty prices.
    function itemKey(item, paidUnbinding) {
        const stats = itemStats(item);
        const names = tooltipNames(item);
        return {
            serwer: serverName,
            nazwa: item.name,
            poziom: stats.lvl ?? "0",
            typ: names.itemType,
            // Letters exactly as the game stores them (alphabetical, e.g. "bhpw");
            // empty when the item has no profession requirement.
            profesje: stats.reqp ?? "",
            ranga: names.rank,
            ulepszenie: stats.enhancement_upgrade_lvl ?? "0",
            platne_odwiazanie: paidUnbinding ? "tak" : "nie",
            liczba: stats.amount ?? "1",
            licytacja_m: "",
            kup_teraz_m: "",
            smocze_lzy: "",
            data: today(),
            grafika: item.icon ? (page.CFG?.a_ipath ?? "") + item.icon : "",
        };
    }

    function itemFromElement(element) {
        const id = element?.className.match(/item-id-(\d+)/)?.[1];
        return id ? page.Engine.items.getItemById(id) : null;
    }

    // ---------------------------------------------------------------- panel

    function button(text, onClick) {
        const element = document.createElement("button");
        element.textContent = text;
        Object.assign(element.style, { margin: "2px 4px 2px 0", cursor: "pointer", font: "11px sans-serif" });
        element.addEventListener("click", onClick);
        return element;
    }

    const TITLE_STYLE = { color: "#f5d76e", fontWeight: "bold", marginBottom: "4px" };

    function itemLabel(entry) {
        return entry.nazwa + (entry.ulepszenie !== "0" ? ` +${entry.ulepszenie}` : "");
    }

    function line(text, style = {}) {
        const element = document.createElement("div");
        element.textContent = text;
        Object.assign(element.style, style);
        return element;
    }

    function floatingPanel(id, width) {
        const panel = document.createElement("div");
        panel.id = id;
        Object.assign(panel.style, {
            position: "fixed",
            zIndex: "100000",
            width,
            padding: "8px",
            background: "rgba(20, 20, 20, 0.92)",
            color: "#e8e0c8",
            font: "12px sans-serif",
            border: "1px solid #8a6d3b",
            borderRadius: "4px",
            // Long content scrolls inside the panel instead of running off the screen.
            maxHeight: "calc(100vh - 100px)",
            overflowY: "auto",
        });
        document.body.appendChild(panel);
        return panel;
    }

    function getPanel() {
        if (pricePanel === null) {
            pricePanel = floatingPanel("duckling-auction-prices", "260px");
        }
        return pricePanel;
    }

    function hidePanel() {
        pricePanel?.remove();
        pricePanel = null;
    }

    // Keeps the panel just to the right of the listing window.
    function placePanel(listingWindow) {
        const bounds = listingWindow.getBoundingClientRect();
        const panel = getPanel();
        const top = Math.round(bounds.top);
        panel.style.left = `${Math.round(bounds.right + 8)}px`;
        panel.style.top = `${top}px`;
        panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
    }

    function listingField(className) {
        return document.querySelector(`.auction-off-item-panel .${className} input`);
    }

    // Types the value like a player would, so the game notices the change.
    function fillField(input, value) {
        if (!input || input.disabled || value === "") {
            return;
        }
        input.value = value;
        for (const type of ["input", "keyup", "change"]) {
            input.dispatchEvent(new Event(type, { bubbles: true }));
        }
    }

    // Fills the listing fields with the entry's prices recalculated for `pieceCount` pieces.
    function insertPrices(savedEntry, pieceCount) {
        const entry = scaledEntry(savedEntry, pieceCount);
        if (entry.platne_odwiazanie === "tak") {
            fillField(listingField("auction-additional-gold-payment"), formatGold(entry.kup_teraz_m));
        } else {
            fillField(listingField("auction-bid"), formatGold(entry.licytacja_m));
            fillField(listingField("auction-buy-now"), formatGold(entry.kup_teraz_m));
        }
    }

    // `onSaved` gets the saved entry; `onCancel` defaults to `onSaved` called without an entry.
    function editForm(entry, onSaved, onCancel = () => onSaved(null)) {
        const form = document.createElement("div");
        form.style.margin = "4px 0 6px";
        const inputs = {};
        if (entry.liczba !== "1") {
            form.appendChild(line(`Ceny za ${entry.liczba} szt.`, { color: "#a89f86" }));
        }
        const fields = entry.platne_odwiazanie === "tak"
            ? [["kup_teraz_m", "Dopłata (np. 24g)"], ["smocze_lzy", "Smocze Łzy"]]
            : [["licytacja_m", "Licytacja (np. 100m)"], ["kup_teraz_m", "Kup teraz (np. 12.1g)"]];
        for (const [column, label] of fields) {
            form.appendChild(line(label));
            const input = document.createElement("input");
            input.value = column === "smocze_lzy" ? entry[column] : formatGold(entry[column]);
            input.style.width = "120px";
            inputs[column] = input;
            form.appendChild(input);
        }
        const message = line("", { color: "#e07a5f" });
        form.appendChild(document.createElement("br"));
        form.appendChild(button("Zapisz", () => {
            const changed = { ...entry, data: today() };
            for (const [column, input] of Object.entries(inputs)) {
                const text = input.value.trim();
                const isTears = column === "smocze_lzy";
                const value = text === "" ? "" : isTears ? text.replace(/\D/g, "") : parseGoldMillions(text);
                if (value === null) {
                    message.textContent = `Nie rozumiem kwoty: ${text}`;
                    return;
                }
                changed[column] = String(value);
            }
            saveEntry(changed, true).then(
                () => onSaved(changed),
                (error) => { message.textContent = error; },
            );
        }));
        form.appendChild(button("Anuluj", onCancel));
        form.appendChild(message);
        return form;
    }

    // `listedPieceCount` is the number of pieces in the listing window.
    function entryRow(entry, refresh, withInsert, listedPieceCount) {
        const row = document.createElement("div");
        row.style.margin = "4px 0";
        const where = entry.serwer === serverName ? "Ten świat" : entry.serwer;
        row.appendChild(line(`${where}: ${describePrices(entry)}`, { fontWeight: "bold" }));
        if (entry.liczba !== listedPieceCount) {
            const forListed = scaledEntry(entry, listedPieceCount);
            const listedPrices = describePrices({ ...forListed, liczba: "1" });
            row.appendChild(line(`za ${listedPieceCount} szt.: ${listedPrices}`));
        }
        row.appendChild(line(`zapisano ${entry.data}`, { color: "#a89f86", fontSize: "11px" }));
        if (withInsert) {
            row.appendChild(button("Wstaw", () => insertPrices(entry, listedPieceCount)));
        }
        row.appendChild(button("Edytuj", () => {
            row.replaceChildren(editForm(entry, refresh));
        }));
        return row;
    }

    function renderPanel(key, entries) {
        const panel = getPanel();
        const refresh = () => showPricesFor(key, true);
        const here = entries.find((entry) => entry.serwer === serverName);
        const others = entries.filter((entry) => entry.serwer !== serverName);

        panel.replaceChildren(line("Ceny z bazy (Duckling)", TITLE_STYLE));
        const unbinding = key.platne_odwiazanie === "tak" ? ", płatne odwiązanie" : "";
        const pieces = key.liczba !== "1" ? `, ${key.liczba} szt.` : "";
        const description = `${itemLabel(key)} (${key.poziom} lvl, ${key.ranga}${unbinding}${pieces})`;
        panel.appendChild(line(description, { marginBottom: "4px" }));

        if (here) {
            panel.appendChild(entryRow(here, refresh, true, key.liczba));
        } else {
            panel.appendChild(line("Brak wpisu na tym świecie."));
            const addRow = document.createElement("div");
            addRow.appendChild(button("Dodaj", () => addRow.replaceChildren(editForm(key, refresh))));
            panel.appendChild(addRow);
        }

        if (others.length > 0) {
            const list = document.createElement("div");
            list.style.display = here ? "none" : "block";
            for (const entry of others) {
                list.appendChild(entryRow(entry, refresh, false, key.liczba));
            }
            const toggle = button(`Inne światy (${others.length})`, () => {
                list.style.display = list.style.display === "none" ? "block" : "none";
            });
            panel.appendChild(toggle);
            panel.appendChild(list);
        }
    }

    function showPricesFor(key, force) {
        const keyText = JSON.stringify({ ...key, data: "" });
        if (!force && keyText === shownListingKey) {
            return;
        }
        shownListingKey = keyText;
        getPanel().replaceChildren(line("Szukam w bazie..."));
        findEntries(key).then(
            (entries) => renderPanel(key, entries),
            (error) => getPanel().replaceChildren(line(error, { color: "#e07a5f" })),
        );
    }

    // Shows the panel while the listing window holds an item, hides it otherwise.
    function watchListingWindow() {
        const listingPanel = document.querySelector(".auction-off-item-panel");
        const item = itemFromElement(listingPanel?.querySelector(".item[class*='item-id-']"));
        if (!listingPanel?.offsetParent || !item) {
            shownListingKey = null;
            hidePanel();
            return;
        }
        // With paid unbinding the game asks for a gold surcharge instead of a starting bid.
        const surchargeField = listingPanel.querySelector(".auction-additional-gold-payment");
        const paidUnbinding = Boolean(surchargeField?.offsetParent);
        placePanel(listingPanel.closest(".border-window") ?? listingPanel);
        showPricesFor(itemKey(item, paidUnbinding), false);
    }

    // ---------------------------------------------------------------- my auctions

    // Reads the visible rows of the "Twoje aukcje" table into database entries.
    function readMyAuctions(auctionWindow) {
        const entries = [];
        const unreadable = [];
        for (const row of auctionWindow.querySelectorAll("tr")) {
            const item = itemFromElement(row.querySelector(".item-slot-td .item"));
            if (!item) {
                continue;
            }
            const bidText = row.querySelector(".item-bid-td")?.textContent.trim() ?? "";
            const buyNow = parseBuyNowCell(row.querySelector(".item-buy-now-td")?.textContent ?? "");
            const bid = bidText === "" ? null : parseGoldMillions(bidText);
            if (buyNow === null || (bidText !== "" && bid === null)) {
                unreadable.push(item.name);
                continue;
            }
            const entry = itemKey(item, buyNow.dragonTears !== null);
            entry.licytacja_m = bid === null ? "" : String(bid);
            entry.kup_teraz_m = buyNow.goldMillions === null ? "" : String(buyNow.goldMillions);
            entry.smocze_lzy = buyNow.dragonTears === null ? "" : String(buyNow.dragonTears);
            rowOfListing.set(entry, row);
            entries.push(entry);
        }
        return { entries, unreadable };
    }

    // Item fields without prices, piece count and date: entries with equal keys are the same item.
    function itemKeyText(entry) {
        const { liczba, licytacja_m, kup_teraz_m, smocze_lzy, data, grafika, ...key } = entry;
        return JSON.stringify(key);
    }

    function samePricePerPiece(leftMillions, leftCount, rightMillions, rightCount) {
        if (leftMillions === "" || rightMillions === "") {
            return leftMillions === rightMillions;
        }
        return Number(leftMillions) * Number(rightCount) === Number(rightMillions) * Number(leftCount);
    }

    function samePrices(left, right) {
        return samePricePerPiece(left.licytacja_m, left.liczba, right.licytacja_m, right.liczba)
            && samePricePerPiece(left.kup_teraz_m, left.liczba, right.kup_teraz_m, right.liczba)
            && left.smocze_lzy === right.smocze_lzy;
    }

    // Listings of one item grouped together: `listings` has all of them,
    // `options` one listing for each different price per piece.
    function groupByItem(entries) {
        const groups = new Map();
        for (const entry of entries) {
            const key = itemKeyText(entry);
            const group = groups.get(key) ?? { listings: [], options: [] };
            group.listings.push(entry);
            if (!group.options.some((known) => samePrices(known, entry))) {
                group.options.push(entry);
            }
            groups.set(key, group);
        }
        return [...groups.values()];
    }

    // "Edytuj cenę w bazie" inside a result block; after saving the block shows the new price.
    function editInBlock(block, entry) {
        const label = itemLabel(entry);
        return button("Edytuj cenę w bazie", () => {
            const original = [...block.childNodes];
            block.replaceChildren(line(label, { fontWeight: "bold" }), editForm(
                entry,
                (saved) => block.replaceChildren(line(`${label}: w bazie teraz ${describePrices(saved)}`)),
                () => block.replaceChildren(...original),
            ));
        });
    }

    const ROW_MARKS = {
        remove: { color: "#e8a33d", title: "Cena inna niż w bazie - do zdjęcia (Duckling)" },
        choose: { color: "#5fa8d3", title: "Do wyboru ceny w okienku Duckling" },
    };

    // Outlines the table rows of `listings`; `kind` is a key of ROW_MARKS.
    function markRows(listings, kind) {
        for (const listing of listings) {
            const row = rowOfListing.get(listing);
            if (row) {
                row.style.outline = `2px solid ${ROW_MARKS[kind].color}`;
                row.title = ROW_MARKS[kind].title;
                row.dataset.ducklingMark = kind;
            }
        }
    }

    function clearMarkedRows() {
        for (const row of document.querySelectorAll("tr[data-duckling-mark]")) {
            row.style.outline = "";
            row.title = "";
            delete row.dataset.ducklingMark;
        }
    }

    // Listings whose price per piece differs from the database, while another listing matches it.
    function warningBlock(warning) {
        const block = document.createElement("div");
        block.style.margin = "6px 0";
        block.appendChild(line(itemLabel(warning.previous), { fontWeight: "bold" }));
        block.appendChild(line(`w bazie: ${describePrices(warning.previous)}`));
        const counted = [];
        for (const listing of warning.differing) {
            const known = counted.find((entry) =>
                samePrices(entry.listing, listing) && entry.listing.liczba === listing.liczba);
            if (known) {
                known.count += 1;
            } else {
                counted.push({ listing, count: 1 });
            }
        }
        for (const { listing, count } of counted) {
            const times = count > 1 ? ` - ${count} wystawienia` : "";
            block.appendChild(line(`na aukcji: ${describePrices(listing)}${times}`, { color: "#e8a33d" }));
        }
        block.appendChild(editInBlock(block, warning.previous));
        return block;
    }

    // One block per item whose auction prices differ from the database or from each other.
    // `choice.previous` is the database entry or null; each of `choice.options` can be saved.
    function choiceBlock(choice) {
        const block = document.createElement("div");
        block.style.margin = "6px 0";
        const label = itemLabel(choice.options[0]);
        block.appendChild(line(label, { fontWeight: "bold" }));
        const previous = choice.previous;
        const saved = previous ? `${describePrices(previous)} (${previous.data})` : "brak";
        block.appendChild(line(`w bazie: ${saved}`));
        if (choice.options.length > 1) {
            block.appendChild(line("na aukcji różne ceny, wybierz jedną:", { color: "#a89f86" }));
        }
        for (const option of choice.options) {
            const row = document.createElement("div");
            const text = document.createElement("span");
            text.textContent = `na aukcji: ${describePrices(option)} `;
            row.appendChild(text);
            if (choice.previous && samePrices(option, choice.previous)) {
                row.appendChild(document.createTextNode("(w bazie)"));
            } else {
                row.appendChild(button("Zapisz tę", () => {
                    saveEntry(option, true).then(
                        () => block.replaceChildren(line(`${label}: zapisano ${describePrices(option)}`)),
                        (error) => block.appendChild(line(error, { color: "#e07a5f" })),
                    );
                }));
            }
            block.appendChild(row);
        }
        const keepRow = document.createElement("div");
        keepRow.appendChild(button(choice.previous ? "Zostaw cenę z bazy" : "Nie zapisuj", () => {
            block.replaceChildren(line(`${label}: bez zmian`));
        }));
        keepRow.appendChild(editInBlock(block, choice.previous ?? choice.options[0]));
        block.appendChild(keepRow);
        return block;
    }

    function showReadResult(summary) {
        resultPanel?.remove();
        resultPanel = floatingPanel("duckling-read-prices-result", "360px");
        const panel = resultPanel;
        Object.assign(panel.style, { left: "50%", top: "80px", transform: "translateX(-50%)" });
        panel.replaceChildren(line("Zczytane ceny (Duckling)", TITLE_STYLE));
        const counted = summary.listings;
        const total = counted.added + counted.unchanged + counted.toChoose
            + counted.toRemove + counted.failed;
        panel.appendChild(line(`Wystawienia na aukcji: ${total}`));
        const counts = [
            ["Nowe w bazie", counted.added],
            ["Bez zmian", counted.unchanged],
            ["Do wyboru ceny (niebieski obrys)", counted.toChoose],
            ["Do zdjęcia, cena inna niż w bazie (pomarańczowy obrys)", counted.toRemove],
            ["Błędy", counted.failed],
        ];
        const list = document.createElement("ul");
        Object.assign(list.style, { margin: "2px 0 6px", paddingLeft: "18px" });
        for (const [label, count] of counts) {
            const item = document.createElement("li");
            item.textContent = `${label}: ${count}`;
            list.appendChild(item);
        }
        panel.appendChild(list);
        if (summary.unreadable.length > 0) {
            const unreadable = summary.unreadable.join(", ");
            panel.appendChild(line(`Nie odczytano ceny: ${unreadable}`, { color: "#e07a5f" }));
        }
        for (const error of summary.errors) {
            panel.appendChild(line(error, { color: "#e07a5f" }));
        }
        for (const choice of summary.choices) {
            panel.appendChild(choiceBlock(choice));
        }
        if (summary.warnings.length > 0) {
            panel.appendChild(line("Do zdjęcia (pomarańczowy obrys w tabeli):", {
                color: "#e8a33d",
                marginTop: "6px",
            }));
            for (const warning of summary.warnings) {
                panel.appendChild(warningBlock(warning));
            }
        }
        panel.appendChild(button("Zamknij", () => {
            resultPanel?.remove();
            resultPanel = null;
        }));
    }

    async function readPrices(auctionWindow) {
        const { entries, unreadable } = readMyAuctions(auctionWindow);
        // Every listing lands in exactly one of `summary.listings`, so the counts add up to all listings.
        const listingCounts = { added: 0, unchanged: 0, toChoose: 0, toRemove: 0, failed: unreadable.length };
        const summary = { listings: listingCounts, choices: [], warnings: [], unreadable, errors: [] };
        clearMarkedRows();
        for (const { listings, options } of groupByItem(entries)) {
            const first = options[0];
            try {
                if (options.length > 1) {
                    const saved = await findEntries(first);
                    const previous = saved.find((entry) => entry.serwer === serverName) ?? null;
                    // A database price equal to one of the listed prices is an earlier choice; keep it
                    // and point out the listings with other prices.
                    const matching = previous ? options.find((option) => samePrices(option, previous)) : null;
                    if (matching) {
                        // Saving the matching price changes nothing but fills in a missing icon.
                        await saveEntry(matching, false);
                        const differing = listings.filter((listing) => !samePrices(listing, previous));
                        listingCounts.unchanged += listings.length - differing.length;
                        listingCounts.toRemove += differing.length;
                        summary.warnings.push({ previous, differing });
                        markRows(differing, "remove");
                    } else {
                        listingCounts.toChoose += listings.length;
                        summary.choices.push({ previous, options });
                        markRows(listings, "choose");
                    }
                    continue;
                }
                const result = await saveEntry(first, false);
                if (result.status === "dodano") {
                    listingCounts.added += listings.length;
                } else if (result.status === "bez_zmian") {
                    listingCounts.unchanged += listings.length;
                } else if (result.status === "konflikt") {
                    listingCounts.toChoose += listings.length;
                    summary.choices.push({ previous: result.previous, options });
                    markRows(listings, "choose");
                }
            } catch (error) {
                listingCounts.failed += listings.length;
                summary.errors.push(`${first.nazwa}: ${error}`);
            }
        }
        showReadResult(summary);
    }

    // Adds "Zczytaj ceny" next to "Odnów wszystkie aukcje" while the "Twoje aukcje" tab is open.
    function watchMyAuctionsTab() {
        const myAuctionsTab = document.querySelector(".card.MY_AUCTION_OFF-tab");
        const renewWrapper = document.querySelector(".auction-renew-btn-wrapper");
        const existing = document.getElementById("duckling-read-prices");
        const tabOpen = myAuctionsTab?.classList.contains("active") && renewWrapper?.offsetParent;
        if (!tabOpen) {
            existing?.remove();
            return;
        }
        if (existing) {
            return;
        }
        // A copy of the game's own button keeps the game's look. The wrapper's class must not
        // stay, because the game reacts to clicks on it by renewing all auctions.
        const wrapper = renewWrapper.cloneNode(true);
        wrapper.id = "duckling-read-prices";
        wrapper.className = "";
        const gamePosition = getComputedStyle(renewWrapper);
        Object.assign(wrapper.style, {
            position: "absolute",
            top: gamePosition.top,
            bottom: gamePosition.bottom,
            left: `${renewWrapper.offsetLeft + renewWrapper.offsetWidth + 6}px`,
        });
        const label = [...wrapper.querySelectorAll("*")].find((element) => element.children.length === 0
            && element.textContent.trim() === "Odnów wszystkie aukcje");
        (label ?? wrapper).textContent = "Zczytaj ceny";
        for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]) {
            wrapper.addEventListener(type, (event) => event.stopPropagation());
        }
        wrapper.addEventListener("click", (event) => {
            event.stopPropagation();
            readPrices(renewWrapper.closest(".border-window") ?? document);
        });
        renewWrapper.after(wrapper);
    }

    setInterval(() => {
        try {
            watchListingWindow();
            watchMyAuctionsTab();
        } catch (error) {
            console.error("[Duckling ceny aukcji]", error);
        }
    }, CHECK_INTERVAL_MS);
})();
