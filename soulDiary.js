// ============================================================================
// Механик машин — «Дневник души» (🧠 soulDiary).
//
// САМОСТОЯТЕЛЬНАЯ сущность. Работает в паре с серверным плагином soul-md
// (plugins/soul-md/, нужен enableServerPlugins: true в config.yaml).
//
// Три дока на чат (кнопка 🧠 рядом с кнопкой полосок — листаются ◄ ►):
//   • Diary_<дата>.md — дневник: после ответа персонажа дописывается его реплика;
//   • Psyche.md — «эмоция · цель · напряжение», модель ПЕРЕЗАПИСЫВАЕТ раз в N ответов;
//   • Status.md — «доверие · динамика · факты о {{user}}», тоже перезапись раз в N.
//
// Перед генерацией по дневнику ищется по смыслу нужный кусок (родной эмбеддер ST)
// и вставляется в промт. Трекеры Psyche/Status в поиск не тянутся.
//
// В листалке есть 🌐 — перевод текущего дока через Яндекс. Он НЕ меняет файл,
// только показывает; закрыл окно — вернулся оригинал.
//
// Всё привязано к КОНКРЕТНОМУ ЧАТУ (ключ = getCurrentChatId). Удалил чат в ST —
// событие CHAT_DELETED/GROUP_CHAT_DELETED -> /purge -> файлы этого чата стёрты.
// ============================================================================

import {
    getRequestHeaders,
    setExtensionPrompt,
    getCurrentChatId,
    generateQuietPrompt,
    name1,
    name2,
} from "../../../../script.js";

const API = "/api/plugins/soul-md";
const BTN_ID = "mm-souldiary-button";
const INJECT_KEY = "MM_SOULDIARY";
const TRACKER_EVERY = 4; // обновлять Psyche/Status каждые N ответов персонажа

let ctxRef = null;
let stylesInjected = false;
let replyCount = 0;
let trackerBusy = false;
let internalGen = false; // true пока идёт служебная генерация трекеров (гасит наши хуки)

const today = () => new Date().toISOString().slice(0, 10);
const chatId = () => { try { return getCurrentChatId() || ""; } catch (e) { return ""; } };

async function api(route, body) {
    try {
        const r = await fetch(`${API}/${route}`, {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        return await r.json();
    } catch (e) {
        console.warn("[Дневник души] сеть/сервер:", e);
        return null;
    }
}

// перевод через Яндекс (штатный эндпоинт ST). НЕ пишет никуда — только возвращает текст.
async function yaTranslate(text) {
    try {
        const r = await fetch("/api/translate/yandex", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ chunks: [text], lang: "ru" }),
        });
        return r.ok ? await r.text() : null;
    } catch (e) {
        console.warn("[Дневник души] перевод:", e);
        return null;
    }
}

// ----------------------------------------------------------------------------
// Трекеры Psyche / Status — модель переписывает файл целиком
// ----------------------------------------------------------------------------
const TRACKERS = [
    {
        name: "Psyche",
        build: (prev, recent) =>
`[System maintenance task — not roleplay. Output ONLY the note.]
You maintain a short internal-state note for the character "${name2}".
Rewrite the ENTIRE note using the recent dialogue and the previous note.
Output 3-5 short plain-text lines, no preamble, no quotes:
- Primary emotion + intensity (x/5)
- What ${name2} secretly wants right now
- Inner tension or dilemma

PREVIOUS NOTE:
${prev || "(none yet)"}

RECENT DIALOGUE:
${recent}`,
    },
    {
        name: "Status",
        build: (prev, recent) =>
`[System maintenance task — not roleplay. Output ONLY the tracker.]
You maintain a relationship tracker: how "${name2}" currently sees "${name1}".
Rewrite the ENTIRE tracker using the recent dialogue and the previous version.
Output short plain-text lines, no preamble:
- Trust level: Distrustful / Wary / Neutral / Developing Trust / Deeply Bound
- Current dynamic (one line)
- Unspoken tension
- Key facts about ${name1}

PREVIOUS:
${prev || "(none yet)"}

RECENT DIALOGUE:
${recent}`,
    },
];

function recentDialogue(n = 6) {
    const list = ctxRef?.chat || [];
    return list.slice(-n)
        .map((m) => `${m.is_user ? name1 : name2}: ${(m.mes || "").trim()}`)
        .join("\n");
}

async function updateTrackers() {
    if (trackerBusy) return;
    const chat = chatId();
    if (!chat || typeof generateQuietPrompt !== "function") return;

    trackerBusy = true;
    internalGen = true; // чтобы наши же хуки не сработали на служебную генерацию
    try {
        const recent = recentDialogue(6);
        for (const t of TRACKERS) {
            try {
                const prevRes = await api("get", { chat, name: t.name });
                const prev = (prevRes && prevRes.text) || "";
                const out = await generateQuietPrompt({
                    quietPrompt: t.build(prev, recent),
                    skipWIAN: true,
                    responseLength: 220,
                });
                const text = (out || "").trim();
                if (text) await api("tracker", { chat, name: t.name, text });
            } catch (e) {
                console.warn("[Дневник души] трекер", t.name, e);
            }
        }
    } finally {
        internalGen = false;
        trackerBusy = false;
    }
}

// ----------------------------------------------------------------------------
// Стили листалки
// ----------------------------------------------------------------------------
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const s = document.createElement("style");
    s.textContent = `
        #mm-souldiary-modal { position: fixed; inset: 0; z-index: 10050; display: flex;
            align-items: center; justify-content: center; background: rgba(0,0,0,.5); }
        #mm-souldiary-modal .mm-sd-box { width: min(680px, 92vw); max-height: 82vh; display: flex;
            flex-direction: column; padding: 14px; border-radius: 12px;
            background: var(--SmartThemeBlurTintColor, #1e1e2a);
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); }
        #mm-souldiary-modal .mm-sd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        #mm-souldiary-modal .mm-sd-title { flex: 1; text-align: center; font-weight: 600; }
        #mm-souldiary-modal .mm-sd-nav,
        #mm-souldiary-modal .mm-sd-tr { cursor: pointer; padding: 4px 11px; border-radius: 8px; user-select: none;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); }
        #mm-souldiary-modal .mm-sd-tr.mm-sd-on { background: var(--SmartThemeQuoteColor, rgba(120,140,255,.35)); }
        #mm-souldiary-modal .mm-sd-body { flex: 1; overflow-y: auto; white-space: pre-wrap;
            padding: 10px; border-radius: 8px; background: rgba(255,255,255,.05);
            font-size: .92em; line-height: 1.5; }
        #mm-souldiary-modal .mm-sd-close { margin-top: 10px; align-self: flex-end; }
    `;
    document.head.appendChild(s);
}

// ----------------------------------------------------------------------------
// Кнопка 🧠 — сразу за кнопкой полосок-статов
// ----------------------------------------------------------------------------
function createButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.className = "fa-solid fa-brain interactable";
    btn.title = "Дневник души (память в .md, привязана к этому чату)";
    btn.tabIndex = 0;
    btn.addEventListener("click", openViewer);

    const statbar = document.getElementById("mm-statbar-button");
    const toc = document.getElementById("mm-toc-button");
    const wrench = document.getElementById("mm-wand-button");
    const wand = document.getElementById("extensionsMenuButton");
    if (statbar) statbar.after(btn);
    else if (toc) toc.after(btn);
    else if (wrench) wrench.after(btn);
    else document.getElementById("leftSendForm")?.appendChild(btn);

    const wandOrder = wand ? (parseInt(getComputedStyle(wand).order, 10) || 4) : 4;
    btn.style.order = String(wandOrder + 4); // у кнопки полосок +3, 🧠 сразу за ней
}

// ----------------------------------------------------------------------------
// Листалка .md-доков (◄ ► переключают, 🌐 переводит — не меняя файла)
// ----------------------------------------------------------------------------
async function openViewer() {
    injectStyles();
    document.getElementById("mm-souldiary-modal")?.remove();

    const chat = chatId();
    const res = chat ? await api("docs", { chat }) : null;
    const docs = (res && res.docs) || [];

    const ov = document.createElement("div");
    ov.id = "mm-souldiary-modal";
    ov.innerHTML = `
        <div class="mm-sd-box">
            <div class="mm-sd-head">
                <div class="mm-sd-tr" title="Перевод (Яндекс) — не меняет файл">🌐</div>
                <div class="mm-sd-nav" data-nav="-1">◄</div>
                <div class="mm-sd-title"></div>
                <div class="mm-sd-nav" data-nav="1">►</div>
            </div>
            <div class="mm-sd-body"></div>
            <div class="menu_button mm-sd-close">Закрыть</div>
        </div>`;
    document.body.appendChild(ov);

    let i = 0;
    let showTr = false;
    const trCache = {}; // перевод по индексу дока; живёт только пока окно открыто
    const title = ov.querySelector(".mm-sd-title");
    const body = ov.querySelector(".mm-sd-body");
    const trBtn = ov.querySelector(".mm-sd-tr");

    async function paint() {
        if (!chat) {
            title.textContent = "Нет активного чата";
            body.textContent = "Открой чат — дневник привязан к конкретному чату.";
            return;
        }
        const d = docs[i];
        title.textContent = docs.length ? `${d.name}  (${i + 1}/${docs.length})` : "Дневник этого чата пуст";
        if (!d) {
            body.textContent = "Пока ничего не записано. Записи появятся после ответов персонажа.";
            return;
        }
        if (!showTr) { body.textContent = d.text; return; }
        if (trCache[i] == null) {
            body.textContent = "Перевод…";
            trCache[i] = await yaTranslate(d.text);
        }
        body.textContent = trCache[i] || d.text; // не удалось перевести — показываем оригинал
    }

    trBtn.addEventListener("click", () => {
        showTr = !showTr;
        trBtn.classList.toggle("mm-sd-on", showTr);
        paint();
    });
    ov.querySelectorAll("[data-nav]").forEach((b) =>
        b.addEventListener("click", () => {
            if (!docs.length) return;
            i = (i + Number(b.dataset.nav) + docs.length) % docs.length;
            paint();
        }),
    );
    const close = () => ov.remove();
    ov.querySelector(".mm-sd-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    paint();
}

// ----------------------------------------------------------------------------
// События: дописать дневник + обновить трекеры после ответа; искать перед генерацией
// ----------------------------------------------------------------------------
function hookEvents() {
    const es = ctxRef?.eventSource;
    const et = ctxRef?.eventTypes;
    if (!es || !et) return;

    const rendered = et.CHARACTER_MESSAGE_RENDERED || et.MESSAGE_RECEIVED;
    es.on(rendered, async () => {
        if (internalGen) return; // не реагируем на служебные генерации трекеров
        const chat = chatId();
        if (!chat) return;
        const list = ctxRef?.chat;
        const last = list && list[list.length - 1];
        if (!last || last.is_user || !last.mes) return;

        await api("append", { chat, date: today(), text: last.mes });

        replyCount++;
        if (replyCount % TRACKER_EVERY === 0) updateTrackers(); // фоном, без await
    });

    if (et.GENERATION_STARTED) {
        es.on(et.GENERATION_STARTED, async () => {
            if (internalGen) return; // трекеры генерятся тихо — не подмешиваем и не ищем
            const chat = chatId();
            const list = ctxRef?.chat || [];
            const lastUser = [...list].reverse().find((m) => m.is_user);
            if (!chat || !lastUser?.mes) { setExtensionPrompt(INJECT_KEY, "", 1, 4); return; }
            const q = await api("query", { chat, query: lastUser.mes, k: 3 });
            const mem = q && q.memory;
            setExtensionPrompt(INJECT_KEY, mem ? `[Из дневника персонажа]\n${mem}` : "", 1, 4);
        });
    }

    // удаление чата -> снести его дневник (событие даёт id удалённого чата)
    const purge = (deletedChat) => { if (deletedChat) api("purge", { chat: deletedChat }); };
    if (et.CHAT_DELETED) es.on(et.CHAT_DELETED, purge);
    if (et.GROUP_CHAT_DELETED) es.on(et.GROUP_CHAT_DELETED, purge);
}

// ----------------------------------------------------------------------------
// Точка входа
// ----------------------------------------------------------------------------
export function initSoulDiary(ctx) {
    ctxRef = ctx || (typeof SillyTavern !== "undefined" && SillyTavern.getContext ? SillyTavern.getContext() : null);
    injectStyles();
    createButton();
    hookEvents();

    if (ctxRef?.eventSource && ctxRef?.eventTypes?.CHAT_CHANGED) {
        ctxRef.eventSource.on(ctxRef.eventTypes.CHAT_CHANGED, () => createButton());
    }
}
