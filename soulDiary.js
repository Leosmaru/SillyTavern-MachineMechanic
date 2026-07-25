// ============================================================================
// Механик машин — «Дневник души» (🧠 soulDiary).
//
// САМОСТОЯТЕЛЬНАЯ сущность. Работает в паре с серверным плагином soul-md
// (plugins/soul-md/, нужен enableServerPlugins: true в config.yaml):
//   • после ответа персонажа — дописывает его реплику в .md-дневник (/append);
//   • перед генерацией — тянет по смыслу нужный кусок и вставляет в промт (/query);
//   • по кнопке 🧠 (рядом с кнопкой полосок) — листалка всех .md-доков чата (/docs).
//
// ВАЖНО: дневник привязан к КОНКРЕТНОМУ ЧАТУ (ключ папки = getCurrentChatId()).
// У каждого чата свой дневник. Удаляешь чат в ST -> событие CHAT_DELETED /
// GROUP_CHAT_DELETED -> зовём /purge -> файлы дневника этого чата стираются.
//
// Поиск по смыслу считает РОДНОЙ эмбеддер ST на сервере (all-mpnet-base-v2).
// ============================================================================

import { getRequestHeaders, setExtensionPrompt, getCurrentChatId } from "../../../../script.js";

const API = "/api/plugins/soul-md";
const BTN_ID = "mm-souldiary-button";
const INJECT_KEY = "MM_SOULDIARY";

let ctxRef = null;
let stylesInjected = false;

const today = () => new Date().toISOString().slice(0, 10);
const chatId = () => {
    try { return getCurrentChatId() || ""; } catch (e) { return ""; }
};

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
        #mm-souldiary-modal .mm-sd-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        #mm-souldiary-modal .mm-sd-title { flex: 1; text-align: center; font-weight: 600; }
        #mm-souldiary-modal .mm-sd-nav { cursor: pointer; padding: 4px 12px; border-radius: 8px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); user-select: none; }
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
// Листалка .md-доков (◄ ►) — только для текущего чата
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
                <div class="mm-sd-nav" data-nav="-1">◄</div>
                <div class="mm-sd-title"></div>
                <div class="mm-sd-nav" data-nav="1">►</div>
            </div>
            <div class="mm-sd-body"></div>
            <div class="menu_button mm-sd-close">Закрыть</div>
        </div>`;
    document.body.appendChild(ov);

    let i = 0;
    const title = ov.querySelector(".mm-sd-title");
    const body = ov.querySelector(".mm-sd-body");
    const draw = () => {
        const d = docs[i];
        if (!chat) {
            title.textContent = "Нет активного чата";
            body.textContent = "Открой чат — дневник привязан к конкретному чату.";
            return;
        }
        title.textContent = docs.length ? `${d.name}  (${i + 1}/${docs.length})` : "Дневник этого чата пуст";
        body.textContent = d ? d.text
            : "Пока ничего не записано. Записи появятся после ответов персонажа в этом чате.";
    };
    ov.querySelectorAll("[data-nav]").forEach((b) =>
        b.addEventListener("click", () => {
            if (!docs.length) return;
            i = (i + Number(b.dataset.nav) + docs.length) % docs.length;
            draw();
        }),
    );
    const close = () => ov.remove();
    ov.querySelector(".mm-sd-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    draw();
}

// ----------------------------------------------------------------------------
// События: дописать после ответа, искать перед генерацией, чистить при удалении чата
// ----------------------------------------------------------------------------
function hookEvents() {
    const es = ctxRef?.eventSource;
    const et = ctxRef?.eventTypes;
    if (!es || !et) return;

    // после ответа персонажа -> дописать его реплику в дневник текущего чата
    const rendered = et.CHARACTER_MESSAGE_RENDERED || et.MESSAGE_RECEIVED;
    es.on(rendered, async () => {
        const chat = chatId();
        if (!chat) return;
        const list = ctxRef?.chat;
        const last = list && list[list.length - 1];
        if (!last || last.is_user || !last.mes) return;
        await api("append", { chat, date: today(), text: last.mes });
    });

    // перед генерацией -> найти по смыслу и вставить в промт
    if (et.GENERATION_STARTED) {
        es.on(et.GENERATION_STARTED, async () => {
            const chat = chatId();
            const list = ctxRef?.chat || [];
            const lastUser = [...list].reverse().find((m) => m.is_user);
            if (!chat || !lastUser?.mes) { setExtensionPrompt(INJECT_KEY, "", 1, 4); return; }
            const res = await api("query", { chat, query: lastUser.mes, k: 3 });
            const mem = res && res.memory;
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
