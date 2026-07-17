// ============================================================================
// Механик машин — «Режим памяти» (борьба с шумом ключевых слов).
//
// Одна галочка в настройках плагина:
//   ▢ снято  = ВАРИАНТ 1 «Чистые ключи»: у воспоминаний ключи подрезаются до
//              ~8 уникальных (общие слова выкидываются). Активация по ключам.
//   ▣ стоит  = ВАРИАНТ 2 «Смысл (векторы)»: включается Vector Storage → World
//              Info, а ключи у воспоминаний очищаются → активация по смыслу.
//
// Применяется и к существующим, и к новым записям (авто по событию сохранения
// лорбука). Обратимо: оригинальные ключи хранятся в entry.mm_savedKeys.
// ============================================================================

import { chat_metadata, saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { METADATA_KEY, world_names, loadWorldInfo, saveWorldInfo } from "../../../world-info.js";

const MODULE = "Механик машин/режим-памяти";
const MAX_KEYS = 8;

let applying = false;   // защита от петли save→WORLDINFO_UPDATED→save
let worldTimer = null;

// ----------------------------------------------------------------------------
// Настройка (persist в extension_settings.STMemoryBooks.mm_vectorMode)
// ----------------------------------------------------------------------------
function getMode() {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    return s.mm_vectorMode ? "vector" : "keyword";
}
function setModeSetting(vector) {
    const s = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    s.mm_vectorMode = !!vector;
    saveSettingsDebounced();
}

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

// ----------------------------------------------------------------------------
// Чистка ключей (эвристика): убрать общие слова, оставить уникальные
// ----------------------------------------------------------------------------
const STOP = new Set([
    "kitchen","bedroom","living room","room","bed","door","window","wall","floor",
    "table","chair","couch","sofa","house","home","apartment","car","phone","hand",
    "hands","eyes","face","hair","head","body","ring","dinner","lunch","breakfast",
    "meal","food","beer","wine","water","coffee","tea","cigarette","night","morning",
    "day","evening","afternoon","street","road","garden","yard","money","work","job",
    "time","brother","sister","mother","father","mom","dad","parents","family","son",
    "daughter","kiss","smile","tears","cry","love","sex","bathroom","shower","bath",
    "clothes","shirt","dress","shorts","bed","letter","message","text","book","chain",
    "divorce","marriage","wedding","signature","documents","document","ring","rings",
    "beer","drunk","departure","bench","rope","shed","garden","kitchen",
]);

function cleanKeywords(keys) {
    const src = Array.isArray(keys) ? keys : [];
    const scored = src.map((raw) => {
        const kw = String(raw).trim();
        const lower = kw.toLowerCase();
        let score = 0;
        if (kw.includes(" ")) score += 5;                 // фраза = конкретика
        if (/^[A-ZА-ЯЁ]/.test(kw)) score += 3;            // имя собственное
        if (kw.length >= 8) score += 1;                   // длиннее = реже
        if (STOP.has(lower)) score -= 6;                  // общее слово
        return { kw, lower, score };
    });

    let kept = scored.filter((s) => !STOP.has(s.lower) && s.kw);
    kept.sort((a, b) => b.score - a.score);

    const seen = new Set();
    const out = [];
    for (const s of kept) {
        if (seen.has(s.lower)) continue;
        seen.add(s.lower);
        out.push(s.kw);
        if (out.length >= MAX_KEYS) break;
    }

    // Если всё оказалось «общим» — оставим самые длинные из оригинала, чтоб не остаться без ключей.
    if (out.length === 0) {
        const fallback = [...src].map(String).sort((a, b) => b.length - a.length).slice(0, 5);
        return fallback;
    }
    return out;
}

function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ----------------------------------------------------------------------------
// Включение/выключение Vector Storage → World Info
// ----------------------------------------------------------------------------
function setVectorsWorldInfo(on) {
    try {
        const v = extension_settings.vectors;
        if (v) v.enabled_world_info = !!on;
        // Дёрнем родной чекбокс расширения, если он отрисован — чтобы применилось «вживую».
        const cb = document.getElementById("vectors_enabled_world_info");
        if (cb && cb.checked !== !!on) {
            cb.checked = !!on;
            cb.dispatchEvent(new Event("input", { bubbles: true }));
            cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        saveSettingsDebounced();
    } catch (e) {
        console.warn(`[${MODULE}] Не удалось переключить Vector Storage:`, e);
    }
}

// ----------------------------------------------------------------------------
// Применение режима к записям лорбука
// ----------------------------------------------------------------------------
function isMemoryEntry(e) {
    return !!e && e.stmemorybooks === true;
}

async function applyModeToLorebook(mode, { silent = false, force = false } = {}) {
    if (applying) return { changed: 0, skipped: true };
    const name = resolveLorebookNamePassive();
    if (!name) return { changed: 0, noLorebook: true };

    setVectorsWorldInfo(mode === "vector");

    let data;
    try {
        data = await loadWorldInfo(name);
    } catch (e) {
        console.warn(`[${MODULE}] loadWorldInfo failed:`, e);
        return { changed: 0, error: true };
    }
    if (!data || !data.entries) return { changed: 0 };

    let changed = 0;
    for (const entry of Object.values(data.entries)) {
        if (!isMemoryEntry(entry)) continue;

        // Авто-режим трогает только необработанные/сменившие режим записи —
        // чтобы не затирать ручные правки ключей. Переключение галочки = force.
        const needsWork = force || entry.mm_mode !== mode;
        if (!needsWork) continue;

        // Один раз сохраняем оригинальные ключи (для обратимости и чистки из исходника).
        if (!Array.isArray(entry.mm_savedKeys)) {
            entry.mm_savedKeys = Array.isArray(entry.key) ? [...entry.key] : [];
        }

        if (mode === "vector") {
            if (entry.mm_mode !== "vector" || (Array.isArray(entry.key) && entry.key.length > 0)) {
                entry.key = [];
                entry.vectorized = true;
                entry.constant = false;
                entry.mm_mode = "vector";
                changed++;
            }
        } else {
            const cleaned = cleanKeywords(entry.mm_savedKeys);
            if (entry.mm_mode !== "keyword" || !arraysEqual(entry.key, cleaned)) {
                entry.key = cleaned;
                entry.mm_mode = "keyword";
                changed++;
            }
        }
    }

    if (changed > 0) {
        applying = true;
        try {
            await saveWorldInfo(name, data, true);
        } finally {
            setTimeout(() => { applying = false; }, 400);
        }
        if (!silent) {
            try {
                const msg = mode === "vector"
                    ? `Смысловой режим: ключи очищены у ${changed} воспоминаний, векторы включены.`
                    : `Ключи почищены у ${changed} воспоминаний.`;
                toastr?.success?.(msg, "Режим памяти");
            } catch (e) {}
        }
    } else if (!silent) {
        try { toastr?.info?.("Изменений не потребовалось.", "Режим памяти"); } catch (e) {}
    }
    return { changed };
}

// ----------------------------------------------------------------------------
// Галочка в настройках плагина
// ----------------------------------------------------------------------------
function buildRow() {
    const row = document.createElement("div");
    row.className = "mm-memtune-row";
    row.style.margin = "6px 0 2px";
    row.innerHTML = `
        <label class="checkbox_label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" class="mm-mem-vector-cb">
            <span>🧠 Смысловая активация памяти <b>(векторы вместо ключей)</b></span>
        </label>
        <div class="mm-memtune-hint" style="font-size:0.8em;opacity:0.7;margin:2px 0 0 24px;line-height:1.35;">
            Выкл — ключи чистятся до ~8 точных слов. Вкл — воспоминания подтягиваются по смыслу сцены
            (Vector Storage → World Info), ключи очищаются. Применяется ко всем воспоминаниям чата.
        </div>`;
    const cb = row.querySelector(".mm-mem-vector-cb");
    cb.checked = getMode() === "vector";
    cb.addEventListener("change", async () => {
        const vector = cb.checked;
        setModeSetting(vector);
        // синхронизируем остальные копии галочки (если настройки отрисованы дважды)
        document.querySelectorAll(".mm-mem-vector-cb").forEach((el) => { if (el !== cb) el.checked = vector; });
        await applyModeToLorebook(vector ? "vector" : "keyword", { force: true });
    });
    return row;
}

function injectCheckbox() {
    // СТРОГО ОДНА галочка на весь документ — иначе плодятся дубли, а наблюдатель
    // зацикливается (форк перерисовывает панель настроек по многу раз).
    const existing = document.querySelector(".mm-memtune-row");
    if (existing && existing.isConnected) return;
    if (existing) existing.remove(); // осиротевшая — убрать

    const anchor = document.querySelector('input[id="stmb-show-notifications"]');
    if (!anchor) return;
    const label = anchor.closest("label") || anchor.parentElement;
    if (!label || !label.parentElement) return;
    label.parentElement.insertBefore(buildRow(), label.nextSibling);
}

let injectTimer = null;
function startSettingsObserver() {
    const obs = new MutationObserver(() => {
        clearTimeout(injectTimer);
        injectTimer = setTimeout(() => {
            try { injectCheckbox(); } catch (e) { /* noop */ }
        }, 120);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // первичная попытка (вдруг настройки уже открыты)
    try { injectCheckbox(); } catch (e) {}
}

// ----------------------------------------------------------------------------
// Авто-применение к новым воспоминаниям
// ----------------------------------------------------------------------------
function hookWorldInfoUpdated(eventSource, eventTypes) {
    if (!eventSource || !eventTypes?.WORLDINFO_UPDATED) return;
    eventSource.on(eventTypes.WORLDINFO_UPDATED, () => {
        if (applying) return;
        clearTimeout(worldTimer);
        worldTimer = setTimeout(() => {
            applyModeToLorebook(getMode(), { silent: true }).catch((e) =>
                console.warn(`[${MODULE}] авто-применение не удалось:`, e),
            );
        }, 350);
    });
}

// ----------------------------------------------------------------------------
// Применение к существующим записям при открытии чата (только необработанные)
// ----------------------------------------------------------------------------
function hookChatChanged(eventSource, eventTypes) {
    if (!eventSource || !eventTypes?.CHAT_CHANGED) return;
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        setTimeout(() => {
            applyModeToLorebook(getMode(), { silent: true, force: false }).catch((e) =>
                console.warn(`[${MODULE}] применение при смене чата не удалось:`, e),
            );
        }, 600);
    });
}

// ----------------------------------------------------------------------------
// Точка входа
// ----------------------------------------------------------------------------
export function initMemoryTuning(ctx) {
    startSettingsObserver();
    hookWorldInfoUpdated(ctx?.eventSource, ctx?.eventTypes);
    hookChatChanged(ctx?.eventSource, ctx?.eventTypes);

    // Если чат уже открыт на момент загрузки — применить к существующим.
    setTimeout(() => {
        applyModeToLorebook(getMode(), { silent: true, force: false }).catch(() => {});
    }, 1200);
}
