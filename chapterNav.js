// ============================================================================
// Механик машин — «Оглавление» (навигация по главам).
//
// Значок оглавления в панели ввода (после 🔧). По клику слева выезжает панель
// со списком глав — это memory-записи лорбука (диапазон STMB_start..STMB_end +
// название comment). Клик по главе мотает чат к её началу и подсвечивает
// диапазон. Главу можно развернуть и увидеть входящие сообщения — клик по
// сообщению мотает прямо к нему (при необходимости догружая старые).
//
// Модуль самодостаточный, сборка index.build.js не нужна.
// ============================================================================

import { chat_metadata, showMoreMessages } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { METADATA_KEY, world_names, loadWorldInfo } from "../../../world-info.js";

const BTN_ID = "mm-toc-button";
const PANEL_ID = "mm-toc-panel";
const MODULE = "Механик машин/оглавление";

let ctxRef = null;
let stylesInjected = false;

// ----------------------------------------------------------------------------
// Данные глав
// ----------------------------------------------------------------------------
function resolveLorebookNamePassive() {
    try {
        const s = extension_settings.STMemoryBooks;
        if (s?.moduleSettings?.manualModeEnabled) {
            const manual = chat_metadata?.STMemoryBooks?.manualLorebook ?? null;
            if (manual && Array.isArray(world_names) && world_names.includes(manual)) return manual;
        }
    } catch (e) { /* fallback ниже */ }
    return chat_metadata?.[METADATA_KEY] || null;
}

function isMemoryEntry(e) {
    return !!e && e.stmemorybooks === true;
}

function parseNumberFromTitle(title) {
    if (!title || typeof title !== "string") return 0;
    const m =
        title.match(/\[(\d+)\]/) || title.match(/\((\d+)\)/) ||
        title.match(/\{(\d+)\}/) || title.match(/#(\d+)/) ||
        title.match(/^(\d+)(?:\s*[-\s])/);
    return m ? parseInt(m[1], 10) || 0 : 0;
}

async function buildChapters() {
    const name = resolveLorebookNamePassive();
    if (!name) return { name: null, chapters: [] };
    try {
        const data = await loadWorldInfo(name);
        const entries = data && data.entries ? Object.values(data.entries) : [];
        const chapters = [];
        for (const e of entries) {
            if (!isMemoryEntry(e)) continue;
            if (typeof e.STMB_start === "number" && typeof e.STMB_end === "number") {
                chapters.push({
                    start: e.STMB_start,
                    end: e.STMB_end,
                    title: (e.comment || "").trim() || `#${e.STMB_start}–${e.STMB_end}`,
                    number: parseNumberFromTitle(e.comment),
                });
            }
        }
        chapters.sort((a, b) => a.start - b.start || a.end - b.end);
        return { name, chapters };
    } catch (err) {
        console.warn(`[${MODULE}] Не удалось собрать главы:`, err);
        return { name, chapters: [] };
    }
}

// ----------------------------------------------------------------------------
// Навигация к сообщению (с догрузкой старых)
// ----------------------------------------------------------------------------
function findMes(id) {
    return document.querySelector(`#chat .mes[mesid="${id}"]`);
}

async function ensureLoaded(id) {
    let el = findMes(id);
    if (el) return el;

    // Старые сообщения могут быть не отрисованы (SillyTavern грузит их окном).
    // Догружаем ровно столько, чтобы нужное сообщение попало в DOM.
    const firstEl = document.querySelector("#chat .mes[mesid]");
    const firstId = firstEl ? Number(firstEl.getAttribute("mesid")) : null;
    if (firstId !== null && !isNaN(firstId) && id < firstId) {
        try {
            await showMoreMessages(firstId - id + 3);
            await new Promise((r) => setTimeout(r, 60));
        } catch (e) {
            console.warn(`[${MODULE}] Не удалось догрузить сообщения:`, e);
        }
    }
    return findMes(id);
}

function highlightRange(start, end) {
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    for (let i = s; i <= e; i++) {
        const m = findMes(i);
        if (m) {
            m.classList.add("mm-toc-highlight");
            setTimeout(() => m.classList.remove("mm-toc-highlight"), 2600);
        }
    }
}

function scrollChatTo(el) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) {
        el.scrollIntoView({ block: "center" });
        return;
    }
    // Явный расчёт позиции надёжнее scrollIntoView, когда только что вставили
    // сотни сообщений и дистанция прокрутки огромная.
    const chatRect = chatEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = (elRect.top - chatRect.top) - (chatEl.clientHeight / 2 - elRect.height / 2);
    const top = Math.max(0, chatEl.scrollTop + delta);
    const far = Math.abs(delta) > 4000;
    chatEl.scrollTo({ top, behavior: far ? "auto" : "smooth" });
}

async function navigateTo(id, rangeStart, rangeEnd) {
    const el = await ensureLoaded(id);
    if (!el) {
        try { toastr?.info?.("Сообщение ещё не прогружено — прокрутите чат вверх.", "Оглавление"); } catch (e) {}
        return;
    }
    // Дать раскладке устояться после возможной догрузки сообщений.
    await new Promise((r) => requestAnimationFrame(() => r()));
    scrollChatTo(el);
    highlightRange(rangeStart ?? id, rangeEnd ?? id);
}

// ----------------------------------------------------------------------------
// Панель
// ----------------------------------------------------------------------------
function excerptFor(id) {
    try {
        const m = ctxRef?.chat?.[id];
        if (!m) return { who: `#${id}`, text: "" };
        const who = m.is_user ? (ctxRef?.name1 || "Вы") : (m.name || `#${id}`);
        const text = String(m.mes || "").replace(/\s+/g, " ").trim().slice(0, 70);
        return { who, text };
    } catch (e) {
        return { who: `#${id}`, text: "" };
    }
}

function makeMsgRow(id) {
    const { who, text } = excerptFor(id);
    const row = document.createElement("div");
    row.className = "mm-toc-msg";
    row.innerHTML = `<span class="mm-toc-msg-id">#${id}</span><span class="mm-toc-msg-who"></span><span class="mm-toc-msg-text"></span>`;
    row.querySelector(".mm-toc-msg-who").textContent = who;
    row.querySelector(".mm-toc-msg-text").textContent = text ? `: ${text}` : "";
    row.title = `${who}: ${text}`;
    row.addEventListener("click", (e) => {
        e.stopPropagation();
        navigateTo(id, id, id);
    });
    return row;
}

function makeChapterEl(ch) {
    const wrap = document.createElement("div");
    wrap.className = "mm-toc-chapter";

    const head = document.createElement("div");
    head.className = "mm-toc-chapter-head";
    head.innerHTML = `
        <div class="mm-toc-caret fa-solid fa-caret-right" tabindex="0" title="Показать сообщения главы"></div>
        <div class="mm-toc-chapter-main">
            <div class="mm-toc-chapter-title"></div>
            <div class="mm-toc-range"></div>
        </div>`;
    head.querySelector(".mm-toc-chapter-title").textContent = ch.title;
    const count = ch.end - ch.start + 1;
    head.querySelector(".mm-toc-range").textContent = `#${ch.start}–${ch.end} · ${count} сообщ.`;

    const msgs = document.createElement("div");
    msgs.className = "mm-toc-msgs";
    msgs.style.display = "none";
    let built = false;

    const caret = head.querySelector(".mm-toc-caret");
    const toggle = (e) => {
        e.stopPropagation();
        const open = msgs.style.display !== "none";
        if (open) {
            msgs.style.display = "none";
            caret.classList.remove("fa-caret-down");
            caret.classList.add("fa-caret-right");
        } else {
            if (!built) {
                const frag = document.createDocumentFragment();
                for (let i = ch.start; i <= ch.end; i++) frag.appendChild(makeMsgRow(i));
                msgs.appendChild(frag);
                built = true;
            }
            msgs.style.display = "";
            caret.classList.remove("fa-caret-right");
            caret.classList.add("fa-caret-down");
        }
    };
    caret.addEventListener("click", toggle);
    caret.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") toggle(e); });

    // Клик по названию главы — перейти к её началу и подсветить диапазон.
    head.querySelector(".mm-toc-chapter-main").addEventListener("click", () => {
        navigateTo(ch.start, ch.start, ch.end);
    });

    wrap.appendChild(head);
    wrap.appendChild(msgs);
    return wrap;
}

async function buildPanel() {
    const { name, chapters } = await buildChapters();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "mm-toc-header";
    header.innerHTML = `
        <div class="mm-toc-title"><i class="fa-solid fa-list-ol"></i> Оглавление</div>
        <div class="mm-toc-close fa-solid fa-xmark interactable" title="Закрыть" tabindex="0"></div>`;
    header.querySelector(".mm-toc-close").addEventListener("click", closePanel);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "mm-toc-list";
    if (!name) {
        list.innerHTML = `<div class="mm-toc-empty">К этому чату не привязан лорбук воспоминаний.</div>`;
    } else if (chapters.length === 0) {
        list.innerHTML = `<div class="mm-toc-empty">В лорбуке «${name}» пока нет глав (воспоминаний с диапазоном).</div>`;
    } else {
        for (const ch of chapters) list.appendChild(makeChapterEl(ch));
    }
    panel.appendChild(list);

    return panel;
}

function closePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.classList.remove("open");
    document.removeEventListener("keydown", onEsc, true);
    // Убираем после анимации закрытия.
    setTimeout(() => {
        const el = document.getElementById(PANEL_ID);
        if (el && !el.classList.contains("open")) el.remove();
    }, 240);
}

function onEsc(e) {
    if (e.key === "Escape") closePanel();
}

async function openPanel() {
    let panel = await buildPanel();
    document.body.appendChild(panel);
    // Запускаем анимацию въезда на следующий кадр.
    requestAnimationFrame(() => panel.classList.add("open"));
    document.addEventListener("keydown", onEsc, true);
}

async function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) { closePanel(); return; }
    await openPanel();
}

// ----------------------------------------------------------------------------
// Кнопка в панели ввода
// ----------------------------------------------------------------------------
function createTocButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.className = "fa-solid fa-list-ol interactable";
    btn.title = "Оглавление (главы)";
    btn.tabIndex = 0;
    btn.addEventListener("click", togglePanel);

    // Порядок: 🪄 палочка → 🔧 ключ → 📖 оглавление.
    const wrench = document.getElementById("mm-wand-button");
    const wand = document.getElementById("extensionsMenuButton");
    if (wrench) wrench.after(btn);
    else if (wand) wand.after(btn);
    else document.getElementById("leftSendForm")?.appendChild(btn);

    // Иконки в #leftSendForm расставляются через CSS `order`. Ставим оглавление
    // сразу после ключа (order палочки обычно 4 → ключ 5 → оглавление 6).
    const wandOrder = wand ? (parseInt(getComputedStyle(wand).order, 10) || 4) : 4;
    btn.style.order = String(wandOrder + 2);
}

// ----------------------------------------------------------------------------
// Стили
// ----------------------------------------------------------------------------
function injectStyles() {
    if (stylesInjected || document.getElementById("mm-toc-style")) { stylesInjected = true; return; }
    const style = document.createElement("style");
    style.id = "mm-toc-style";
    style.textContent = `
        #${PANEL_ID} {
            position: fixed; top: 0; left: 0; height: 100vh;
            width: 340px; max-width: 86vw; z-index: 10050;
            display: flex; flex-direction: column;
            background: var(--SmartThemeBlurTintColor, #1c1c1c);
            backdrop-filter: blur(var(--SmartThemeBlurStrength, 6px));
            -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 6px));
            border-right: 1px solid var(--SmartThemeBorderColor, #444);
            box-shadow: 3px 0 16px rgba(0,0,0,0.45);
            transform: translateX(-102%);
            transition: transform 0.22s ease;
            color: var(--SmartThemeBodyColor, #eee);
        }
        #${PANEL_ID}.open { transform: translateX(0); }
        .mm-toc-header {
            display: flex; align-items: center; justify-content: space-between;
            gap: 10px; padding: 12px 14px;
            border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
        }
        .mm-toc-title { font-weight: 700; display: flex; align-items: center; gap: 8px; }
        .mm-toc-title i { color: var(--SmartThemeQuoteColor); }
        .mm-toc-close { cursor: pointer; opacity: 0.7; padding: 4px 6px; border-radius: 6px; }
        .mm-toc-close:hover { opacity: 1; background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent); }
        .mm-toc-list { flex: 1; overflow-y: auto; padding: 6px 8px 20px; }
        .mm-toc-empty { opacity: 0.7; padding: 16px 8px; font-size: 0.9em; }
        .mm-toc-chapter { border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 55%, transparent); }
        .mm-toc-chapter-head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 6px; }
        .mm-toc-caret {
            cursor: pointer; opacity: 0.7; padding: 3px 5px; margin-top: 1px;
            border-radius: 5px; flex: 0 0 auto;
        }
        .mm-toc-caret:hover { opacity: 1; background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent); }
        .mm-toc-chapter-main { flex: 1; min-width: 0; cursor: pointer; }
        .mm-toc-chapter-main:hover .mm-toc-chapter-title { color: var(--SmartThemeQuoteColor); }
        .mm-toc-chapter-title {
            font-weight: 600; line-height: 1.3;
            overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
            -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        }
        .mm-toc-range { font-size: 0.78em; opacity: 0.65; margin-top: 2px; }
        .mm-toc-msgs { padding: 2px 0 6px 26px; }
        .mm-toc-msg {
            display: flex; gap: 6px; align-items: baseline;
            padding: 4px 6px; border-radius: 6px; cursor: pointer;
            font-size: 0.82em; line-height: 1.35;
        }
        .mm-toc-msg:hover { background: color-mix(in srgb, var(--SmartThemeQuoteColor) 16%, transparent); }
        .mm-toc-msg-id { flex: 0 0 auto; opacity: 0.6; font-variant-numeric: tabular-nums; }
        .mm-toc-msg-who { flex: 0 0 auto; font-weight: 600; color: var(--SmartThemeQuoteColor); }
        .mm-toc-msg-text { flex: 1; min-width: 0; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* Подсветка сообщений при переходе */
        .mm-toc-highlight {
            animation: mm-toc-flash 2.6s ease;
            border-radius: 10px;
        }
        @keyframes mm-toc-flash {
            0%, 100% { box-shadow: 0 0 0 0 transparent; background-color: transparent; }
            12% { box-shadow: 0 0 0 2px var(--SmartThemeQuoteColor); background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 18%, transparent); }
            70% { box-shadow: 0 0 0 2px var(--SmartThemeQuoteColor); background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, transparent); }
        }
        @media (max-width: 500px) {
            #${PANEL_ID} { width: 86vw; }
        }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
}

// ----------------------------------------------------------------------------
// Точка входа
// ----------------------------------------------------------------------------
export function initChapterNav(ctx) {
    ctxRef = ctx || (typeof SillyTavern !== "undefined" && SillyTavern.getContext ? SillyTavern.getContext() : null);
    injectStyles();
    createTocButton();

    // Кнопка живёт в панели ввода и не пересоздаётся, но подстрахуемся на смену чата.
    if (ctxRef?.eventSource && ctxRef?.eventTypes?.CHAT_CHANGED) {
        ctxRef.eventSource.on(ctxRef.eventTypes.CHAT_CHANGED, () => {
            createTocButton();
            // Если панель открыта — перестроим её под новый чат.
            const open = document.getElementById(PANEL_ID);
            if (open) { closePanel(); }
        });
    }
}
