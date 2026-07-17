// ============================================================================
// Механик машин — бейджи «к какой записи лорбука относится сообщение».
//
// Для каждого сообщения в чате показываем название (comment) той memory-записи
// лорбука, чей диапазон STMB_start..STMB_end это сообщение покрывает.
// Обновляется при смене чата, при добавлении сообщений и при любом сохранении
// лорбука (создание воспоминания И консолидация/суммаризация — там записи
// переименовываются, и бейджи автоматически подхватят новые названия).
//
// Модуль самодостаточный: не зависит от сборки index.build.js.
// ============================================================================

import { chat_metadata } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { METADATA_KEY, world_names, loadWorldInfo } from "../../../world-info.js";

const MODULE = "Механик машин/бейджи";

// Кэш покрытия: [{ start, end, title, number }]
let cachedRanges = [];
let chatObserver = null;
let chatObsTimer = null;
let worldTimer = null;
let stylesInjected = false;

// ----------------------------------------------------------------------------
// Определение привязанного лорбука (пассивно, без всплывающих окон)
// ----------------------------------------------------------------------------
function resolveLorebookNamePassive() {
    try {
        const s = extension_settings.STMemoryBooks;
        if (s?.moduleSettings?.manualModeEnabled) {
            const manual = chat_metadata?.STMemoryBooks?.manualLorebook ?? null;
            if (manual && Array.isArray(world_names) && world_names.includes(manual)) {
                return manual;
            }
        }
    } catch (e) {
        /* игнорируем — падаем на чат-привязанный лорбук */
    }
    return chat_metadata?.[METADATA_KEY] || null;
}

// Запись считается «воспоминанием» только по явному флагу (как в оригинале).
function isMemoryEntry(entry) {
    return !!entry && entry.stmemorybooks === true;
}

// Достаём порядковый номер из заголовка: [12], (12), {12}, #12, «12 - ...».
function parseNumberFromTitle(title) {
    if (!title || typeof title !== "string") return 0;
    const m =
        title.match(/\[(\d+)\]/) ||
        title.match(/\((\d+)\)/) ||
        title.match(/\{(\d+)\}/) ||
        title.match(/#(\d+)/) ||
        title.match(/^(\d+)(?:\s*[-\s])/);
    return m ? parseInt(m[1], 10) || 0 : 0;
}

// ----------------------------------------------------------------------------
// Перестроение кэша из лорбука
// ----------------------------------------------------------------------------
export async function rebuildMemoryLabelCache() {
    const name = resolveLorebookNamePassive();
    if (!name) {
        cachedRanges = [];
        return;
    }
    try {
        const data = await loadWorldInfo(name);
        const entries = data && data.entries ? Object.values(data.entries) : [];
        const ranges = [];
        for (const e of entries) {
            if (!isMemoryEntry(e)) continue;
            if (typeof e.STMB_start === "number" && typeof e.STMB_end === "number") {
                ranges.push({
                    start: e.STMB_start,
                    end: e.STMB_end,
                    title: (e.comment || "").trim(),
                    number: parseNumberFromTitle(e.comment),
                });
            }
        }
        cachedRanges = ranges;
    } catch (err) {
        console.warn(`[${MODULE}] Не удалось перестроить кэш:`, err);
        cachedRanges = [];
    }
}

// Какая запись покрывает сообщение. При перекрытии (после консолидации)
// побеждает запись с наибольшим номером — свежее/сводное название.
function findMemoryForMessage(id) {
    let best = null;
    for (const r of cachedRanges) {
        if (id >= r.start && id <= r.end) {
            if (!best || r.number > best.number || (r.number === best.number && r.start > best.start)) {
                best = r;
            }
        }
    }
    return best;
}

// ----------------------------------------------------------------------------
// Отрисовка бейджа на одном сообщении
// ----------------------------------------------------------------------------
function applyLabel(el) {
    const id = parseInt(el.getAttribute("mesid"), 10);
    if (!Number.isFinite(id)) return;

    const block = el.querySelector(".mes_block");
    if (!block) return;

    let label = block.querySelector(":scope > .stmb_mem_label");
    const mem = findMemoryForMessage(id);

    if (!mem || !mem.title) {
        if (label) label.remove();
        return;
    }

    if (!label) {
        label = document.createElement("div");
        label.className = "stmb_mem_label";
        const textEl = block.querySelector(":scope > .mes_text");
        if (textEl) block.insertBefore(label, textEl);
        else block.prepend(label);
    }

    if (label.dataset.title !== mem.title) {
        label.dataset.title = mem.title;
        label.title = mem.title;
        label.textContent = mem.title;
    }
}

export function refreshMemoryLabels(els) {
    const list =
        els && els.length !== undefined ? els : document.querySelectorAll("#chat .mes[mesid]");
    list.forEach(applyLabel);
}

export async function rebuildAndRefresh(els) {
    await rebuildMemoryLabelCache();
    refreshMemoryLabels(els);
}

// ----------------------------------------------------------------------------
// Стили: бейдж + понятная индикация стрелок-маркеров сцены
// ----------------------------------------------------------------------------
function injectStyles() {
    if (stylesInjected || document.getElementById("mm-mem-label-style")) {
        stylesInjected = true;
        return;
    }
    const style = document.createElement("style");
    style.id = "mm-mem-label-style";
    style.textContent = `
        /* --- Бейдж названия записи лорбука под сообщением --- */
        .stmb_mem_label {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            width: fit-content;
            max-width: 100%;
            margin: 2px 0 6px 0;
            padding: 2px 9px;
            font-size: calc(var(--mainFontSize) * 0.78);
            line-height: 1.5;
            border-radius: 10px;
            background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 22%, transparent);
            color: var(--SmartThemeQuoteColor);
            border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 55%, transparent);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: default;
        }
        .stmb_mem_label::before {
            content: "\\f02d"; /* fa-book */
            font-family: "Font Awesome 6 Free";
            font-weight: 900;
            font-size: 0.9em;
            flex: 0 0 auto;
            opacity: 0.85;
        }

        /* --- Индикация стрелок сцены (понятная цветовая логика) ---
           ▶ (начало) = ЗЕЛЁНЫЙ, ◀ (конец) = КРАСНЫЙ.
           Префикс #chat повышает специфичность над правилами форка. */

        /* 1. НЕ ВЫБРАНО — тускло-серая (обе стрелки одинаково) */
        #chat .mes_stmb_start,
        #chat .mes_stmb_end {
            filter: grayscale(1) !important;
            opacity: 0.35 !important;
            background-color: var(--SmartThemeBlurTintColor) !important;
            border: 1px solid var(--SmartThemeBorderColor) !important;
            color: var(--SmartThemeBodyColor) !important;
            box-shadow: none !important;
            transform: none;
            transition: var(--animation-duration-2x);
        }
        #chat .mes_stmb_start:hover,
        #chat .mes_stmb_end:hover {
            filter: none !important;
            opacity: 1 !important;
        }

        /* 2. ВЫБРАНО — просто сплошная заливка, без свечения и увеличения */
        /* Начало сцены — зелёная ▶ */
        #chat .mes .mes_stmb_start.on {
            opacity: 1 !important;
            filter: none !important;
            background-color: #3fb950 !important;
            border-color: #3fb950 !important;
            color: #fff !important;
            transform: none !important;
            box-shadow: none !important;
        }
        /* Конец сцены — красная ◀ */
        #chat .mes .mes_stmb_end.on {
            opacity: 1 !important;
            filter: none !important;
            background-color: #e5534b !important;
            border-color: #e5534b !important;
            color: #fff !important;
            transform: none !important;
            box-shadow: none !important;
        }

        /* 3. «Валидные точки» не выделяем — выглядят как обычная серая (не выбрано) */
        #chat .mes_stmb_start.valid-start-point,
        #chat .mes_stmb_end.valid-end-point {
            opacity: 0.35 !important;
            filter: grayscale(1) !important;
            background-color: var(--SmartThemeBlurTintColor) !important;
            border: 1px solid var(--SmartThemeBorderColor) !important;
            color: var(--SmartThemeBodyColor) !important;
            box-shadow: none !important;
            animation: none !important;
        }

        /* 4. ВНУТРИ ВЫБРАННОЙ СЦЕНЫ — лёгкая заливка обеих стрелок */
        #chat .mes_stmb_start.in-scene,
        #chat .mes_stmb_end.in-scene {
            opacity: 0.6 !important;
            filter: none !important;
            background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 28%, transparent) !important;
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 45%, transparent) !important;
            box-shadow: none !important;
        }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
}

// ----------------------------------------------------------------------------
// Наблюдатель за новыми сообщениями в чате
// ----------------------------------------------------------------------------
function startChatObserver() {
    const chat = document.getElementById("chat");
    if (!chat || chatObserver) return;
    chatObserver = new MutationObserver((mutations) => {
        let added = false;
        for (const m of mutations) {
            if (m.addedNodes && m.addedNodes.length) {
                added = true;
                break;
            }
        }
        if (!added) return;
        clearTimeout(chatObsTimer);
        chatObsTimer = setTimeout(() => refreshMemoryLabels(), 150);
    });
    chatObserver.observe(chat, { childList: true });
}

// ----------------------------------------------------------------------------
// Подсказки при наведении: объясняют текущее состояние стрелки словами.
// Ставим title «на лету» по классам — без наблюдателей, только при наведении.
// ----------------------------------------------------------------------------
let arrowTooltipsInstalled = false;
function installArrowTooltips() {
    if (arrowTooltipsInstalled) return;
    const chat = document.getElementById("chat");
    if (!chat) return;
    chat.addEventListener("mouseover", (e) => {
        const btn = e.target.closest?.(".mes_stmb_start, .mes_stmb_end");
        if (!btn) return;
        const isStart = btn.classList.contains("mes_stmb_start");
        let t;
        if (btn.classList.contains("on")) {
            t = isStart ? "✅ Здесь НАЧАЛО сцены (клик — снять)" : "✅ Здесь КОНЕЦ сцены (клик — снять)";
        } else if (btn.classList.contains("valid-start-point")) {
            t = "◀ Клик — отметить НАЧАЛО сцены с этого сообщения";
        } else if (btn.classList.contains("valid-end-point")) {
            t = "▶ Клик — отметить КОНЕЦ сцены на этом сообщении";
        } else if (btn.classList.contains("in-scene")) {
            t = "Сообщение внутри выбранной сцены";
        } else {
            t = isStart
                ? "▶ Отметить НАЧАЛО сцены с этого сообщения"
                : "◀ Отметить КОНЕЦ сцены на этом сообщении";
        }
        if (btn.title !== t) btn.title = t;
    }, true);
    arrowTooltipsInstalled = true;
}

// ----------------------------------------------------------------------------
// Точка входа: вызывается из machineMechanic.js
// ----------------------------------------------------------------------------
export function initMemoryLabels(eventSource, eventTypes) {
    injectStyles();
    startChatObserver();
    installArrowTooltips();

    // Первичная загрузка покрытия для уже открытого чата.
    rebuildAndRefresh();

    if (eventSource && eventTypes) {
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                cachedRanges = [];
                // Дать чату отрисоваться, затем подгрузить покрытие.
                setTimeout(() => {
                    startChatObserver();
                    rebuildAndRefresh();
                }, 250);
            });
        }
        if (eventTypes.WORLDINFO_UPDATED) {
            // Любое сохранение лорбука: создание воспоминания ИЛИ консолидация
            // (переименование записей) — перекрашиваем бейджи всем сообщениям.
            eventSource.on(eventTypes.WORLDINFO_UPDATED, () => {
                clearTimeout(worldTimer);
                worldTimer = setTimeout(() => rebuildAndRefresh(), 250);
            });
        }
    }
}
