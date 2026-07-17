// ============================================================================
// Механик машин — «Универсальная полоска-стат» (statBar).
//
// САМОСТОЯТЕЛЬНОЕ дополнение. НЕ трогает встроенные сайд-трекеры/сайд-промпты
// плагина и их файлы — это отдельная сущность.
//
// Одна перенастраиваемая полоска (как HP). Смысл задаёшь промтом:
//   • фикс. часть (формат [[Имя:N]], 0–100, «меняй от прошлого») — зашита тут;
//   • твоя часть (что за стат и как меняется) — пишешь в настройке.
// Значение выдаёт модель прямо в ответе (inline): в конце реплики ставит
// [[Имя:N]] — модуль вырезает метку из текста и рисует полоску под именем
// в бабле сообщения. (Этап 2 — пересчёт на создании памяти — добавится позже.)
// ============================================================================

import { saveSettingsDebounced, chat_metadata } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { METADATA_KEY, world_names, loadWorldInfo } from "../../../world-info.js";

const MODULE = "Механик машин/полоска-стат";
const BTN_ID = "mm-statbar-button";
const INJECT_KEY = "MM_STATBAR";

let ctxRef = null;
let obs = null;
let obsTimer = null;
let stylesInjected = false;

// ----------------------------------------------------------------------------
// Настройка (в extension_settings.STMemoryBooks.mm_statBar — своя ветка)
// ----------------------------------------------------------------------------
function cfg() {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    if (!s.mm_statBar) {
        s.mm_statBar = {
            enabled: false,
            name: "HP",
            meaning: "Физическое состояние персонажа. Раны, усталость, голод — снижают. Отдых, лечение, еда — повышают.",
            min: 0,
            max: 100,
            inline: true,
            onMemory: false,
        };
    }
    return s.mm_statBar;
}
function saveCfg() { saveSettingsDebounced(); }

// ----------------------------------------------------------------------------
// Вспомогательное
// ----------------------------------------------------------------------------
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function markerRe(name, g) {
    return new RegExp("\\[\\[\\s*" + escapeRe(name) + "\\s*:\\s*(-?\\d+)\\s*\\]\\]", g ? "ig" : "i");
}
function parseValue(text, name) {
    const m = String(text || "").match(markerRe(name));
    return m ? parseInt(m[1], 10) : null;
}
function colorFor(pct) {
    // 0% = красный (hue 0), 100% = зелёный (hue 120)
    const hue = Math.round((clamp(pct, 0, 100) / 100) * 120);
    return `hsl(${hue}, 70%, 45%)`;
}

// ----------------------------------------------------------------------------
// Инъекция инструкции модели (inline-режим)
// ----------------------------------------------------------------------------
function updateInjection() {
    const c = cfg();
    const setEP = ctxRef?.setExtensionPrompt || (typeof window !== "undefined" && window.setExtensionPrompt);
    if (typeof setEP !== "function") return;
    try {
        if (!c.enabled || !c.inline) { setEP(INJECT_KEY, ""); return; }
        const text =
            `[Служебное правило интерфейса] В самом конце ответа, отдельной строкой, выведи текущий показатель «${c.name}» строго в формате [[${c.name}:N]], где N — целое число от ${c.min} до ${c.max}. ` +
            `${c.meaning} ` +
            `Меняй N относительно предыдущего значения (последняя такая метка выше по чату), не сбрасывай к максимуму. Кроме этой одной метки, нигде в тексте про показатель не пиши.`;
        // position 1 = в чат, depth 0 = в самом конце
        setEP(INJECT_KEY, text, 1, 0, false, 0);
    } catch (e) {
        console.warn(`[${MODULE}] инъекция:`, e);
    }
}

// ----------------------------------------------------------------------------
// Этап 2: пересчёт стата отдельным AI-запросом (по сцене / вручную)
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

function buildScenePrompt(startId, endId) {
    const c = cfg();
    const chat = ctxRef?.chat || [];
    const parts = [];
    for (let i = startId; i <= endId; i++) {
        const m = chat[i];
        if (!m) continue;
        const clean = String(m.mes || "").replace(markerRe(c.name, true), "").trim();
        if (clean) parts.push(`${m.name || (m.is_user ? "User" : "Char")}: ${clean}`);
    }
    let scene = parts.join("\n");
    if (scene.length > 12000) scene = scene.slice(scene.length - 12000);
    return `${scene}\n\n---\nОцени показатель «${c.name}» по этой сцене. ${c.meaning} ` +
        `Ответь СТРОГО одной строкой в формате [[${c.name}:N]], где N — целое число от ${c.min} до ${c.max}. Больше ничего не пиши.`;
}

async function computeStat(startId, endId) {
    const c = cfg();
    const gen = ctxRef?.generateRaw;
    if (typeof gen !== "function") {
        try { toastr?.warning?.("generateRaw недоступен в этой версии SillyTavern.", "Полоска-стат"); } catch (e) {}
        return null;
    }
    const prompt = buildScenePrompt(startId, endId);
    let resp;
    try {
        resp = await gen({ prompt, responseLength: 24, trimNames: true });
    } catch (e) {
        console.warn(`[${MODULE}] computeStat generateRaw:`, e);
        try { toastr?.error?.("Не удалось пересчитать стат (ошибка запроса).", "Полоска-стат"); } catch (er) {}
        return null;
    }
    let val = parseValue(resp, c.name);
    if (val == null) {
        const num = String(resp || "").match(/-?\d+/);
        val = num ? parseInt(num[0], 10) : null;
    }
    return val == null ? null : clamp(val, c.min, c.max);
}

// Проставить значение как метку в конкретное сообщение (переиспользует рендер).
function setMarkerOnMessage(id, name, val) {
    const msg = ctxRef?.chat?.[id];
    if (!msg) return;
    const stripped = String(msg.mes || "").replace(markerRe(name, true), "").replace(/\s+$/, "");
    msg.mes = `${stripped} [[${name}:${val}]]`;
    try { ctxRef?.saveChat?.(); } catch (e) { /* сохранится при следующем естественном сохранении */ }
}

async function recompute(startId, endId, { silent = false } = {}) {
    const val = await computeStat(startId, endId);
    if (val == null) return null;
    setMarkerOnMessage(endId, cfg().name, val);
    refreshAll();
    if (!silent) { try { toastr?.success?.(`${cfg().name}: ${val}`, "Полоска-стат"); } catch (e) {} }
    return val;
}

// Авто-пересчёт при создании памяти.
let onMemBusy = false;
async function runOnMemory() {
    const c = cfg();
    if (!c.enabled || !c.onMemory || onMemBusy) return;
    const range = await getLatestMemoryRange();
    if (!range) return;
    const endMsg = ctxRef?.chat?.[range.end];
    if (!endMsg) return;
    // уже есть метка на конце сцены — пропускаем (защита от повтора)
    if (parseValue(endMsg.mes, c.name) != null) return;
    onMemBusy = true;
    try {
        await recompute(range.start, range.end, { silent: true });
    } finally {
        setTimeout(() => { onMemBusy = false; }, 500);
    }
}

// ----------------------------------------------------------------------------
// Рендер полоски в бабле + скрытие метки
// ----------------------------------------------------------------------------
function hideMarker(el, name) {
    const t = el.querySelector(".mes_text");
    if (!t) return;
    const re = markerRe(name, true);
    if (re.test(t.innerHTML)) {
        t.innerHTML = t.innerHTML.replace(markerRe(name, true), "");
    }
}
function removeBar(el) {
    el.querySelector(".mm-statbar")?.remove();
}
function renderBar(el, name, val, min, max) {
    const block = el.querySelector(".mes_block") || el;
    let bar = el.querySelector(".mm-statbar");
    if (!bar) {
        bar = document.createElement("div");
        bar.className = "mm-statbar";
        const chip = block.querySelector(".stmb_mem_label");
        const text = block.querySelector(".mes_text");
        if (chip && chip.parentElement === block) chip.after(bar);
        else if (text) block.insertBefore(bar, text);
        else block.appendChild(bar);
        bar.innerHTML =
            `<span class="mm-statbar-name"></span>` +
            `<span class="mm-statbar-track"><span class="mm-statbar-fill"></span></span>` +
            `<span class="mm-statbar-val"></span>`;
    }
    const range = (max - min) || 1;
    const pct = Math.round(((val - min) / range) * 100);
    bar.querySelector(".mm-statbar-name").textContent = name;
    bar.querySelector(".mm-statbar-val").textContent = `${val}`;
    const fill = bar.querySelector(".mm-statbar-fill");
    fill.style.width = clamp(pct, 0, 100) + "%";
    fill.style.background = colorFor(pct);
    bar.title = `${name}: ${val} / ${max}`;
}

function processMessage(el) {
    const c = cfg();
    if (!c.enabled) { removeBar(el); return; }
    const id = parseInt(el.getAttribute("mesid"));
    const msg = ctxRef?.chat?.[id];
    if (!msg) return;
    const val = parseValue(msg.mes, c.name);
    hideMarker(el, c.name);
    if (val == null) { removeBar(el); return; }
    renderBar(el, c.name, clamp(val, c.min, c.max), c.min, c.max);
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
    btn.title = "Полоска-стат (настройка)";
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

function openModal() {
    document.getElementById("mm-statbar-modal")?.remove();
    const c = cfg();
    const ov = document.createElement("div");
    ov.id = "mm-statbar-modal";
    ov.innerHTML = `
      <div class="mm-sb-box">
        <div class="mm-sb-head">
          <div class="mm-sb-title"><i class="fa-solid fa-chart-simple"></i> Полоска-стат</div>
          <div class="mm-sb-close fa-solid fa-xmark interactable" title="Закрыть" tabindex="0"></div>
        </div>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-enabled"> <span>Включить полоску</span></label>
        <label class="mm-sb-lbl">Название стата</label>
        <input type="text" id="mm-sb-name" class="text_pole" placeholder="HP / Нервный срыв / Доверие">
        <label class="mm-sb-lbl">Что это и как меняется (твоя часть промта)</label>
        <textarea id="mm-sb-meaning" class="text_pole" rows="4" placeholder="Напр.: Физическое здоровье. Раны и усталость снижают, отдых и лечение повышают."></textarea>
        <div class="mm-sb-range">
          <label class="mm-sb-lbl">Мин</label><input type="number" id="mm-sb-min" class="text_pole">
          <label class="mm-sb-lbl">Макс</label><input type="number" id="mm-sb-max" class="text_pole">
        </div>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-inline"> <span>Модель заполняет сама (в каждом ответе)</span></label>
        <label class="mm-sb-row"><input type="checkbox" id="mm-sb-onmem"> <span>Пересчитывать на создании памяти (отдельный AI-запрос по сцене)</span></label>
        <div class="mm-sb-hint">Фиксированную часть промта (формат <code>[[Имя:N]]</code>, диапазон, «меняй от прошлого») модуль добавляет сам. Ты пишешь только смысл.</div>
        <div class="mm-sb-actions">
          <div class="menu_button mm-sb-recompute" title="Посчитать стат по последней сцене прямо сейчас">↻ Пересчитать сейчас</div>
          <div class="menu_button mm-sb-save">Сохранить</div>
          <div class="menu_button mm-sb-cancel">Отмена</div>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.querySelector("#mm-sb-enabled").checked = !!c.enabled;
    ov.querySelector("#mm-sb-name").value = c.name;
    ov.querySelector("#mm-sb-meaning").value = c.meaning;
    ov.querySelector("#mm-sb-min").value = c.min;
    ov.querySelector("#mm-sb-max").value = c.max;
    ov.querySelector("#mm-sb-inline").checked = !!c.inline;
    ov.querySelector("#mm-sb-onmem").checked = !!c.onMemory;

    const close = () => ov.remove();
    ov.querySelector(".mm-sb-close").addEventListener("click", close);
    ov.querySelector(".mm-sb-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

    // Пересчитать сейчас — по последней сцене (диапазону памяти) или последним сообщениям.
    ov.querySelector(".mm-sb-recompute").addEventListener("click", async () => {
        // применим текущие поля без закрытия
        c.name = (ov.querySelector("#mm-sb-name").value || "HP").trim() || "HP";
        c.meaning = ov.querySelector("#mm-sb-meaning").value || "";
        c.min = parseInt(ov.querySelector("#mm-sb-min").value, 10); if (!Number.isFinite(c.min)) c.min = 0;
        c.max = parseInt(ov.querySelector("#mm-sb-max").value, 10); if (!Number.isFinite(c.max)) c.max = 100;
        if (c.max <= c.min) c.max = c.min + 1;
        saveCfg();
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
    ov.querySelector(".mm-sb-save").addEventListener("click", () => {
        c.enabled = ov.querySelector("#mm-sb-enabled").checked;
        c.name = (ov.querySelector("#mm-sb-name").value || "HP").trim() || "HP";
        c.meaning = ov.querySelector("#mm-sb-meaning").value || "";
        c.min = parseInt(ov.querySelector("#mm-sb-min").value, 10); if (!Number.isFinite(c.min)) c.min = 0;
        c.max = parseInt(ov.querySelector("#mm-sb-max").value, 10); if (!Number.isFinite(c.max)) c.max = 100;
        if (c.max <= c.min) c.max = c.min + 1;
        c.inline = ov.querySelector("#mm-sb-inline").checked;
        c.onMemory = ov.querySelector("#mm-sb-onmem").checked;
        saveCfg();
        updateInjection();
        refreshAll();
        close();
        try { toastr?.success?.(c.enabled ? `Полоска «${c.name}» включена.` : "Полоска выключена.", "Полоска-стат"); } catch (e) {}
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
      .mm-statbar {
        display: flex; align-items: center; gap: 8px;
        width: fit-content; max-width: 100%;
        margin: 3px 0 6px; padding: 2px 8px;
        border-radius: 10px; font-size: 0.78em;
        background: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
        border: 1px solid var(--SmartThemeBorderColor);
      }
      .mm-statbar-name { font-weight: 700; opacity: 0.9; }
      .mm-statbar-track {
        position: relative; width: 120px; max-width: 40vw; height: 8px;
        border-radius: 999px; overflow: hidden;
        background: color-mix(in srgb, var(--SmartThemeBodyColor) 20%, transparent);
      }
      .mm-statbar-fill { display:block; height: 100%; border-radius: 999px; transition: width .3s ease, background .3s ease; }
      .mm-statbar-val { font-variant-numeric: tabular-nums; opacity: 0.8; min-width: 2ch; text-align: right; }

      #mm-statbar-modal {
        position: fixed; inset: 0; z-index: 10060; display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.5);
      }
      #mm-statbar-modal .mm-sb-box {
        width: min(440px, 92vw); max-height: 90vh; overflow-y: auto;
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
      #mm-statbar-modal textarea, #mm-statbar-modal input[type="text"], #mm-statbar-modal input[type="number"] { width:100%; box-sizing:border-box; }
      #mm-statbar-modal .mm-sb-hint { font-size:.78em; opacity:.65; line-height:1.35; margin-top:2px; }
      #mm-statbar-modal .mm-sb-hint code { background: color-mix(in srgb, var(--SmartThemeBodyColor) 15%, transparent); padding:0 4px; border-radius:4px; }
      #mm-statbar-modal .mm-sb-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
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
}
