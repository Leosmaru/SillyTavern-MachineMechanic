// ============================================================================
// Механик машин — «Режиссёр» (🎬 director).
//
// Живёт ОТДЕЛЬНОЙ страницей внутри панели 🎯 Целей (Objective): в шапке панели
// есть тумблер вкл/выкл и кнопка-перелистывание «Режиссёр ▸».
//
// Идея (см. концепт): режиссёр РЕШАЕТ (что за событие и как меняется мир),
// память мира лежит в World.md (папка чата плагина soul-md, удаляется вместе с
// чатом), а «труба» — инъекция события в ход персонажа через setExtensionPrompt.
//
// Готово: UI-страница (тумблер + интервал + стиль повествования + редактор
// промпта + чтение/запись World.md) И движок runDirector (раз в N ответов:
// generateRaw → JSON-план → обновление World.md + инъекция события в ход
// персонажа с учётом активной Цели из chat_metadata.objective).
//
// Хранение настроек: extension_settings.STMemoryBooks.mm_director (как у 🧠).
// Мир: POST /api/plugins/soul-md/{save,docs} — серверный код не меняем.
// ============================================================================

import { getRequestHeaders, getCurrentChatId, setExtensionPrompt, saveSettingsDebounced, generateRaw, chat_metadata, substituteParams, eventSource, event_types, name1, name2 } from "../../../../script.js";
import { extension_settings, saveMetadataDebounced } from "../../../extensions.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { mmEnqueue, mmBusy } from "./mmQueue.js";
import { power_user } from "../../../power-user.js";

const API = "/api/plugins/soul-md";
const INJECT_KEY = "MM_DIRECTOR";
const WORLD_DOC = "World";

let ctxRef = null;
let onDirectorPage = false;
let dirBusy = false;      // идёт прогон режиссёра
let dirCounter = 0;       // сколько ответов до следующего прогона
let lastWasSwipe = false; // последнее сообщение — свайп/перегенерация
let pendingEvent = null;  // {text,type} — событие заряжено, инъекция активна
let announceEvent = null; // {text,type} — анонсировано (режим announce), ещё не заряжено
let eventUsed = false;    // pendingEvent уже отыгран свежим ответом (для свайп-фикса и расхода)

const chatId = () => { try { return getCurrentChatId() || ""; } catch (e) { return ""; } };

// Стили повествования (порт из Soul of Waifu). Уходят в промпт режиссёра.
const NARRATOR_STYLES = [
    "Standard evocative present-tense prose",
    "Stephen King (suspenseful, detailed character focus)",
    "H.P. Lovecraft (cosmic dread, archaic and complex vocabulary)",
    "Ernest Hemingway (minimalist, short and punchy sentences, objective)",
    "J.R.R. Tolkien (poetic, high-detailed description of nature and history)",
];

// Определения типов событий (порт таксономии Soul Stage). Редактируются по отдельности,
// подставляются в промпт вместо {{events}}.
const EVENT_KEYS = ["encounter", "discovery", "visitor", "twist", "romance", "advancement", "none"]; // видит модель ({{events}})
const CUSTOM_KEY = "custom";
const FORCE_KEYS = [...EVENT_KEYS.filter((k) => k !== "none"), CUSTOM_KEY]; // кнопки форса (+ custom, без none)
const DEF_KEYS = [...EVENT_KEYS, CUSTOM_KEY];                                // определения + редактор
const DEFAULT_EVENT_DEFS = {
    encounter: "a physical threat/action begins RIGHT NOW: attack, chase, ambush. Not a mere hint of danger.",
    discovery: "the hero learns or finds something NEW that changes their understanding. Not a repeat of known info, not a generic item.",
    visitor:   'someone who was not present a turn ago arrives (a new character/NPC). You MUST fill "npc".',
    twist:     "something previously established is revealed to be false or inverted. Rare, high bar.",
    romance:   "a beat of intimacy, a confession, genuine vulnerability. Not flirty banter.",
    advancement: "a beat that MOVES THE MAIN PLOT forward, chosen to fit THIS character specifically — their backstory, personality, ties and goals (from CHARACTER below, lore and the story so far) and the active GOAL. Not random: a natural next step that develops the character's arc or the central situation.",
    none:      "everything else: calm conversation, atmosphere, routine.",
    custom:    "",
};

// Версия дефолтного промпта/определений. Бампни — и при загрузке форс-сбросит к новым дефолтам.
const PROMPT_VER = 3;

// Ритм событий — меняется ПРЕСЕТОМ. Остальной промпт общий (buildPrompt).
const PACING_BALANCED =
`PACING (important):
- Not every turn is an event. Aim for 1 event per 2-3 calm turns.
- If recent turns were already eventful, return "none" and let the scene breathe. Do not stack encounter->twist->discovery.
- But no dead silence either: if nothing has happened for a while, an event is warranted.
- On "none": leave event_text EMPTY (or one short sensory touch), but still update the world.
- On an event: event_text is a CONCRETE happening in the world (someone entered, a sound, a find, a threat), no character dialogue, 1-2 sentences.`;

const PACING_SHARP =
`PACING (lean toward events):
- Make things happen OFTEN — aim for an event on most turns (~2 of every 3). Prefer a real event over "none".
- Use "none" only when the scene genuinely needs a single beat to breathe.
- Still vary the type — do not repeat the same event_type twice in a row.
- On "none": still update the world (event_text empty or one short touch).
- On an event: event_text is a CONCRETE happening (arrival, sound, find, threat, sudden turn), no character dialogue, 1-2 sentences.`;

// Общее тело промпта (английское — как все промпты плагина). Ритм подставляется пресетом.
function buildPrompt(pacing) {
    return `You are the hidden Director of a solo roleplay between {{user}} and the character {{char}}.
You do NOT write characters' lines. You decide WHAT happens in the world and how it changes.
Take the active GOAL (if any) into account — events should gently steer toward it.
Narration style for event_text: {{style}}.

CURRENT WORLD:
{{world}}

ACTIVE GOAL AND TASKS:
{{objective}}

RECENT MESSAGES:
{{recent}}

CHARACTER {{char}} (card/lore — use especially for "advancement"):
{{char_info}}

EVENT TYPES (pick one for event_type):
{{events}}

${pacing}

Return ONLY one JSON object, no explanations and no code fences:
{
  "event_type": "none|encounter|discovery|visitor|twist|romance",
  "event_text": "<concrete happening; empty on a calm turn>",
  "world_updates": { "location": "", "time": "", "atmosphere": "", "inventory_add": [], "inventory_remove": [], "status_add": [], "status_remove": [], "facts": {} },
  "npc": null
}
An NPC ("visitor") is voiced by the character itself — you only introduce them via event_text and "npc": {"name","archetype","personality"}.`;
}

// Пресеты режиссёра: разный ритм событий. Выбор пресета перезаписывает промпт.
const PRESETS = {
    "Сбалансированный (по умолчанию)": buildPrompt(PACING_BALANCED),
    "Порезче (больше событий)":        buildPrompt(PACING_SHARP),
};
const PRESET_KEYS = Object.keys(PRESETS);
const DEFAULT_PROMPT = PRESETS[PRESET_KEYS[0]];

// ---------------------------------------------------------------------------
// Настройки (как cfg() у 🧠, но своя ветка mm_director)
// ---------------------------------------------------------------------------
function dcfg() {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    const c = s.mm_director || (s.mm_director = {});
    if (typeof c.enabled !== "boolean") c.enabled = false;                       // мастер-выключатель
    if (typeof c.interval !== "number") c.interval = 3;                          // раз в N ответов (0 = выкл)
    if (typeof c.style !== "string") c.style = NARRATOR_STYLES[0];              // стиль повествования
    if (typeof c.depth !== "number") c.depth = 1;                               // глубина инъекции события
    if (typeof c.maxTokens !== "number") c.maxTokens = 1000;                    // свой лимит токенов на ответ режиссёра (мало → обрыв JSON)
    if (c.eventMode !== "now" && c.eventMode !== "announce") c.eventMode = "now"; // показ: now (сразу) | announce (плашка сейчас, событие след. генерацией)
    if (typeof c.hardDirective !== "boolean") c.hardDirective = false;            // жёсткая директива (заставлять модель) — по умолч. ВЫКЛ
    // при апгрейде версии промпта — один раз форс-сброс промпта и определений к новым (английским) дефолтам
    if (c.promptVer !== PROMPT_VER) { c.prompt = DEFAULT_PROMPT; c.eventDefs = { ...DEFAULT_EVENT_DEFS }; c.preset = PRESET_KEYS[0]; c.promptVer = PROMPT_VER; }
    if (typeof c.prompt !== "string" || !c.prompt) c.prompt = DEFAULT_PROMPT;
    if (typeof c.preset !== "string" || !PRESETS[c.preset]) c.preset = PRESET_KEYS[0]; // текущий пресет ритма
    if (typeof c.eventDefs !== "object" || !c.eventDefs) c.eventDefs = {};      // определения типов событий
    for (const k of DEF_KEYS) if (typeof c.eventDefs[k] !== "string") c.eventDefs[k] = DEFAULT_EVENT_DEFS[k];
    return c;
}
function saveCfg() { saveSettingsDebounced(); }

// ---------------------------------------------------------------------------
// Сеть (маленькая копия api() из soulDiary.js — тот наружу её не отдаёт)
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
        console.warn("[Режиссёр] сеть/сервер:", e);
        return null;
    }
}

const stripMd = (n) => String(n || "").replace(/\.md$/i, "");

// Прочитать World.md из папки текущего чата (через /docs — гарантированно работает).
async function worldLoad() {
    const chat = chatId();
    if (!chat) return "";
    const res = await api("docs", { chat });
    const docs = (res && Array.isArray(res.docs)) ? res.docs : [];
    const doc = docs.find((d) => stripMd(d.name).toLowerCase() === WORLD_DOC.toLowerCase());
    return doc ? (doc.text || "") : "";
}

// Записать World.md (перезапись именованного дока — как трекеры 🧠).
// Возвращает {ok, reason} — reason показываем в UI для диагностики.
async function worldSave(text) {
    const chat = chatId();
    if (!chat) return { ok: false, reason: "нет id чата" };
    const res = await api("save", { chat, name: `${WORLD_DOC}.md`, text: String(text || "") });
    console.log("[Режиссёр] /save chat=", chat, "->", res);
    if (res === null) return { ok: false, reason: "сервер soul-md недоступен (enableServerPlugins?)" };
    if (!res.ok) return { ok: false, reason: res.skipped || res.error || "сервер отклонил" };
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Индикатор «режиссёр обновляет мир» (паттерн прогресс-бара 🧠)
// ---------------------------------------------------------------------------
function progBar() {
    let b = document.getElementById("mm-dir-prog");
    if (b) return b;
    b = document.createElement("div");
    b.id = "mm-dir-prog";
    b.className = "mm-soul-prog";           // переиспользуем стиль соул-дневника
    const sf = document.getElementById("send_form");
    if (sf && sf.parentElement) sf.parentElement.insertBefore(b, sf);
    else document.body.appendChild(b);
    return b;
}
function progShow(text) {
    const b = progBar();
    b.style.display = "flex";
    b.innerHTML = `<span class="mm-sp-title">🎬 ${text}</span>`;
}
function progDone() {
    const b = document.getElementById("mm-dir-prog");
    if (!b) return;
    const t = b.querySelector(".mm-sp-title");
    if (t) t.textContent = "🎬 Мир обновлён";
    setTimeout(() => { const x = document.getElementById("mm-dir-prog"); if (x) x.style.display = "none"; }, 2500);
}

// ---------------------------------------------------------------------------
// HTML страницы режиссёра (вставляется в контейнер #mmobj-page-director)
// ---------------------------------------------------------------------------
function pageHtml() {
    const styleOptions = NARRATOR_STYLES
        .map((s) => `<option value="${s.replace(/"/g, "&quot;")}">${s}</option>`)
        .join("");
    const forceButtons = FORCE_KEYS
        .map((k) => { const [lbl] = EVENT_THEME[k] || EVENT_THEME.none; return `<input type="button" class="menu_button mmdir-force" data-ev="${k}" value="${lbl}" />`; })
        .join("");
    return `
    <details class="mmobj-help">
        <summary>Как пользоваться</summary>
        <div>
            Режиссёр — скрытый «мастер сцены». Раз в N ответов он смотрит на разговор,
            обновляет мир (место, время, инвентарь, факты) и по необходимости вбрасывает
            событие, которое персонаж вплетает в свой ответ.
            <ul>
                <li><b>Тумблер 🎬 в шапке</b> — включить/выключить режиссёра (независимо от Целей).</li>
                <li><b>Частота</b> — раз в N ответов запускать режиссёра (0 = выключено).</li>
                <li><b>Стиль повествования</b> — как режиссёр описывает мир и события.</li>
                <li><b>Промпт режиссёра</b> — что именно спрашивать у ИИ (строгий JSON).</li>
                <li><b>Мир (World.md)</b> — текущее состояние мира; хранится в файле этого чата и удаляется вместе с ним.</li>
            </ul>
            <small>🎬 Тумблер в шапке — вкл. «Стригерить событие» — разово гарантированно выдать выбранный тип. Пресет меняет ритм.</small>
        </div>
    </details>

    <div class="objective_block objective_block_control flex1">
        <label for="mmdir-interval">Частота (раз в N ответов)</label>
        <input id="mmdir-interval" class="text_pole widthUnset" type="number" min="0" max="99" />
        <small>(0 = выкл)</small>
    </div>

    <div class="objective_block objective_block_control flex1" style="margin-top:6px;">
        <label for="mmdir-maxtokens">Макс. токенов на ответ режиссёра</label>
        <input id="mmdir-maxtokens" class="text_pole widthUnset" type="number" min="128" max="3000" />
        <small>(мало → «не вернула JSON»; свой, не зависит от основного)</small>
    </div>

    <div class="objective_block objective_block_control flex1 flexFlowColumn" style="margin-top:8px;">
        <label for="mmdir-style">Стиль повествования</label>
        <select id="mmdir-style" class="text_pole">${styleOptions}</select>
    </div>

    <div class="objective_block objective_block_control flex1 flexFlowColumn" style="margin-top:8px;">
        <label for="mmdir-eventmode">Показ события</label>
        <select id="mmdir-eventmode" class="text_pole">
            <option value="now">Настоящее событие (сразу, в сообщении)</option>
            <option value="announce">Анонс (плашка сейчас, событие — следующей генерацией)</option>
        </select>
        <label class="checkbox_label" style="margin-top:6px;"><input id="mmdir-hard" type="checkbox"> Жёсткая директива (заставлять модель отыграть)</label>
    </div>

    <div class="objective_block objective_block_control flex1 flexFlowColumn" style="margin-top:8px;">
        <label for="mmdir-preset">Пресет режиссёра</label>
        <select id="mmdir-preset" class="text_pole"></select>
        <small>Меняет ритм событий. Выбор перезапишет промпт режиссёра.</small>
    </div>

    <div class="objective_block flex-container" style="margin-top:8px;">
        <input id="mmdir-prompt-edit" class="menu_button" type="submit" value="Промпт режиссёра" />
    </div>

    <div class="objective_block flex-container" style="margin-top:8px; flex-wrap:wrap; gap:4px;">
        <small style="width:100%; opacity:.75;">Стригерить событие сейчас (разово, гарантированно, на текущем пресете):</small>
        ${forceButtons}
    </div>

    <hr class="m-t-1 m-b-1">

    <label for="mmdir-world"><small>Мир этого чата (World.md). Читается/пишется на сервере soul-md.</small></label>
    <textarea id="mmdir-world" class="text_pole textarea_compact" rows="8" placeholder="Пока пусто — режиссёр заполнит мир, либо впиши вручную и «Сохранить»."></textarea>
    <div class="objective_block flex-container" style="margin-top:6px;">
        <input id="mmdir-world-load" class="menu_button" type="button" value="Загрузить" />
        <input id="mmdir-world-save" class="menu_button" type="button" value="Сохранить" />
        <input id="mmdir-run" class="menu_button" type="button" value="▶ Запустить сейчас" title="Прогнать режиссёра немедленно (тест, без учёта тумблера/частоты)" />
        <span id="mmdir-world-status" style="opacity:.7; margin-left:6px;"></span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Переключение страниц панели (Цели ↔ Режиссёр)
// ---------------------------------------------------------------------------
function showDirector(on) {
    onDirectorPage = on;
    const objPage = document.getElementById("mmobj-page-objective");
    const dirPage = document.getElementById("mmobj-page-director");
    const title = document.getElementById("mmobj-head-title");
    const flip = document.getElementById("mmdir-flip");
    if (objPage) objPage.style.display = on ? "none" : "";
    if (dirPage) dirPage.style.display = on ? "" : "none";
    if (title) title.textContent = on ? "🎬 Режиссёр" : "🎯 Цели (Objective)";
    if (flip) flip.textContent = on ? "◂ Цели" : "Режиссёр ▸";
    if (on) refreshWorld();
}

async function refreshWorld() {
    const ta = document.getElementById("mmdir-world");
    const st = document.getElementById("mmdir-world-status");
    if (!ta) return;
    if (st) st.textContent = "загрузка…";
    const text = await worldLoad();
    ta.value = text || "";
    if (st) st.textContent = text ? "" : "(мир пуст)";
}

// ---------------------------------------------------------------------------
// Редактор промпта (паттерн onEditPromptClick из objective.js)
// ---------------------------------------------------------------------------
function editPrompt() {
    const c = dcfg();
    const evRows = DEF_KEYS.map((k) => {
        const [label] = EVENT_THEME[k] || EVENT_THEME.none;
        return `<details class="mmobj-help" style="margin-top:6px;">
            <summary>${label} — <code>${k}</code></summary>
            <textarea id="mmdir-def-${k}" class="text_pole textarea_compact" rows="3"${k === CUSTOM_KEY ? ' placeholder="Своё событие: опиши, что должно произойти. Пусто = не используется. Вызывается только кнопкой ✦ СВОЁ."' : ''}></textarea>
            <div class="objective_prompt_block" style="margin-top:4px;">
                <input id="mmdir-def-reset-${k}" class="menu_button" type="submit" value="Сбросить" />
                <input id="mmdir-def-tr-${k}" class="menu_button" type="button" value="🌐 Перевести" />
            </div>
            <div id="mmdir-def-trout-${k}" style="opacity:.8;margin-top:3px;"></div>
        </details>`;
    }).join("");
    const html = `
    <div class="objective_prompt_modal">
        <small>Промпт режиссёра. Плейсхолдеры: {{char}}, {{user}}, {{world}}, {{objective}}, {{recent}}, {{style}}, {{events}}. Модель должна вернуть строго JSON. 🌐 — перевод для чтения (промпт не меняет).</small>
        <hr class="m-t-1 m-b-1">
        <label>Основной промпт</label>
        <textarea id="mmdir-prompt-text" class="text_pole textarea_compact" rows="14"></textarea>
        <div class="objective_prompt_block" style="margin-top:6px;">
            <input id="mmdir-prompt-reset" class="menu_button" type="submit" value="Сбросить основной" />
            <input id="mmdir-prompt-tr" class="menu_button" type="button" value="🌐 Перевести" />
        </div>
        <div id="mmdir-prompt-trout" style="opacity:.8;margin-top:3px;"></div>
        <hr class="m-t-1 m-b-1">
        <label>Типы событий (подставляются в {{events}}) — читать/править каждый</label>
        ${evRows}
    </div>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, "", { allowVerticalScrolling: true, wide: true });

    // 🌐-кнопка: перевести содержимое textarea в отдельный блок (промпт не трогаем)
    const wireTr = (btnId, taId, outId) => $(`#${btnId}`).on("click", async () => {
        const out = document.getElementById(outId);
        if (out) out.textContent = "перевод…";
        const t = await translateRu(String($(`#${taId}`).val() || ""));
        if (out) out.textContent = t ? ("→ " + t) : "не удалось перевести";
    });

    $("#mmdir-prompt-text").val(c.prompt).on("input", () => { dcfg().prompt = String($("#mmdir-prompt-text").val()); saveCfg(); });
    $("#mmdir-prompt-reset").on("click", () => { dcfg().prompt = DEFAULT_PROMPT; saveCfg(); $("#mmdir-prompt-text").val(DEFAULT_PROMPT); });
    wireTr("mmdir-prompt-tr", "mmdir-prompt-text", "mmdir-prompt-trout");

    for (const k of DEF_KEYS) {
        $(`#mmdir-def-${k}`).val(c.eventDefs[k]).on("input", () => { dcfg().eventDefs[k] = String($(`#mmdir-def-${k}`).val()); saveCfg(); });
        $(`#mmdir-def-reset-${k}`).on("click", () => { dcfg().eventDefs[k] = DEFAULT_EVENT_DEFS[k]; saveCfg(); $(`#mmdir-def-${k}`).val(DEFAULT_EVENT_DEFS[k]); });
        wireTr(`mmdir-def-tr-${k}`, `mmdir-def-${k}`, `mmdir-def-trout-${k}`);
    }
}

// ---------------------------------------------------------------------------
// Состояние мира: в World.md лежит читаемый markdown + машинный JSON-комментарий
// ---------------------------------------------------------------------------
function emptyWS() { return { location: "", time: "", atmosphere: "", inventory: [], status: [], facts: {}, npcs: [] }; }

function parseWS(md) {
    const m = String(md || "").match(/<!--\s*MMWORLD\s*([\s\S]*?)-->/);
    if (m) { try { return Object.assign(emptyWS(), JSON.parse(m[1])); } catch (e) {} }
    return emptyWS();
}

function renderWSMd(ws) {
    const l = ["# Мир", ""];
    if (ws.location) l.push(`**Локация:** ${ws.location}`);
    if (ws.time) l.push(`**Время:** ${ws.time}`);
    if (ws.atmosphere) l.push(`**Атмосфера:** ${ws.atmosphere}`);
    if (ws.inventory?.length) l.push(`**Инвентарь:** ${ws.inventory.join(", ")}`);
    if (ws.status?.length) l.push(`**Статус:** ${ws.status.join(", ")}`);
    if (ws.facts && Object.keys(ws.facts).length) { l.push("**Факты:**"); for (const k in ws.facts) l.push(`- ${k}: ${ws.facts[k]}`); }
    if (ws.npcs?.length) { l.push("**NPC:**"); for (const n of ws.npcs) l.push(`- ${n.name}${n.archetype ? ` (${n.archetype})` : ""}: ${n.personality || ""}`); }
    l.push("", `<!-- MMWORLD ${JSON.stringify(ws)} -->`);
    return l.join("\n");
}

function renderWSForPrompt(ws) {
    const l = [];
    if (ws.location) l.push(`Локация: ${ws.location}`);
    if (ws.time) l.push(`Время: ${ws.time}`);
    if (ws.atmosphere) l.push(`Атмосфера: ${ws.atmosphere}`);
    if (ws.inventory?.length) l.push(`Инвентарь: ${ws.inventory.join(", ")}`);
    if (ws.status?.length) l.push(`Статус игрока: ${ws.status.join(", ")}`);
    if (ws.facts && Object.keys(ws.facts).length) l.push("Факты: " + Object.entries(ws.facts).map(([k, v]) => `${k}=${v}`).join("; "));
    if (ws.npcs?.length) l.push("Активные NPC: " + ws.npcs.map((n) => n.name).join(", "));
    return l.join("\n");
}

function applyUpdates(ws, u, npc) {
    u = u || {};
    if (u.location) ws.location = u.location;
    if (u.time) ws.time = u.time;
    if (u.atmosphere) ws.atmosphere = u.atmosphere;
    for (const it of (u.inventory_add || [])) if (it && !ws.inventory.includes(it)) ws.inventory.push(it);
    const rm = new Set(u.inventory_remove || []); if (rm.size) ws.inventory = ws.inventory.filter((i) => !rm.has(i));
    for (const st of (u.status_add || [])) if (st && !ws.status.includes(st)) ws.status.push(st);
    const rs = new Set(u.status_remove || []); if (rs.size) ws.status = ws.status.filter((s) => !rs.has(s));
    if (u.facts && typeof u.facts === "object") Object.assign(ws.facts, u.facts);
    if (npc && npc.name && !ws.npcs.some((n) => n.name === npc.name)) ws.npcs.push({ name: npc.name, archetype: npc.archetype || "", personality: npc.personality || "" });
}

// ---------------------------------------------------------------------------
// Контекст для промпта режиссёра
// ---------------------------------------------------------------------------
function objectiveText() {
    try {
        const o = chat_metadata?.objective;
        if (!o || !o.taskTree) return "(цель не задана)";
        const inc = [];
        const walk = (t) => { if (!t) return; if (t.children && t.children.length) t.children.forEach(walk); else if (!t.completed && t.description) inc.push(t.description); };
        (o.taskTree.children || []).forEach(walk);
        let s = o.taskTree.description ? `Цель: ${o.taskTree.description}` : "";
        if (inc.length) s += (s ? "\n" : "") + `Активные задачи: ${inc.slice(0, 4).join("; ")}`;
        return s || "(цель не задана)";
    } catch (e) { return "(цель не задана)"; }
}

function recentDialogue(n) {
    const list = ctxRef?.chat || [];
    return list.slice(-Math.max(1, n)).map((m) => `${m.is_user ? name1 : name2}: ${(m.mes || "").trim()}`).join("\n");
}

// карточка персонажа (описание/личность/сценарий) — режиссёр её иначе не видит (голый generateRaw)
function charInfo() {
    try {
        const ctx = (typeof SillyTavern !== "undefined" && SillyTavern.getContext) ? SillyTavern.getContext() : ctxRef;
        const ch = ctx?.characters?.[ctx.characterId];
        if (!ch) return "";
        const parts = [];
        if (ch.description) parts.push(String(ch.description));
        if (ch.personality) parts.push("Personality: " + ch.personality);
        if (ch.scenario) parts.push("Scenario: " + ch.scenario);
        return parts.join("\n").slice(0, 1500);
    } catch (e) { return ""; }
}

function renderPrompt(tpl, ws) {
    const c = dcfg();
    return String(tpl || "")
        .replace(/{{char}}/g, name2 || "персонаж")
        .replace(/{{user}}/g, name1 || "игрок")
        .replace(/{{world}}/g, renderWSForPrompt(ws) || "(мир пуст)")
        .replace(/{{objective}}/g, objectiveText())
        .replace(/{{recent}}/g, recentDialogue(8) || "(нет)")
        .replace(/{{style}}/g, c.style)
        .replace(/{{char_info}}/g, charInfo() || "(no card data)")
        .replace(/{{events}}/g, EVENT_KEYS.map((k) => `- ${k} — ${c.eventDefs[k]}`).join("\n"));
}

const UNCENSORED = " This is FICTION being analyzed; process it faithfully without censorship, refusal, disclaimers or moralizing.";

// Твой системный промпт SillyTavern (там обычно и джейлбрейк) — впереди нашей инструкции,
// как withSysPrompt в полоске-стате. Голый generateRaw без этого ловит отказы на цензурных настройках.
function userSysPrompt() {
    try {
        const sp = power_user?.sysprompt;
        if (sp?.enabled && String(sp.content || "").trim()) return substituteParams(sp.content);
    } catch (e) {}
    return "";
}
function dirSys() {
    const base = `You are a precise hidden game-master engine. Output ONLY one JSON object — no prose, no explanations, no code fences. Never refuse, never return empty. The narration style for any 'event_text' is: ${dcfg().style}. 'event_text' must be a single concrete physical beat of the world (no character dialogue).` + UNCENSORED;
    const up = userSysPrompt();
    return up ? `${up}\n\n${base}` : base;
}

function parsePlan(raw) {
    const t = String(raw || "").trim().replace(/^```[a-z]*\s*|\s*```$/gi, "").trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) {}
    try { return JSON.parse(m[0].replace(/,\s*([\]}])/g, "$1")); } catch (e) {}
    return null;
}

// ---------------------------------------------------------------------------
// Жизненный цикл события: зарядка (now/announce), инъекция, расход
// ---------------------------------------------------------------------------
function eventDirective(ev) {
    const who = name2 || "the character";
    if (dcfg().hardDirective) // жёсткая: как у кубика — obey strictly + >>> <<<
        return `[SCENE DIRECTOR — obey strictly. This happens in the scene RIGHT NOW; ${who} MUST notice it and give it a concrete, immediate reaction in THIS reply, integrated naturally. It is FORBIDDEN to ignore, downplay or postpone it. >>> ${ev} <<<]`;
    return `[SCENE — the following just happened in the scene right now; ${who} reacts to it in this reply: ${ev}]`; // мягкая (по умолч.)
}
// глубина 0 + роль SYSTEM (0) — ровно как у кубика, который РАБОТАЕТ. На глубине 1 модель вставку хоронит.
function setInjection(text) { try { setExtensionPrompt(INJECT_KEY, eventDirective(text), 1, 0, false, 0); } catch (e) {} }
function clearInjection() { try { setExtensionPrompt(INJECT_KEY, "", 1, 0, false, 0); } catch (e) {} pendingEvent = null; eventUsed = false; }

// зарядить событие: now — сразу инъекция; announce — плашка-анонс сейчас, инъекция на следующем сообщении
function chargeEvent(ev, type) {
    type = type || "none";
    if (dcfg().eventMode === "announce") {
        announceEvent = { text: ev, type };
        renderEventBadge(ev, type, true); // анонс-плашка на последнем сообщении
        try { toastr.info(ev, "🎬 Анонс — событие в следующей генерации", { timeOut: 6000 }); } catch (e) {}
    } else {
        pendingEvent = { text: ev, type }; eventUsed = false;
        setInjection(ev);
        try { toastr.info(ev, "🎬 Событие — впишется в ответ", { timeOut: 6000 }); } catch (e) {}
    }
}

// ---------------------------------------------------------------------------
// Сам цикл режиссёра: смотрит сцену → обновляет мир + вбрасывает событие
// ---------------------------------------------------------------------------
async function runDirector(forceType = null) {
    if (dirBusy) return;
    const chat = chatId();
    if (!chat || typeof generateRaw !== "function") return;
    dirBusy = true;
    if (mmBusy()) progShow("Режиссёр в очереди…"); // ждём, если дневник/другой прогон уже идёт
    try {
        await mmEnqueue(() => directorPass(forceType)); // очередь пропускает сразу, если никто не занят
    } finally {
        dirBusy = false;
    }
}

async function directorPass(forceType = null) {
    try {
        progShow(forceType ? `Режиссёр: событие «${forceType}»…` : "Режиссёр смотрит на сцену…");
        const ws = parseWS(await worldLoad());
        let prompt = renderPrompt(dcfg().prompt, ws);
        if (forceType === CUSTOM_KEY) {
            const cd = String(dcfg().eventDefs.custom || "").trim();
            prompt += `\n\nMANDATORY THIS TURN: produce an event exactly per this instruction: ${cd || "invent a fitting, plot-relevant event"}. Set "event_type" to "custom" and write a strong concrete event_text. Do NOT return "none".`;
        } else if (forceType) {
            prompt += `\n\nMANDATORY THIS TURN: event_type MUST be "${forceType}". Produce a strong, concrete event_text for it (fill "npc" if visitor). Do NOT return "none".`;
        }
        const raw = await generateRaw({ prompt, systemPrompt: dirSys(), responseLength: dcfg().maxTokens });
        const plan = parsePlan(raw);
        if (plan) {
            applyUpdates(ws, plan.world_updates, plan.npc);
            await worldSave(renderWSMd(ws));
            const ev = String(plan.event_text || "").trim();
            if (ev) {
                chargeEvent(ev, plan.event_type);
            } else {
                try { toastr.info("Спокойный ход, событий нет — мир обновлён", "🎬 Режиссёр", { timeOut: 3000 }); } catch (e) {}
            }
        } else {
            console.warn("[Режиссёр] не смог распарсить JSON:", (raw || "").slice(0, 300));
            try { toastr.warning("Модель не вернула JSON (см. консоль)", "🎬 Режиссёр"); } catch (e) {}
        }
    } catch (e) {
        console.warn("[Режиссёр] runDirector:", e);
    } finally {
        progDone();
    }
}

// перевод текста на русский (тот же серверный переводчик, что у сообщений)
async function translateRu(text) {
    try {
        const r = await fetch("/api/translate/yandex", {
            method: "POST", headers: getRequestHeaders(),
            body: JSON.stringify({ chunks: [text], lang: "ru" }),
        });
        return r.ok ? await r.text() : null;
    } catch (e) { return null; }
}

// цвет/метка плашки по типу события (порт цветных карточек событий Soul Stage)
const EVENT_THEME = {
    encounter: ["⚔ СХВАТКА", "220,60,50"],
    discovery: ["🔎 НАХОДКА", "220,170,40"],
    visitor:   ["🚪 ГОСТЬ", "80,110,230"],
    twist:     ["🌀 ПОВОРОТ", "40,190,200"],
    romance:   ["💗 МОМЕНТ", "220,80,150"],
    advancement: ["➡ ПРОДВИЖЕНИЕ", "110,90,210"],
    none:      ["🎬 событие", "180,80,220"],
    custom:    ["✦ СВОЁ", "150,150,160"],
};

const normEv = (v) => (v && typeof v === "object") ? { text: v.text || "", type: v.type || "none", announce: !!v.announce } : { text: String(v || ""), type: "none", announce: false };

// собрать DOM плашки события (метка по типу + текст + кнопка перевода); announce → «скоро»
function buildEventBadge(text, type, announce) {
    const [label0, rgb] = EVENT_THEME[type] || EVENT_THEME.none;
    const label = announce ? `🎬 скоро — ${label0}` : label0;
    const div = document.createElement("div");
    div.className = "mm-dir-event";
    div.style.cssText = `margin-top:6px;font-size:.85em;opacity:.92;padding:3px 8px;border-radius:8px;background:rgba(${rgb},.15);border:1px solid rgba(${rgb},.4);display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;`;
    const span = document.createElement("span");
    span.textContent = `${label}: ${text}`;
    const tr = document.createElement("span");
    tr.className = "fa-solid fa-language interactable";
    tr.title = "Перевести / вернуть оригинал";
    tr.style.cssText = "cursor:pointer;opacity:.8;";
    let ruCache = null, showingRu = false;
    tr.addEventListener("click", async () => {
        if (showingRu) { span.textContent = `${label}: ${text}`; showingRu = false; return; } // тумблер: назад к оригиналу
        if (ruCache === null) { tr.style.opacity = ".4"; ruCache = await translateRu(text); tr.style.opacity = ".8"; }
        if (ruCache) { span.textContent = `${label}: ${ruCache}`; showingRu = true; }        // замена на месте, не дописываем
    });
    div.appendChild(span); div.appendChild(tr);
    return div;
}

// событие отдельным видимым пузырём в ленте чата (режим eventMode="message"). DOM-only — не в истории и не в модель.
function postEventMessage(text, type) {
    try {
        const chat = document.getElementById("chat");
        if (!chat || !text) return;
        const [label, rgb] = EVENT_THEME[type] || EVENT_THEME.none;
        const wrap = document.createElement("div");
        wrap.className = "mm-dir-event-msg";
        wrap.style.cssText = `margin:8px 10px;padding:8px 12px;border-radius:10px;background:rgba(${rgb},.12);border:1px solid rgba(${rgb},.4);border-left:3px solid rgba(${rgb},.85);`;
        const head = document.createElement("div");
        head.style.cssText = "display:flex;gap:8px;align-items:center;font-weight:600;opacity:.9;margin-bottom:2px;";
        const h = document.createElement("span"); h.textContent = label;
        const tr = document.createElement("span"); tr.className = "fa-solid fa-language interactable"; tr.title = "Перевести / вернуть оригинал"; tr.style.cssText = "cursor:pointer;opacity:.7;margin-left:auto;";
        const body = document.createElement("div"); body.textContent = text;
        let ruCache = null, showingRu = false;
        tr.addEventListener("click", async () => {
            if (showingRu) { body.textContent = text; showingRu = false; return; }
            if (ruCache === null) { tr.style.opacity = ".4"; ruCache = await translateRu(text); tr.style.opacity = ".7"; }
            if (ruCache) { body.textContent = ruCache; showingRu = true; }
        });
        head.appendChild(h); head.appendChild(tr);
        wrap.appendChild(head); wrap.appendChild(body);
        chat.appendChild(wrap);
        wrap.scrollIntoView({ behavior: "smooth", block: "end" });
    } catch (e) {}
}

// повесить плашку под конкретное сообщение
function attachBadge(mes, ev) {
    const { text, type, announce } = normEv(ev);
    if (!mes || !text) return;
    mes.querySelector(".mm-dir-event")?.remove();
    (mes.querySelector(".mes_block") || mes).appendChild(buildEventBadge(text, type, announce));
}

// плашка под последним сообщением + сохранить её в память чата (переживёт перезаход)
function renderEventBadge(text, type, announce) {
    if (!text) return;
    const ev = { text, type: type || "none", announce: !!announce };
    attachBadge([...document.querySelectorAll("#chat .mes")].pop(), ev);
    try {
        const idx = (ctxRef?.chat?.length || 0) - 1;
        if (idx >= 0) {
            chat_metadata.mm_director_events = chat_metadata.mm_director_events || {};
            chat_metadata.mm_director_events[idx] = ev;
            saveMetadataDebounced();
        }
    } catch (e) {}
}

// восстановить сохранённые плашки при заходе в чат
function restoreEventBadges() {
    try {
        const map = chat_metadata?.mm_director_events;
        if (!map) return;
        for (const idx in map) {
            const mes = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (mes) attachBadge(mes, map[idx]);
        }
    } catch (e) {}
}

// раз в N ответов персонажа: сначала снять «прожитое» событие, потом при необходимости запустить режиссёра
function onCharMessage() {
    const c = dcfg();
    // свайп/перегенерация: событие НЕ снимаем (инъекция жива для нового варианта), только перерисуем плашку
    if (lastWasSwipe) { lastWasSwipe = false; if (pendingEvent) renderEventBadge(pendingEvent.text, pendingEvent.type); return; }
    // свежий ответ отыграл заряженное событие → плашка + пометка «использовано» (расход будет при следующем сообщении игрока)
    if (pendingEvent && !eventUsed) { eventUsed = true; renderEventBadge(pendingEvent.text, pendingEvent.type); }
    if (!c.enabled || c.interval <= 0) return;
    let lastType = ""; try { lastType = substituteParams("{{lastGenerationType}}"); } catch (e) {}
    if (["continue", "quiet", "impersonate"].includes(lastType)) return;
    if (--dirCounter <= 0) { dirCounter = c.interval; runDirector(); }
}

// ---------------------------------------------------------------------------
// Точка входа — вызывается из objective.js после построения панели.
// ---------------------------------------------------------------------------
export function initDirector(ctx) {
    ctxRef = ctx || null;
    const c = dcfg();

    // Наполнить контейнер страницы (создан в panelHtml() из objective.js).
    const host = document.getElementById("mmobj-page-director");
    if (host) host.innerHTML = pageHtml();

    // Значения полей из настроек.
    const en = document.getElementById("mmdir-enabled");
    if (en) en.checked = c.enabled;
    const iv = document.getElementById("mmdir-interval");
    if (iv) iv.value = c.interval;
    const stl = document.getElementById("mmdir-style");
    if (stl) stl.value = c.style;
    const mt = document.getElementById("mmdir-maxtokens");
    if (mt) mt.value = c.maxTokens;
    const ps = document.getElementById("mmdir-preset");
    if (ps) { ps.innerHTML = PRESET_KEYS.map((k) => `<option value="${k.replace(/"/g, "&quot;")}">${k}</option>`).join(""); ps.value = c.preset; }
    const em = document.getElementById("mmdir-eventmode");
    if (em) em.value = c.eventMode;
    const hd = document.getElementById("mmdir-hard");
    if (hd) hd.checked = c.hardDirective;

    // Делегированные обработчики (панель строится один раз).
    $(document).off("change.mmdir click.mmdir input.mmdir");
    $(document).on("change.mmdir", "#mmdir-enabled", () => { dcfg().enabled = $("#mmdir-enabled").prop("checked"); dirCounter = dcfg().interval; saveCfg(); });
    $(document).on("click.mmdir", "#mmdir-flip", () => showDirector(!onDirectorPage));
    $(document).on("input.mmdir", "#mmdir-interval", () => { dcfg().interval = Number($("#mmdir-interval").val()) || 0; dirCounter = dcfg().interval; saveCfg(); });
    $(document).on("input.mmdir", "#mmdir-maxtokens", () => { dcfg().maxTokens = Number($("#mmdir-maxtokens").val()) || 1000; saveCfg(); });
    $(document).on("click.mmdir", "#mmdir-run", async () => {
        const st = document.getElementById("mmdir-world-status");
        if (st) st.textContent = "прогон…";
        await runDirector();
        await refreshWorld();
    });
    $(document).on("change.mmdir", "#mmdir-style", () => { dcfg().style = String($("#mmdir-style").val()); saveCfg(); });
    $(document).on("change.mmdir", "#mmdir-preset", () => {
        const key = String($("#mmdir-preset").val());
        if (!PRESETS[key]) return;
        const cc = dcfg(); cc.preset = key; cc.prompt = PRESETS[key]; saveCfg();
        const ta = document.getElementById("mmdir-prompt-text"); if (ta) ta.value = PRESETS[key]; // если редактор открыт
        try { toastr.info("Пресет: " + key, "🎬 Режиссёр"); } catch (e) {}
    });
    $(document).on("click.mmdir", ".mmdir-force", function () { const t = this.getAttribute("data-ev"); if (t) runDirector(t); });
    $(document).on("change.mmdir", "#mmdir-eventmode", () => { dcfg().eventMode = String($("#mmdir-eventmode").val()); saveCfg(); });
    $(document).on("change.mmdir", "#mmdir-hard", () => { dcfg().hardDirective = $("#mmdir-hard").prop("checked"); saveCfg(); });
    $(document).on("click.mmdir", "#mmdir-prompt-edit", editPrompt);
    $(document).on("click.mmdir", "#mmdir-world-load", refreshWorld);
    $(document).on("click.mmdir", "#mmdir-world-save", async () => {
        const st = document.getElementById("mmdir-world-status");
        if (st) st.textContent = "сохранение…";
        const r = await worldSave($("#mmdir-world").val());
        if (st) st.textContent = r.ok ? "сохранено ✅" : ("ошибка: " + r.reason);
    });

    // Событийные хуки (initDirector вызывается один раз из initObjective).
    const es = ctxRef?.eventSource || eventSource;
    const et = ctxRef?.eventTypes || event_types;
    es.on(et.MESSAGE_RECEIVED, onCharMessage);
    es.on(et.MESSAGE_SWIPED, () => { lastWasSwipe = true; });
    es.on(et.MESSAGE_SENT, () => {
        // анонс → заряжаем сейчас (сработает в ближайшем ответе персонажа)
        if (announceEvent) { pendingEvent = announceEvent; eventUsed = false; setInjection(pendingEvent.text); announceEvent = null; return; }
        // событие уже отыграно предыдущим ответом → снимаем перед новой генерацией (свайпы его сохраняли)
        if (pendingEvent && eventUsed) clearInjection();
    });
    es.on(et.CHAT_CHANGED, () => {
        dirCounter = dcfg().interval;
        pendingEvent = null; announceEvent = null; eventUsed = false;
        try { setExtensionPrompt(INJECT_KEY, "", 1, 0, false, 0); } catch (e) {}
        setTimeout(restoreEventBadges, 600);
    });
    dirCounter = c.interval;
    setTimeout(restoreEventBadges, 800);
}
