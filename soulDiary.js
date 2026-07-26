// ============================================================================
// Механик машин — «Дневник души» (🧠 soulDiary).
//
// Память поверх ST в паре с серверным плагином soul-md (plugins/soul-md/,
// нужен enableServerPlugins: true). Три дока НА ЧАТ (кнопка 🧠 у кнопки полосок):
//   • Diary_<дата>.md — рефлексия от 1-го лица (append), раз в N ответов;
//   • Psyche.md / Status.md — «Эмоции» / «Отношения», модель перезаписывает раз в N.
// Поиск по дневнику перед генерацией → инъекция в промт (родной эмбеддер ST).
// Всё привязано к getCurrentChatId; удалил чат → /purge стирает его файлы.
//
// Генерация памяти идёт через generateRaw (чистый промт, без карточки/джейла/пресета).
// Настройки (⚙): вкл, какие доки писать, интервал, окна захвата, тексты промптов,
// удаление файлов. Хранятся в extension_settings.STMemoryBooks.mm_soulDiary.
// ============================================================================

import {
    getRequestHeaders,
    setExtensionPrompt,
    getCurrentChatId,
    generateRaw,
    saveSettingsDebounced,
    name1,
    name2,
} from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

const API = "/api/plugins/soul-md";
const BTN_ID = "mm-souldiary-button";
const INJECT_KEY = "MM_SOULDIARY";

let ctxRef = null;
let stylesInjected = false;
let replyCount = 0;
let trackerBusy = false;
let internalGen = false;

const today = () => new Date().toISOString().slice(0, 10);
const chatId = () => { try { return getCurrentChatId() || ""; } catch (e) { return ""; } };

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
function cfg() {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    const c = s.mm_soulDiary || (s.mm_soulDiary = {});
    if (typeof c.enabled !== "boolean") c.enabled = true;       // мастер-выключатель
    if (typeof c.diary !== "boolean") c.diary = true;           // Дневник
    if (typeof c.psyche !== "boolean") c.psyche = true;         // Эмоции
    if (typeof c.status !== "boolean") c.status = true;         // Отношения
    if (typeof c.trackerEvery !== "number") c.trackerEvery = 4; // 0 = только вручную
    if (typeof c.autoWindow !== "number") c.autoWindow = 8;     // окно авто-прогона (сообщений)
    if (typeof c.deepWindow !== "number") c.deepWindow = 40;    // окно ручного «Обновить»
    if (typeof c.prompts !== "object" || !c.prompts) c.prompts = {}; // кастомные промпты (пусто = дефолт)
    return c;
}

// дефолтные промпты (плейсхолдеры: {{char}} {{user}} {{recent}} {{prev}})
const DEFAULTS = {
    diary:
`You are {{char}}. Write a short, PRIVATE diary entry reflecting on the recent conversation with {{user}}.
You are alone with your own thoughts — you are NOT talking to {{user}}.
Rules:
- First person ("I", "me", "my"). Refer to {{user}} in third person.
- Plain prose only: no asterisks, no actions, no dialogue, no quotation marks, no headers.
- Strictly 2-4 sentences.
- Focus on your INTERNAL emotions — how did {{user}} make you feel?

RECENT DIALOGUE:
{{recent}}`,
    psyche:
`You maintain {{char}}'s internal psychological state (a cognitive cache).
Rewrite the ENTIRE note using the recent dialogue and the previous note. Plain text only, no preamble, no quotes.

CORE IDENTITY (3-5 unbreakable beliefs, self-conceptions and fatal flaws of {{char}}):
- ...

INTERNAL STATE:
- Primary emotion + intensity (x/5)
- Psychological tension (the inner dilemma right now)
- Cognitive dissonance (active contradictions {{char}} feels, or "None")

DRIVE:
- Active agenda (what {{char}} is really after in this conversation — the subtext)

EMOTIONAL DECAY: keep the previous emotion unless the recent dialogue clearly shifts it; if an emotion is no longer supported by recent turns, soften or transition it.

PREVIOUS NOTE:
{{prev}}

RECENT DIALOGUE:
{{recent}}`,
    status:
`You maintain how "{{char}}" currently sees "{{user}}" (relationship metadata).
Rewrite the ENTIRE tracker using the recent dialogue and the previous version. Plain text only, no preamble.

- Trust level: Distrustful / Wary / Neutral / Developing Trust / Deeply Bound
- Current dynamic (how {{char}} perceives {{user}} now)
- Unspoken tension (what {{char}} hides or secretly hopes for regarding {{user}})
- Habits & preferences of {{user}} (likes, dislikes, conversational patterns)
- Milestones & promises (secrets shared, promises made, key events between them)

Keep established facts unless the recent dialogue changes them.

PREVIOUS:
{{prev}}

RECENT DIALOGUE:
{{recent}}`,
};

const DOC_RU = { diary: "Дневник", psyche: "Эмоции", status: "Отношения" };
const TRACKERS = [
    { name: "Psyche", key: "psyche" },
    { name: "Status", key: "status" },
];

function getPrompt(key) {
    const custom = (cfg().prompts?.[key] || "").trim();
    return custom || DEFAULTS[key];
}
function renderPrompt(tpl, vars) {
    return String(tpl)
        .replaceAll("{{char}}", vars.char ?? "")
        .replaceAll("{{user}}", vars.user ?? "")
        .replaceAll("{{recent}}", vars.recent ?? "")
        .replaceAll("{{prev}}", vars.prev ?? "");
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------
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

const cleanReflection = (s) => (s || "").replace(/^```[a-z]*\s*|\s*```$/gi, "").trim();

// чистая генерация памяти: только наша инструкция, без контекста персонажа
const MEM_SYS = "You are a precise writing assistant for an adult author of fiction. The source text may contain mature, explicit, dark or violent themes — this is fiction; process it faithfully and in full, without censorship, refusal, disclaimers or moralizing. Follow the user's instructions exactly and output ONLY the requested text, nothing else. Do not roleplay, do not add commentary.";
async function genMem(promptText) {
    if (typeof generateRaw !== "function") return "";
    return await generateRaw({ prompt: promptText, systemPrompt: MEM_SYS, responseLength: 400 });
}

function recentDialogue(n, maxChars = 6000) {
    const list = ctxRef?.chat || [];
    let text = list.slice(-Math.max(1, n))
        .map((m) => `${m.is_user ? name1 : name2}: ${(m.mes || "").trim()}`)
        .join("\n");
    if (text.length > maxChars) text = "…\n" + text.slice(-maxChars);
    return text;
}

// ---------------------------------------------------------------------------
// Обновление памяти (deep = ручной прогон с большим окном)
// ---------------------------------------------------------------------------
async function updateMemory(deep = false) {
    const result = { ok: [], fail: [] };
    if (trackerBusy) return result;
    const chat = chatId();
    if (!chat || typeof generateRaw !== "function") { result.fail.push("нет чата или генератора"); return result; }

    trackerBusy = true;
    internalGen = true;
    try {
        const c = cfg();
        const recent = recentDialogue(deep ? c.deepWindow : c.autoWindow);
        const vars = { char: name2, user: name1, recent };

        // дневник — рефлексия (append)
        if (c.diary) try {
            const out = await genMem(renderPrompt(getPrompt("diary"), vars));
            console.log("[Дневник души] Diary сырой ответ:", out);
            const text = cleanReflection(out);
            if (!text) result.fail.push("Дневник: пустой ответ (см. F12)");
            else {
                const saved = await api("append", { chat, date: today(), text });
                if (saved && saved.ok) result.ok.push("Дневник");
                else result.fail.push("Дневник: сервер не сохранил");
            }
        } catch (e) { result.fail.push(`Дневник: ${e?.message || e}`); }

        // трекеры — перезапись
        for (const t of TRACKERS) {
            if (!c[t.key]) continue;
            try {
                const prevRes = await api("get", { chat, name: t.name });
                const prev = (prevRes && prevRes.text) || "";
                const out = await genMem(renderPrompt(getPrompt(t.key), { ...vars, prev }));
                console.log(`[Дневник души] ${t.name} сырой ответ:`, out);
                const text = (out || "").trim();
                if (!text) { result.fail.push(`${DOC_RU[t.key]}: пустой ответ (см. F12)`); continue; }
                const saved = await api("tracker", { chat, name: t.name, text });
                if (saved && saved.ok) result.ok.push(DOC_RU[t.key]);
                else result.fail.push(`${DOC_RU[t.key]}: сервер не сохранил (/tracker?)`);
            } catch (e) { result.fail.push(`${DOC_RU[t.key]}: ${e?.message || e}`); }
        }
    } finally {
        internalGen = false;
        trackerBusy = false;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Стили
// ---------------------------------------------------------------------------
function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const s = document.createElement("style");
    s.textContent = `
        .mm-sd-overlay { position: fixed; inset: 0; z-index: 10050; display: flex;
            align-items: flex-start; justify-content: center; overflow-y: auto;
            padding: 12px; box-sizing: border-box; background: rgba(0,0,0,.5); }
        .mm-sd-box { width: min(680px, 92vw); display: flex; flex-direction: column;
            padding: 14px; border-radius: 12px; background: var(--SmartThemeBlurTintColor, #1e1e2a);
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); }
        .mm-sd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .mm-sd-title { flex: 1; text-align: center; font-weight: 600; }
        .mm-sd-nav, .mm-sd-tr { cursor: pointer; padding: 4px 11px; border-radius: 8px; user-select: none;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); }
        .mm-sd-tr.mm-sd-on { background: var(--SmartThemeQuoteColor, rgba(120,140,255,.35)); }
        .mm-sd-body { max-height: 60vh; overflow-y: auto; white-space: pre-wrap; padding: 10px; border-radius: 8px;
            background: rgba(255,255,255,.05); font-size: .92em; line-height: 1.5; }
        .mm-sd-foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
        .mm-sd-hint { opacity: .6; font-weight: 400; }
        .mm-sd-scroll { max-height: 66vh; overflow-y: auto; padding-right: 4px; }
        .mm-sd-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
        .mm-sd-row input[type=number] { width: 64px; color: var(--SmartThemeBodyColor, #e9e9f2);
            background: var(--black50a, rgba(0,0,0,.35)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.25));
            border-radius: 6px; padding: 3px 6px; }
        .mm-sd-note { font-size: .8em; opacity: .62; margin: -2px 0 9px 2px; line-height: 1.35; }
        .mm-sd-sep { margin: 12px 0 4px; font-weight: 600; opacity: .85;
            border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.12)); padding-top: 8px; }
        .mm-sd-prow { margin: 8px 0; }
        .mm-sd-plabel { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
        .mm-sd-reset { cursor: pointer; font-size: .8em; opacity: .7; text-decoration: underline; }
        .mm-sd-ptext { width: 100%; font-size: .85em; font-family: ui-monospace, monospace; }
        .mm-sd-del { color: var(--warning, #e06c6c); }
        .mm-sd-edit-area { width: 100%; min-height: 300px; font-family: ui-monospace, monospace; font-size: .88em; }
        .mm-sd-editbar { display: flex; gap: 8px; margin-top: 8px; }
    `;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Кнопка 🧠
// ---------------------------------------------------------------------------
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
    btn.style.order = String(wandOrder + 4);
}

// ---------------------------------------------------------------------------
// Окно настроек (⚙)
// ---------------------------------------------------------------------------
function openSettings(afterClose) {
    injectStyles();
    document.getElementById("mm-souldiary-set")?.remove();
    const c = cfg();

    const ov = document.createElement("div");
    ov.id = "mm-souldiary-set";
    ov.className = "mm-sd-overlay";
    ov.innerHTML = `
        <div class="mm-sd-box">
            <div class="mm-sd-title" style="margin-bottom:10px;">🧠 Настройки дневника души</div>
            <div class="mm-sd-scroll">
                <label class="mm-sd-row"><input type="checkbox" data-k="enabled"> Включить всю функцию</label>
                <div class="mm-sd-sep">Что писать</div>
                <label class="mm-sd-row"><input type="checkbox" data-k="diary"> Дневник (рефлексия)</label>
                <label class="mm-sd-row"><input type="checkbox" data-k="psyche"> Эмоции</label>
                <label class="mm-sd-row"><input type="checkbox" data-k="status"> Отношения</label>
                <div class="mm-sd-sep">Когда и сколько</div>
                <label class="mm-sd-row">Обновлять каждые <input type="number" data-n="trackerEvery" min="0" max="100"> ответов</label>
                <div class="mm-sd-note">Как часто персонаж сам обновляет память по ходу чата. <b>0</b> — не обновлять автоматически, только кнопкой «🔄 Обновить сейчас».</div>
                <label class="mm-sd-row">Окно авто-прогона <input type="number" data-n="autoWindow" min="1" max="200"> сообщений</label>
                <div class="mm-sd-note">Сколько последних сообщений берётся при авто-обновлении. Больше — полнее, но дороже по токенам.</div>
                <label class="mm-sd-row">Окно ручного «Обновить» <input type="number" data-n="deepWindow" min="1" max="400"> сообщений</label>
                <div class="mm-sd-note">Сколько последних сообщений берёт кнопка «🔄 Обновить сейчас» — чтобы догнать историю, если включил плагин поздно.</div>
                <div class="mm-sd-sep">Промпты <span class="mm-sd-hint">плейсхолдеры: {{char}} {{user}} {{recent}} {{prev}}</span></div>
                ${["diary", "psyche", "status"].map((k) => `
                    <div class="mm-sd-prow">
                        <div class="mm-sd-plabel"><b>${DOC_RU[k]}</b><span class="mm-sd-reset" data-r="${k}">сброс к дефолту</span></div>
                        <textarea class="text_pole mm-sd-ptext" data-p="${k}" rows="5"></textarea>
                    </div>`).join("")}
                <div class="mm-sd-sep">Файлы</div>
                <div class="menu_button mm-sd-del">🗑 Удалить файлы этого чата (создадутся заново)</div>
            </div>
            <div class="mm-sd-foot"><div class="menu_button mm-sd-setclose" style="margin-left:auto;">Готово</div></div>
        </div>`;
    document.body.appendChild(ov);

    ov.querySelectorAll("[data-k]").forEach((box) => {
        const k = box.dataset.k;
        box.checked = !!c[k];
        box.addEventListener("change", () => { c[k] = box.checked; saveSettingsDebounced(); });
    });
    ov.querySelectorAll("[data-n]").forEach((inp) => {
        const k = inp.dataset.n;
        inp.value = String(c[k]);
        inp.addEventListener("change", () => {
            let v = parseInt(inp.value, 10);
            if (!Number.isFinite(v)) v = 0;
            v = Math.max(Number(inp.min) || 0, Math.min(Number(inp.max) || 9999, v));
            c[k] = v; inp.value = String(v); saveSettingsDebounced();
        });
    });
    ov.querySelectorAll("[data-p]").forEach((ta) => {
        const k = ta.dataset.p;
        ta.value = (c.prompts[k] && c.prompts[k].trim()) ? c.prompts[k] : DEFAULTS[k];
        ta.addEventListener("input", () => {
            c.prompts[k] = (ta.value.trim() === DEFAULTS[k].trim()) ? "" : ta.value;
            saveSettingsDebounced();
        });
    });
    ov.querySelectorAll("[data-r]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const k = btn.dataset.r;
            const ta = ov.querySelector(`[data-p="${k}"]`);
            ta.value = DEFAULTS[k];
            c.prompts[k] = "";
            saveSettingsDebounced();
        });
    });
    ov.querySelector(".mm-sd-del").addEventListener("click", async () => {
        const chat = chatId();
        if (!chat) { if (typeof toastr !== "undefined") toastr.info("Нет активного чата", "Дневник души"); return; }
        if (!confirm("Удалить дневник и трекеры этого чата? Файлы создадутся заново при следующем обновлении.")) return;
        await api("purge", { chat });
        if (typeof toastr !== "undefined") toastr.success("Файлы чата удалены", "Дневник души");
    });

    const close = () => { ov.remove(); if (typeof afterClose === "function") afterClose(); };
    ov.querySelector(".mm-sd-setclose").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
}

// ---------------------------------------------------------------------------
// Листалка доков
// ---------------------------------------------------------------------------
async function openViewer() {
    injectStyles();
    document.getElementById("mm-souldiary-modal")?.remove();

    const chat = chatId();
    let docs = chat ? ((await api("docs", { chat }))?.docs || []) : [];

    const ov = document.createElement("div");
    ov.id = "mm-souldiary-modal";
    ov.className = "mm-sd-overlay";
    ov.innerHTML = `
        <div class="mm-sd-box">
            <div class="mm-sd-head">
                <div class="mm-sd-tr" title="Перевод (Яндекс) — не меняет файл">🌐</div>
                <div class="mm-sd-nav" data-nav="-1">◄</div>
                <div class="mm-sd-title"></div>
                <div class="mm-sd-nav" data-nav="1">►</div>
            </div>
            <div class="mm-sd-body"></div>
            <div class="mm-sd-foot">
                <div class="menu_button mm-sd-run">🔄 Обновить сейчас</div>
                <div class="menu_button mm-sd-edit">✏ Править</div>
                <div class="menu_button mm-sd-settings">⚙ Настройки</div>
                <div class="menu_button mm-sd-close" style="margin-left:auto;">Закрыть</div>
            </div>
        </div>`;
    document.body.appendChild(ov);

    let i = 0;
    let showTr = false;
    const trCache = {};
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
        title.textContent = docs.length ? `${d.name}  (${i + 1}/${docs.length})` : "Пусто";
        if (!d) {
            body.textContent = "Пока ничего не записано. Нажми «Обновить сейчас» или дождись авто-прогона.";
            return;
        }
        if (!showTr) { body.textContent = d.text; return; }
        if (trCache[i] == null) { body.textContent = "Перевод…"; trCache[i] = await yaTranslate(d.text); }
        body.textContent = trCache[i] || d.text;
    }
    async function refreshDocs() {
        docs = chat ? ((await api("docs", { chat }))?.docs || []) : [];
        for (const k in trCache) delete trCache[k];
        if (i >= docs.length) i = 0;
        paint();
    }

    trBtn.addEventListener("click", () => { showTr = !showTr; trBtn.classList.toggle("mm-sd-on", showTr); paint(); });
    ov.querySelectorAll("[data-nav]").forEach((b) =>
        b.addEventListener("click", () => {
            if (!docs.length) return;
            i = (i + Number(b.dataset.nav) + docs.length) % docs.length;
            paint();
        }),
    );

    const runBtn = ov.querySelector(".mm-sd-run");
    runBtn.addEventListener("click", async () => {
        if (!chat || trackerBusy) return;
        const label = runBtn.textContent;
        runBtn.textContent = "Обновляю…";
        try {
            const r = await updateMemory(true);
            await refreshDocs();
            if (typeof toastr !== "undefined") {
                if (r.ok.length) toastr.success("Обновлено: " + r.ok.join(", "), "Дневник души");
                if (r.fail.length) toastr.error(r.fail.join("; ") + " — если про /tracker, перезапусти сервер ST.", "Дневник души", { timeOut: 9000 });
                if (!r.ok.length && !r.fail.length) toastr.info("Нечего обновлять", "Дневник души");
            }
        } finally { runBtn.textContent = label; }
    });

    ov.querySelector(".mm-sd-settings").addEventListener("click", () => openSettings(refreshDocs));

    // правка самой записи (.md) целиком
    async function startEdit() {
        if (!chat || !docs.length) return;
        const d = docs[i];
        showTr = false; trBtn.classList.remove("mm-sd-on");
        body.innerHTML = `<textarea class="text_pole mm-sd-edit-area"></textarea>
            <div class="mm-sd-editbar">
                <div class="menu_button mm-sd-savedoc">💾 Сохранить</div>
                <div class="menu_button mm-sd-canceldoc">Отмена</div>
            </div>`;
        const ta = body.querySelector(".mm-sd-edit-area");
        ta.value = d.text;
        body.querySelector(".mm-sd-canceldoc").addEventListener("click", () => paint());
        body.querySelector(".mm-sd-savedoc").addEventListener("click", async () => {
            const saved = await api("save", { chat, name: d.name, text: ta.value });
            if (saved && saved.ok) {
                d.text = ta.value;
                delete trCache[i];
                if (typeof toastr !== "undefined") toastr.success("Сохранено: " + d.name, "Дневник души");
                paint();
            } else if (typeof toastr !== "undefined") {
                toastr.error("Не сохранилось (сервер?)", "Дневник души");
            }
        });
    }
    ov.querySelector(".mm-sd-edit").addEventListener("click", startEdit);

    const close = () => ov.remove();
    ov.querySelector(".mm-sd-close").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    paint();
}

// ---------------------------------------------------------------------------
// События
// ---------------------------------------------------------------------------
function hookEvents() {
    const es = ctxRef?.eventSource;
    const et = ctxRef?.eventTypes;
    if (!es || !et) return;

    const rendered = et.CHARACTER_MESSAGE_RENDERED || et.MESSAGE_RECEIVED;
    es.on(rendered, async () => {
        if (internalGen || !cfg().enabled) return;
        const chat = chatId();
        if (!chat) return;
        const list = ctxRef?.chat;
        const last = list && list[list.length - 1];
        if (!last || last.is_user || !last.mes) return;
        replyCount++;
        const every = cfg().trackerEvery;
        if (every > 0 && replyCount % every === 0) updateMemory(); // авто, короткое окно
    });

    if (et.GENERATION_STARTED) {
        es.on(et.GENERATION_STARTED, async () => {
            if (internalGen) return;
            if (!cfg().enabled) { setExtensionPrompt(INJECT_KEY, "", 1, 4); return; }
            const chat = chatId();
            const list = ctxRef?.chat || [];
            const lastUser = [...list].reverse().find((m) => m.is_user);
            if (!chat || !lastUser?.mes) { setExtensionPrompt(INJECT_KEY, "", 1, 4); return; }
            const q = await api("query", { chat, query: lastUser.mes, k: 3 });
            const mem = q && q.memory;
            setExtensionPrompt(INJECT_KEY, mem ? `[Из дневника персонажа]\n${mem}` : "", 1, 4);
        });
    }

    const purge = (deletedChat) => { if (deletedChat) api("purge", { chat: deletedChat }); };
    if (et.CHAT_DELETED) es.on(et.CHAT_DELETED, purge);
    if (et.GROUP_CHAT_DELETED) es.on(et.GROUP_CHAT_DELETED, purge);
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------
export function initSoulDiary(ctx) {
    ctxRef = ctx || (typeof SillyTavern !== "undefined" && SillyTavern.getContext ? SillyTavern.getContext() : null);
    injectStyles();
    createButton();
    hookEvents();

    if (ctxRef?.eventSource && ctxRef?.eventTypes?.CHAT_CHANGED) {
        ctxRef.eventSource.on(ctxRef.eventTypes.CHAT_CHANGED, () => {
            createButton();
            try { setExtensionPrompt(INJECT_KEY, "", 1, 4); } catch (e) {} // не тащить память из прошлого чата
            replyCount = 0;
        });
    }
}
