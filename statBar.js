// ============================================================================
// Механик машин — «Универсальные полоски-статы» (statBar).
//
// САМОСТОЯТЕЛЬНОЕ дополнение. НЕ трогает встроенные сайд-трекеры/сайд-промпты
// плагина и их файлы — это отдельная сущность.
//
// До 4 перенастраиваемых полосок (как HP). Смысл каждой задаёшь промтом:
//   • фикс. часть (формат [[Имя:N|причина]], диапазон, «меняй от прошлого»)
//     — зашита тут и ОДНА на все полоски;
//   • твоя часть (что за стат и как меняется) — своя у каждой полоски.
// Полоска участвует в промте только если у неё стоит галочка: включённые
// собираются в один общий системный промт списком.
// Значение выдаёт модель прямо в ответе (inline): в конце реплики ставит
// [[Имя:N|причина]] — модуль вырезает метки из текста и рисует полоски под
// именем в бабле сообщения, а причину — строкой под полоской.
// ============================================================================

import { saveSettingsDebounced, chat_metadata } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { METADATA_KEY, world_names, loadWorldInfo } from "../../../world-info.js";
// Перевод причин — берём готовый движок плагина (тот же, что у кнопки 🌐 на
// сообщениях), чтобы уважать выбранный профиль подключения и промт перевода.
import { mmTranslateText } from "./index.build.js";

const MODULE = "Механик машин/полоска-стат";
const BTN_ID = "mm-statbar-button";
const INJECT_KEY = "MM_STATBAR";
const BAR_COUNT = 4;
const REASON_WORDS = 8;

let ctxRef = null;
let obs = null;
let obsTimer = null;
let stylesInjected = false;
let pendingNext = {}; // «накрутка»: {имя стата: значение} на следующий ответ (одноразово)

// Готовые примеры (кнопки в попапе подставляют их в поля).
const EXAMPLES = [
    {
        chip: "❤️ Здоровье", name: "Здоровье", min: 0, max: 100,
        meaning: "Physical health of {{char}}. Wounds, hits, exhaustion, hunger and illness lower it; rest, healing, food and sleep raise it. " +
            "Expected behavior: 80-100 — energetic and strong; 40-79 — pain and fatigue show, acts more carefully; 15-39 — weak, moves with difficulty, makes mistakes; 1-14 — on the edge, may lose consciousness; 0 — mortally wounded / unconscious.",
    },
    {
        chip: "😰 Срыв", name: "Срыв", min: 0, max: 100,
        meaning: "Mental stability of {{char}}. Stress, threats, conflict and fear lower it; support, safety, rest and closeness raise it. " +
            "Expected behavior: 80-100 — calm and level-headed; 40-79 — nervous, irritable; 15-39 — panicking, lashing out, tears or aggression; 1-14 — on the verge of a breakdown, poor self-control; 0 — full breakdown, stupor or hysteria.",
    },
    {
        chip: "🤝 Доверие", name: "Доверие", min: 0, max: 100,
        meaning: "How much {{char}} trusts {{user}}. Honesty, help and care raise it; lies, threats and betrayal lower it. " +
            "Expected behavior: 80-100 — open, shares secrets, seeks closeness; 40-79 — friendly but cautious; 15-39 — wary, secretive, tests words; 1-14 — suspicious, snaps, expects a trick; 0 — hostile, rejects contact.",
    },
    {
        chip: "⚡ Энергия", name: "Энергия", min: 0, max: 100,
        meaning: "Stamina of {{char}}. Fights, running, hard work, sleepless nights and heat drain it; sleep, food, drink and calm rest restore it. " +
            "Expected behavior: 80-100 — fresh, ready for anything; 40-79 — tired but holding on; 15-39 — heavy breathing, wants to sit down, sloppy; 1-14 — barely on their feet; 0 — collapses from exhaustion.",
    },
];

// ----------------------------------------------------------------------------
// Настройка (в extension_settings.STMemoryBooks.mm_statBar — своя ветка)
// ----------------------------------------------------------------------------
function defaultBar(i) {
    const ex = EXAMPLES[i] || EXAMPLES[0];
    return { enabled: i === 0, name: ex.name, meaning: ex.meaning, min: ex.min, max: ex.max };
}

function cfg() {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    const c = s.mm_statBar || (s.mm_statBar = { enabled: false, inline: true, onMemory: false });

    // Миграция со старой одиночной полоски (name/meaning/min/max в корне).
    if (!Array.isArray(c.bars)) {
        c.bars = [];
        if (typeof c.name === "string") {
            c.bars.push({ enabled: true, name: c.name, meaning: c.meaning || "", min: c.min ?? 0, max: c.max ?? 100 });
            delete c.name; delete c.meaning; delete c.min; delete c.max;
        }
    }
    while (c.bars.length < BAR_COUNT) c.bars.push(defaultBar(c.bars.length));
    c.bars.length = BAR_COUNT;
    if (typeof c.inline !== "boolean") c.inline = true;
    if (typeof c.onMemory !== "boolean") c.onMemory = false;
    if (typeof c.enabled !== "boolean") c.enabled = false;
    if (typeof c.reason !== "boolean") c.reason = true;
    return c;
}
function saveCfg() { saveSettingsDebounced(); }

// Полоски, участвующие в промте и рендере. Имя — ключ метки, поэтому дубли
// имён отбрасываем: иначе два стата дерутся за одну и ту же метку.
function activeBars(c) {
    const seen = new Set();
    return (c.bars || []).filter((b) => {
        const n = String(b?.name || "").trim();
        if (!b?.enabled || !n || seen.has(n)) return false;
        seen.add(n);
        return true;
    });
}
// Все заданные имена — чтобы вычищать метки даже от выключенных полосок.
function allNames(c) {
    return [...new Set((c.bars || []).map((b) => String(b?.name || "").trim()).filter(Boolean))];
}

// ----------------------------------------------------------------------------
// Вспомогательное
// ----------------------------------------------------------------------------
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

// [[Имя:N]] или [[Имя:N|короткая причина]] — причина необязательна (старый формат).
// Разделитель терпимый: просим «|», но модель любит влепить тире, запятую или
// двоеточие. Дешевле принять их все, чем терять причину из-за пунктуации.
function markerRe(name, g) {
    return new RegExp(
        "\\[\\[\\s*" + escapeRe(name) + "\\s*:\\s*(-?\\d+)\\s*(?:[|,;:\\-–—]\\s*([^\\]]*))?\\]\\]",
        g ? "ig" : "i",
    );
}
function parseMarker(text, name) {
    const m = String(text || "").match(markerRe(name));
    return m ? { val: parseInt(m[1], 10), reason: clipReason(m[2]) } : null;
}
function stripMarkers(text, names) {
    let t = String(text || "");
    for (const n of names) t = t.replace(markerRe(n, true), "");
    return t;
}

// Вычистить метки всех статов из произвольного текста.
// Нужно на выходе в суммаризацию (chatcompile): иначе [[Имя:N|причина]] попадёт
// в текст памяти, осядет в лорбуке и вернётся в контекст протухшим числом.
// Сам чат не трогаем — метки в сообщениях и есть «память» модели о прошлом значении.
export function stripStatMarkers(text) {
    if (!text || !String(text).includes("[[")) return text;
    return stripMarkers(text, allNames(cfg()));
}
function clipReason(s) {
    let t = String(s || "").replace(/[\r\n|\]]+/g, " ").replace(/\s+/g, " ").trim();
    const w = t.split(" ").filter(Boolean);
    if (w.length > REASON_WORDS) t = w.slice(0, REASON_WORDS).join(" ");
    return t.slice(0, 80);
}
function colorFor(pct) {
    // 0% = красный (hue 0), 100% = зелёный (hue 120)
    const hue = Math.round((clamp(pct, 0, 100) / 100) * 120);
    return `hsl(${hue}, 70%, 45%)`;
}

// ----------------------------------------------------------------------------
// Инъекция инструкции модели (inline-режим)
// ----------------------------------------------------------------------------
// Один общий системный промт на ВСЕ включённые полоски:
//   ФИКС. голова + список статов (имя, диапазон, твой промт) + ФИКС. хвост.
// Фикс-часть и примеры — по-английски (надёжнее для модели). Названия статов
// остаются как задал пользователь — обычно русские.
function buildInjectionText(c) {
    const list = activeBars(c);
    if (!list.length) return "";

    const ex = list[0];
    const exVal = Math.round((ex.min + ex.max) / 2);
    // Причину выключили — не просим её вовсе: иначе модель пишет то, что мы
    // всё равно не покажем, за наши же токены.
    // Количество строк называем числом и повторяем в хвосте: модели охотно
    // пишут первую метку и «забывают» остальные, если счёт не задан явно.
    const count = `exactly ${list.length} line${list.length > 1 ? "s" : ""} (one per stat, ALL of them, even if a value did not change)`;
    const head = c.reason === false
        ? `[System instruction] At the very end of your reply, after the scene text, output ${count}, strictly in the format [[Name:N]], where N is an integer within that stat's range. Example of the exact format required: [[${ex.name}:${exVal}]]`
        : `[System instruction] At the very end of your reply, after the scene text, output ${count}, strictly in the format [[Name:N|reason]] — where N is an integer within that stat's range, and reason is a very short phrase (max ${REASON_WORDS} words, in the language of your reply) naming the concrete cause of the change since its previous value. If a value did not change, name what keeps it there. The reason is MANDATORY: never output a bare [[Name:N]] without it. Example of the exact format required: [[${ex.name}:${exVal}|short cause of the change here]]`;

    const stats = list
        .map((b) => `- "${b.name}" (${b.min}-${b.max}): ${String(b.meaning || "").trim()}`)
        .join("\n");

    const tail = `Rules: output all ${list.length} marker${list.length > 1 ? "s" : ""} every time — a missing one is an error. If a stat has no marker earlier in the chat, this is its first one: pick a sensible starting value. Otherwise change each N relative to ITS OWN previous value (the last marker with the same name earlier in the chat); do not reset it to the maximum. Each stat is independent of the others. Do not mention these stats or their numbers anywhere else in the text — only inside these markers.`;

    const forced = list
        .filter((b) => pendingNext[b.name] != null)
        .map((b) => `set "${b.name}" to exactly ${pendingNext[b.name]}`);
    const override = forced.length
        ? `\nManual override for THIS reply only: ${forced.join("; ")}. Reflect these values in the scene, then continue normally afterwards.`
        : "";

    return `${head}\n\nStats:\n${stats}\n\n${tail}${override}`;
}

function updateInjection() {
    const c = cfg();
    const setEP = ctxRef?.setExtensionPrompt || (typeof window !== "undefined" && window.setExtensionPrompt);
    if (typeof setEP !== "function") return;
    try {
        const text = (!c.enabled || !c.inline) ? "" : buildInjectionText(c);
        // position 1 = в чат, depth 0 = в самом конце
        setEP(INJECT_KEY, text, 1, 0, false, 0);
    } catch (e) {
        console.warn(`[${MODULE}] инъекция:`, e);
    }
}

// ----------------------------------------------------------------------------
// Этап 2: пересчёт статов отдельным AI-запросом (по сцене / вручную)
// ----------------------------------------------------------------------------
function resolveLorebookNamePassive() {
    try {
        const s = extension_settings.STMemoryBooks;
        if (s?.moduleSettings?.manualModeEnabled) {
            const manual = chat_metadata?.STMemoryBooks?.manualLorebook ?? null;
            if (manual && Array.isArray(world_names) && world_names.includes(manual)) return manual;
        }
    } catch (e) { /* fallback */ }
    return chat_metadata?.[METADATA_KEY] || null;
}

async function getLatestMemoryRange() {
    const name = resolveLorebookNamePassive();
    if (!name) return null;
    try {
        const data = await loadWorldInfo(name);
        const entries = data && data.entries ? Object.values(data.entries) : [];
        let best = null;
        for (const e of entries) {
            if (e && e.stmemorybooks === true && typeof e.STMB_start === "number" && typeof e.STMB_end === "number") {
                if (!best || e.STMB_end > best.end) best = { start: e.STMB_start, end: e.STMB_end };
            }
        }
        return best;
    } catch (e) {
        console.warn(`[${MODULE}] getLatestMemoryRange:`, e);
        return null;
    }
}

function buildScenePrompt(list, names, startId, endId) {
    const chat = ctxRef?.chat || [];
    const parts = [];
    for (let i = startId; i <= endId; i++) {
        const m = chat[i];
        if (!m) continue;
        const clean = stripMarkers(m.mes, names).trim();
        if (clean) parts.push(`${m.name || (m.is_user ? "User" : "Char")}: ${clean}`);
    }
    let scene = parts.join("\n");
    if (scene.length > 12000) scene = scene.slice(scene.length - 12000);

    const stats = list
        .map((b) => `- "${b.name}" (${b.min}-${b.max}): ${String(b.meaning || "").trim()}`)
        .join("\n");

    const wantReason = cfg().reason !== false;
    return `${scene}\n\n---\nEvaluate the stats below for this scene.\n\nStats:\n${stats}\n\n` +
        `Reply with STRICTLY one line per stat, in the format ${wantReason ? "[[Name:N|reason]]" : "[[Name:N]]"}, ` +
        `where N is an integer within that stat's range` +
        (wantReason ? ` and reason is a very short phrase (max ${REASON_WORDS} words) naming the cause of the change` : "") +
        `. Write nothing else.`;
}

async function computeStats(startId, endId) {
    const c = cfg();
    const list = activeBars(c);
    if (!list.length) return [];
    const gen = ctxRef?.generateRaw;
    if (typeof gen !== "function") {
        try { toastr?.warning?.("generateRaw недоступен в этой версии SillyTavern.", "Полоска-стат"); } catch (e) {}
        return [];
    }
    const prompt = buildScenePrompt(list, allNames(c), startId, endId);
    let resp;
    try {
        resp = await gen({ prompt, responseLength: 24 * list.length + 32, trimNames: true });
    } catch (e) {
        console.warn(`[${MODULE}] computeStats generateRaw:`, e);
        try { toastr?.error?.("Не удалось пересчитать статы (ошибка запроса).", "Полоска-стат"); } catch (er) {}
        return [];
    }

    const out = [];
    for (const b of list) {
        let hit = parseMarker(resp, b.name);
        // Одна полоска и модель ответила голым числом — принимаем.
        if (!hit && list.length === 1) {
            const num = String(resp || "").match(/-?\d+/);
            if (num) hit = { val: parseInt(num[0], 10), reason: "" };
        }
        if (!hit) continue;
        out.push({ name: b.name, val: clamp(hit.val, b.min, b.max), reason: hit.reason });
    }
    return out;
}

// Проставить значения метками в конкретное сообщение (переиспользует рендер).
function setMarkersOnMessage(id, items) {
    const msg = ctxRef?.chat?.[id];
    if (!msg || !items.length) return;
    const names = items.map((i) => i.name);
    const stripped = stripMarkers(msg.mes, names).replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
    const marks = items.map((i) => `[[${i.name}:${i.val}${i.reason ? `|${i.reason}` : ""}]]`).join("\n");
    msg.mes = `${stripped}\n${marks}`;
    try { ctxRef?.saveChat?.(); } catch (e) { /* сохранится при следующем естественном сохранении */ }
}

async function recompute(startId, endId, { silent = false } = {}) {
    const items = await computeStats(startId, endId);
    if (!items.length) return null;
    setMarkersOnMessage(endId, items);
    refreshAll();
    if (!silent) {
        try { toastr?.success?.(items.map((i) => `${i.name}: ${i.val}`).join(", "), "Полоска-стат"); } catch (e) {}
    }
    return items;
}

// Авто-пересчёт при создании памяти.
let onMemBusy = false;
async function runOnMemory() {
    const c = cfg();
    if (!c.enabled || !c.onMemory || onMemBusy) return;
    const list = activeBars(c);
    if (!list.length) return;
    const range = await getLatestMemoryRange();
    if (!range) return;
    const endMsg = ctxRef?.chat?.[range.end];
    if (!endMsg) return;
    // все включённые статы уже отмечены на конце сцены — пропускаем (защита от повтора)
    if (list.every((b) => parseMarker(endMsg.mes, b.name) != null)) return;
    onMemBusy = true;
    try {
        await recompute(range.start, range.end, { silent: true });
    } finally {
        setTimeout(() => { onMemBusy = false; }, 500);
    }
}

// ----------------------------------------------------------------------------
// Рендер полосок в бабле + скрытие меток
// ----------------------------------------------------------------------------
function hideMarkers(el, names) {
    const t = el.querySelector(".mes_text");
    if (!t) return;
    for (const n of names) {
        const re = markerRe(n, true);
        if (re.test(t.innerHTML)) t.innerHTML = t.innerHTML.replace(markerRe(n, true), "");
    }
}
function removeBars(el) {
    el.querySelector(".mm-statbars")?.remove();
}

function renderBars(el, items) {
    const block = el.querySelector(".mes_block") || el;
    let wrap = el.querySelector(".mm-statbars");
    if (!items.length) { wrap?.remove(); return; }
    if (!wrap) {
        wrap = document.createElement("div");
        wrap.className = "mm-statbars";
        wrap.innerHTML =
            `<div class="mm-statbars-list"></div>` +
            `<div class="mm-statbars-tr fa-solid fa-globe interactable" title="Перевести причины" tabindex="0"></div>`;
        wrap.querySelector(".mm-statbars-tr").addEventListener("click", () => translateReasons(wrap));
        const chip = block.querySelector(".stmb_mem_label");
        const text = block.querySelector(".mes_text");
        if (chip && chip.parentElement === block) chip.after(wrap);
        else if (text) block.insertBefore(wrap, text);
        else block.appendChild(wrap);
    }
    const list = wrap.querySelector(".mm-statbars-list");

    // Ищем по dataset, а не селектором: имя стата — произвольный текст.
    const existing = new Map();
    for (const child of [...list.children]) existing.set(child.dataset.stat, child);

    for (const it of items) {
        let bar = existing.get(it.name);
        if (!bar) {
            bar = document.createElement("div");
            bar.className = "mm-statbar";
            bar.dataset.stat = it.name;
            bar.innerHTML =
                `<div class="mm-statbar-row">` +
                `<span class="mm-statbar-name"></span>` +
                `<span class="mm-statbar-track"><span class="mm-statbar-fill"></span></span>` +
                `<span class="mm-statbar-val"></span>` +
                `</div>` +
                `<div class="mm-statbar-reason"></div>`;
        }
        existing.delete(it.name);
        list.appendChild(bar); // перенос уже существующего узла = порядок как в настройке

        const range = (it.max - it.min) || 1;
        const pct = Math.round(((it.val - it.min) / range) * 100);
        bar.querySelector(".mm-statbar-name").textContent = it.name;
        bar.querySelector(".mm-statbar-val").textContent = `${it.val}`;
        const fill = bar.querySelector(".mm-statbar-fill");
        fill.style.width = clamp(pct, 0, 100) + "%";
        fill.style.background = colorFor(pct);

        // Оригинал держим в dataset: наблюдатель перерисовывает полоски часто,
        // и без этого перевод стирался бы через долю секунды после клика.
        bar.dataset.reason = it.reason || "";
        const shown = (bar.dataset.reasonSrc === it.reason && bar.dataset.reasonTr)
            ? bar.dataset.reasonTr
            : it.reason;
        const rs = bar.querySelector(".mm-statbar-reason");
        rs.textContent = shown || "";
        rs.style.display = shown ? "" : "none";
        bar.title = `${it.name}: ${it.val} / ${it.max}${it.reason ? ` — ${it.reason}` : ""}`;
    }
    // Полоски, которых в этом сообщении больше нет (выключили / переименовали).
    for (const stale of existing.values()) stale.remove();

    // Кнопка нужна, только если есть что переводить.
    const any = items.some((i) => i.reason);
    wrap.querySelector(".mm-statbars-tr").style.display = any ? "" : "none";
}

// Перевод причин: каждая — своим коротким запросом (причины по 8 слов, зато
// сопоставление 1:1 гарантировано). Повторный клик возвращает оригинал.
async function translateReasons(wrap) {
    const btn = wrap.querySelector(".mm-statbars-tr");
    if (btn.dataset.busy) return;
    const bars = [...wrap.querySelectorAll(".mm-statbar")].filter((b) => b.dataset.reason);
    if (!bars.length) return;

    if (bars.some((b) => b.dataset.reasonTr)) { // переключатель — вернуть как было
        for (const b of bars) {
            delete b.dataset.reasonTr;
            delete b.dataset.reasonSrc;
            b.querySelector(".mm-statbar-reason").textContent = b.dataset.reason;
        }
        btn.classList.remove("mm-statbars-tr-on");
        return;
    }

    btn.dataset.busy = "1";
    btn.classList.add("mm-statbars-tr-wait");
    try {
        const out = await Promise.all(
            bars.map((b) => mmTranslateText(b.dataset.reason).catch((e) => {
                console.warn(`[${MODULE}] перевод причины:`, e);
                return null;
            })),
        );
        let ok = 0;
        bars.forEach((b, i) => {
            const tr = String(out[i] || "").replace(/\s+/g, " ").trim();
            if (!tr) return;
            b.dataset.reasonSrc = b.dataset.reason;
            b.dataset.reasonTr = tr;
            b.querySelector(".mm-statbar-reason").textContent = tr;
            ok++;
        });
        if (ok) btn.classList.add("mm-statbars-tr-on");
        else try { toastr?.error?.("Не удалось перевести причины.", "Полоска-стат"); } catch (e) {}
    } finally {
        delete btn.dataset.busy;
        btn.classList.remove("mm-statbars-tr-wait");
    }
}

function processMessage(el) {
    const c = cfg();
    const id = parseInt(el.getAttribute("mesid"));
    const msg = ctxRef?.chat?.[id];
    if (!msg) return;

    // Метки прячем ВСЕГДА, даже когда модуль выключен: это служебный мусор,
    // и в старых сообщениях он иначе вылезает голым в текст реплики.
    hideMarkers(el, allNames(c));

    if (!c.enabled) { removeBars(el); return; }

    const items = [];
    for (const b of activeBars(c)) {
        const hit = parseMarker(msg.mes, b.name);
        if (!hit) continue;
        items.push({
            name: b.name,
            val: clamp(hit.val, b.min, b.max),
            reason: c.reason === false ? "" : hit.reason,
            min: b.min,
            max: b.max,
        });
    }
    renderBars(el, items);
}

function refreshAll() {
    document.querySelectorAll("#chat .mes[mesid]").forEach(processMessage);
}

// ----------------------------------------------------------------------------
// Наблюдатель за чатом
// ----------------------------------------------------------------------------
function startChatObserver() {
    const chat = document.getElementById("chat");
    if (!chat || obs) return;
    obs = new MutationObserver(() => {
        clearTimeout(obsTimer);
        obsTimer = setTimeout(refreshAll, 150);
    });
    obs.observe(chat, { childList: true, subtree: true });
}

// ----------------------------------------------------------------------------
// Кнопка 📊 + попап настройки
// ----------------------------------------------------------------------------
function createButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.className = "fa-solid fa-chart-simple interactable";
    btn.title = "Полоски-статы (настройка)";
    btn.tabIndex = 0;
    btn.addEventListener("click", openModal);

    const toc = document.getElementById("mm-toc-button");
    const wrench = document.getElementById("mm-wand-button");
    const wand = document.getElementById("extensionsMenuButton");
    if (toc) toc.after(btn);
    else if (wrench) wrench.after(btn);
    else document.getElementById("leftSendForm")?.appendChild(btn);

    const wandOrder = wand ? (parseInt(getComputedStyle(wand).order, 10) || 4) : 4;
    btn.style.order = String(wandOrder + 3);
}

function barCardHtml(i) {
    const chips = EXAMPLES.map((e, k) => `<span class="mm-sb-ex" data-ex="${k}">${e.chip}</span>`).join(" ");
    return `
      <div class="mm-sb-card" data-i="${i}">
        <div class="mm-sb-cardhead">
          <label class="mm-sb-row mm-sb-cardtitle">
            <input type="checkbox" class="mm-sb-on">
            <b class="mm-sb-cardname">Полоска ${i + 1}</b>
          </label>
          <div class="mm-sb-fold fa-solid fa-chevron-down interactable" title="Свернуть / развернуть" tabindex="0"></div>
        </div>
        <div class="mm-sb-body">
          <label class="mm-sb-lbl">Название стата</label>
          <input type="text" class="text_pole mm-sb-name" placeholder="HP / Нервный срыв / Доверие">
          <label class="mm-sb-lbl">📝 Промт этого стата — что это и как меняется</label>
          <textarea class="text_pole mm-sb-meaning" rows="3" placeholder="e.g.: Physical health. Wounds and fatigue lower it, rest and healing raise it. (English works best for the model)"></textarea>
          <div class="mm-sb-examples">Примеры: ${chips}</div>
          <div class="mm-sb-range">
            <label class="mm-sb-lbl">Мин</label><input type="number" class="text_pole mm-sb-min">
            <label class="mm-sb-lbl">Макс</label><input type="number" class="text_pole mm-sb-max">
          </div>
          <div class="mm-sb-next">
            <label class="mm-sb-lbl" style="margin:0;flex:1">↯ Накрутить на следующий ответ:</label>
            <input type="number" class="text_pole mm-sb-nextval" style="width:74px" placeholder="напр. 30">
          </div>
        </div>
      </div>`;
}

function openModal() {
    document.getElementById("mm-statbar-modal")?.remove();
    const c = cfg();
    const ov = document.createElement("div");
    ov.id = "mm-statbar-modal";
    ov.innerHTML = `
      <div class="mm-sb-box">
        <div class="mm-sb-head">
          <div class="mm-sb-title"><i class="fa-solid fa-chart-simple"></i> Полоски-статы</div>
          <div class="mm-sb-close fa-solid fa-xmark interactable" title="Закрыть" tabindex="0"></div>
        </div>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-enabled"> <span>Включить полоски</span></label>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-reason"> <span>Причина изменения (строчкой под полоской)</span></label>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-inline"> <span>Модель заполняет сама (в каждом ответе)</span></label>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-onmem"> <span>Пересчитывать на создании памяти (отдельный AI-запрос по сцене)</span></label>
        <div class="mm-sb-cards">${Array.from({ length: BAR_COUNT }, (_, i) => barCardHtml(i)).join("")}</div>
        <label class="mm-sb-lbl">👁 Общий промт модели (фикс. часть + все включённые полоски, только чтение)</label>
        <textarea id="mm-sb-preview" class="text_pole" rows="7" readonly></textarea>
        <div class="mm-sb-hint">Системный промт <b>один на все полоски</b>: формат <code>[[Имя:N|причина]]</code>, диапазоны и «меняй от прошлого» модуль добавляет сам, а включённые галочкой полоски дописывает списком — имя, диапазон, твоё описание. Причина (до ${REASON_WORDS} слов) рисуется строкой под полоской. «Накрутка» разово задаёт значение на следующий ответ ИИ.</div>
        <div class="mm-sb-actions">
          <div class="menu_button mm-sb-next-apply" title="Разово задать значения из полей «Накрутить»">↯ Применить накрутку</div>
          <div class="menu_button mm-sb-recompute" title="Посчитать статы по последней сцене прямо сейчас">↻ Пересчитать сейчас</div>
          <div class="menu_button mm-sb-save">Сохранить</div>
          <div class="menu_button mm-sb-cancel">Отмена</div>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.querySelector("#mm-sb-enabled").checked = !!c.enabled;
    ov.querySelector("#mm-sb-reason").checked = c.reason !== false;
    ov.querySelector("#mm-sb-inline").checked = !!c.inline;
    ov.querySelector("#mm-sb-onmem").checked = !!c.onMemory;

    const cards = [...ov.querySelectorAll(".mm-sb-card")];
    const field = (card, sel) => card.querySelector(sel);

    cards.forEach((card, i) => {
        const b = c.bars[i];
        field(card, ".mm-sb-on").checked = !!b.enabled;
        field(card, ".mm-sb-name").value = b.name;
        field(card, ".mm-sb-meaning").value = b.meaning;
        field(card, ".mm-sb-min").value = b.min;
        field(card, ".mm-sb-max").value = b.max;
        field(card, ".mm-sb-cardname").textContent = b.name || `Полоска ${i + 1}`;
        card.classList.toggle("mm-sb-collapsed", !b.enabled); // выключенные свёрнуты
    });

    // Считать поля окна в объект (без записи в настройку) — для превью.
    const readBar = (card, i) => ({
        enabled: field(card, ".mm-sb-on").checked,
        name: (field(card, ".mm-sb-name").value || "").trim() || `Стат ${i + 1}`,
        meaning: field(card, ".mm-sb-meaning").value || "",
        min: Number.isFinite(parseInt(field(card, ".mm-sb-min").value, 10)) ? parseInt(field(card, ".mm-sb-min").value, 10) : 0,
        max: Number.isFinite(parseInt(field(card, ".mm-sb-max").value, 10)) ? parseInt(field(card, ".mm-sb-max").value, 10) : 100,
    });

    // Живой предпросмотр общего промта.
    const updatePreview = () => {
        const pv = ov.querySelector("#mm-sb-preview");
        if (!pv) return;
        const draft = { bars: cards.map(readBar), reason: ov.querySelector("#mm-sb-reason").checked };
        pv.value = buildInjectionText(draft) || "(ни одна полоска не включена — промт не добавляется)";
    };
    ov.querySelector("#mm-sb-reason").addEventListener("change", updatePreview);

    cards.forEach((card, i) => {
        card.addEventListener("input", () => {
            field(card, ".mm-sb-cardname").textContent = (field(card, ".mm-sb-name").value || "").trim() || `Полоска ${i + 1}`;
            updatePreview();
        });
        field(card, ".mm-sb-on").addEventListener("change", (e) => {
            if (e.target.checked) card.classList.remove("mm-sb-collapsed");
            updatePreview();
        });
        field(card, ".mm-sb-fold").addEventListener("click", () => card.classList.toggle("mm-sb-collapsed"));
        // Кнопки-примеры: подставляют готовый промт в поля этой карточки (без сохранения).
        card.querySelectorAll(".mm-sb-ex").forEach((chip) => {
            chip.addEventListener("click", () => {
                const ex = EXAMPLES[parseInt(chip.dataset.ex, 10)];
                if (!ex) return;
                field(card, ".mm-sb-name").value = ex.name;
                field(card, ".mm-sb-meaning").value = ex.meaning;
                field(card, ".mm-sb-min").value = ex.min;
                field(card, ".mm-sb-max").value = ex.max;
                field(card, ".mm-sb-on").checked = true;
                field(card, ".mm-sb-cardname").textContent = ex.name;
                card.classList.remove("mm-sb-collapsed");
                updatePreview();
            });
        });
    });
    updatePreview();

    const close = () => ov.remove();
    ov.querySelector(".mm-sb-close").addEventListener("click", close);
    ov.querySelector(".mm-sb-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

    // Считать поля окна в настройку (без закрытия).
    const commitFields = () => {
        c.enabled = ov.querySelector("#mm-sb-enabled").checked;
        c.reason = ov.querySelector("#mm-sb-reason").checked;
        c.inline = ov.querySelector("#mm-sb-inline").checked;
        c.onMemory = ov.querySelector("#mm-sb-onmem").checked;
        cards.forEach((card, i) => {
            const draft = readBar(card, i);
            if (draft.max <= draft.min) draft.max = draft.min + 1;
            c.bars[i] = draft;
        });
        saveCfg();
    };

    ov.querySelector(".mm-sb-save").addEventListener("click", () => {
        commitFields();
        updateInjection();
        refreshAll();
        close();
        const on = activeBars(c).map((b) => b.name).join(", ");
        try {
            toastr?.success?.(c.enabled && on ? `Включено: ${on}` : "Полоски выключены.", "Полоска-стат");
        } catch (e) {}
    });

    // Пересчитать сейчас — по последней сцене (диапазону памяти) или последним сообщениям.
    ov.querySelector(".mm-sb-recompute").addEventListener("click", async () => {
        commitFields();
        if (!activeBars(c).length) { try { toastr?.info?.("Включи хотя бы одну полоску.", "Полоска-стат"); } catch (e) {} return; }
        const btn = ov.querySelector(".mm-sb-recompute");
        const old = btn.textContent; btn.textContent = "⏳ Считаю…";
        try {
            let range = await getLatestMemoryRange();
            if (!range) {
                const last = (ctxRef?.chat?.length || 0) - 1;
                if (last < 0) { toastr?.info?.("Нет сообщений для расчёта.", "Полоска-стат"); return; }
                range = { start: Math.max(0, last - 20), end: last };
            }
            await recompute(range.start, range.end);
        } catch (e) {
            console.warn(`[${MODULE}] recompute button:`, e);
        } finally {
            btn.textContent = old;
        }
    });

    // Накрутка: разово задать значения на следующий ответ ИИ.
    ov.querySelector(".mm-sb-next-apply").addEventListener("click", () => {
        commitFields();
        const items = [];
        cards.forEach((card, i) => {
            const b = c.bars[i];
            const raw = parseInt(field(card, ".mm-sb-nextval").value, 10);
            if (!b.enabled || !Number.isFinite(raw)) return;
            const val = clamp(raw, b.min, b.max);
            pendingNext[b.name] = val;
            items.push({ name: b.name, val, reason: "ручная накрутка" });
        });
        if (!items.length) { try { toastr?.info?.("Введи число хотя бы у одной включённой полоски.", "Полоска-стат"); } catch (e) {} return; }
        c.enabled = true; ov.querySelector("#mm-sb-enabled").checked = true; saveCfg();
        updateInjection();
        // мгновенно показать на последнем сообщении
        const lastId = (ctxRef?.chat?.length || 0) - 1;
        if (lastId >= 0) { setMarkersOnMessage(lastId, items); refreshAll(); }
        try { toastr?.success?.(`Следующий ответ: ${items.map((i) => `${i.name} = ${i.val}`).join(", ")}`, "Полоска-стат"); } catch (e) {}
    });
}

// ----------------------------------------------------------------------------
// Стили
// ----------------------------------------------------------------------------
function injectStyles() {
    if (stylesInjected || document.getElementById("mm-statbar-style")) { stylesInjected = true; return; }
    const s = document.createElement("style");
    s.id = "mm-statbar-style";
    s.textContent = `
      .mm-statbars { display: flex; align-items: flex-start; gap: 6px; width: fit-content; max-width: 100%; margin: 3px 0 6px; }
      .mm-statbars-list { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .mm-statbars-tr {
        cursor: pointer; opacity: .45; font-size: .78em; padding: 4px 5px;
        border-radius: 6px; align-self: center; flex: none;
      }
      .mm-statbars-tr:hover { opacity: 1; background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent); }
      .mm-statbars-tr-on { opacity: 1; color: var(--SmartThemeQuoteColor); }
      .mm-statbars-tr-wait { opacity: 1; animation: mm-statbars-spin 1s linear infinite; }
      @keyframes mm-statbars-spin { to { transform: rotate(360deg); } }
      .mm-statbar {
        display: flex; flex-direction: column; gap: 1px;
        padding: 3px 8px;
        border-radius: 10px; font-size: 0.78em;
        background: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
        border: 1px solid var(--SmartThemeBorderColor);
      }
      .mm-statbar-row { display: flex; align-items: center; gap: 8px; }
      .mm-statbar-name { font-weight: 700; opacity: 0.9; }
      .mm-statbar-track {
        position: relative; width: 120px; max-width: 40vw; height: 8px;
        border-radius: 999px; overflow: hidden;
        background: color-mix(in srgb, var(--SmartThemeBodyColor) 20%, transparent);
      }
      .mm-statbar-fill { display:block; height: 100%; border-radius: 999px; transition: width .3s ease, background .3s ease; }
      .mm-statbar-val { font-variant-numeric: tabular-nums; opacity: 0.8; min-width: 2ch; text-align: right; }
      .mm-statbar-reason {
        font-size: .92em; font-style: italic; opacity: .6; line-height: 1.3;
        max-width: min(420px, 60vw); overflow-wrap: anywhere;
      }

      /* Размеры во vh/vw — они всегда от вьюпорта, даже если предок с transform
         делает контейнер нулевой высоты. Центрируем флексом. */
      #mm-statbar-modal {
        position: fixed; top: 0; left: 0;
        width: 100vw; height: 100vh;
        z-index: 10060;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.5);
      }
      #mm-statbar-modal .mm-sb-box {
        width: min(460px, 92vw); max-height: 88vh; overflow-y: auto;
        background: var(--SmartThemeBlurTintColor); color: var(--SmartThemeBodyColor);
        border: 1px solid var(--SmartThemeBorderColor); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5); padding: 14px 16px;
        display: flex; flex-direction: column; gap: 8px;
      }
      #mm-statbar-modal .mm-sb-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
      #mm-statbar-modal .mm-sb-title { font-weight:700; display:flex; align-items:center; gap:8px; }
      #mm-statbar-modal .mm-sb-title i { color: var(--SmartThemeQuoteColor); }
      #mm-statbar-modal .mm-sb-close { cursor:pointer; opacity:.7; padding:4px 6px; border-radius:6px; }
      #mm-statbar-modal .mm-sb-close:hover { opacity:1; background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent); }
      #mm-statbar-modal .mm-sb-lbl { font-size:.82em; opacity:.75; margin-top:4px; }
      #mm-statbar-modal .mm-sb-row { display:flex; align-items:center; gap:8px; cursor:pointer; margin:2px 0; }
      #mm-statbar-modal .mm-sb-range { display:grid; grid-template-columns:auto 1fr auto 1fr; align-items:center; gap:6px; }
      #mm-statbar-modal .mm-sb-next { display:flex; align-items:center; gap:6px; margin:2px 0; }
      #mm-statbar-modal textarea, #mm-statbar-modal input[type="text"], #mm-statbar-modal input[type="number"] { width:100%; box-sizing:border-box; }
      #mm-statbar-modal .mm-sb-examples { font-size:.8em; opacity:.85; margin:2px 0; display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
      #mm-statbar-modal .mm-sb-ex {
        cursor:pointer; padding:2px 8px; border-radius:999px;
        border:1px solid var(--SmartThemeBorderColor);
        background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, transparent);
      }
      #mm-statbar-modal .mm-sb-ex:hover { background: color-mix(in srgb, var(--SmartThemeQuoteColor) 28%, transparent); }
      #mm-statbar-modal .mm-sb-hint { font-size:.78em; opacity:.65; line-height:1.35; margin-top:2px; }
      #mm-statbar-modal .mm-sb-hint code { background: color-mix(in srgb, var(--SmartThemeBodyColor) 15%, transparent); padding:0 4px; border-radius:4px; }
      #mm-statbar-modal .mm-sb-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:8px; }
      #mm-statbar-modal .mm-sb-actions .menu_button { width:auto; white-space:nowrap; }

      #mm-statbar-modal .mm-sb-cards { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
      #mm-statbar-modal .mm-sb-card {
        border:1px solid var(--SmartThemeBorderColor); border-radius:10px; padding:6px 10px;
        background: color-mix(in srgb, var(--SmartThemeBodyColor) 5%, transparent);
      }
      #mm-statbar-modal .mm-sb-cardhead { display:flex; align-items:center; gap:8px; }
      #mm-statbar-modal .mm-sb-cardtitle { flex:1; margin:0; }
      #mm-statbar-modal .mm-sb-fold { cursor:pointer; opacity:.6; padding:4px 6px; transition: transform .2s ease; }
      #mm-statbar-modal .mm-sb-fold:hover { opacity:1; }
      #mm-statbar-modal .mm-sb-body { display:flex; flex-direction:column; gap:2px; }
      #mm-statbar-modal .mm-sb-collapsed .mm-sb-body { display:none; }
      #mm-statbar-modal .mm-sb-collapsed .mm-sb-fold { transform: rotate(-90deg); }
      #mm-statbar-modal .mm-sb-collapsed .mm-sb-cardname { opacity:.6; }
    `;
    document.head.appendChild(s);
    stylesInjected = true;
}

// ----------------------------------------------------------------------------
// Точка входа
// ----------------------------------------------------------------------------
export function initStatBar(ctx) {
    ctxRef = ctx || (typeof SillyTavern !== "undefined" && SillyTavern.getContext ? SillyTavern.getContext() : null);
    injectStyles();
    createButton();
    startChatObserver();
    updateInjection();
    setTimeout(refreshAll, 800);

    if (ctxRef?.eventSource && ctxRef?.eventTypes?.CHAT_CHANGED) {
        ctxRef.eventSource.on(ctxRef.eventTypes.CHAT_CHANGED, () => {
            createButton();
            updateInjection();
            setTimeout(refreshAll, 600);
        });
    }

    // Этап 2: авто-пересчёт при создании памяти (ловим сохранение лорбука).
    if (ctxRef?.eventSource && ctxRef?.eventTypes?.WORLDINFO_UPDATED) {
        let wiTimer = null;
        ctxRef.eventSource.on(ctxRef.eventTypes.WORLDINFO_UPDATED, () => {
            clearTimeout(wiTimer);
            wiTimer = setTimeout(() => { runOnMemory().catch(() => {}); }, 500);
        });
    }

    // «Накрутка» одноразовая: после ответа ИИ сбрасываем форс-значения.
    if (ctxRef?.eventSource && ctxRef?.eventTypes?.MESSAGE_RECEIVED) {
        ctxRef.eventSource.on(ctxRef.eventTypes.MESSAGE_RECEIVED, () => {
            if (Object.keys(pendingNext).length) { pendingNext = {}; updateInjection(); }
        });
    }
}
