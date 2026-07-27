// ============================================================================
// Механик машин — точка входа плагина (manifest.json → "js").
//
// Подключаем ДВИЖОК (сборка index.build.js) и его функцию mmOpenInline —
// она рисует НАСТОЯЩИЙ интерфейс приложения прямо в переданный контейнер.
//
// Значок 🔧 рядом с палочкой создаёт в чате сообщение и просит движок
// отрисовать в нём родной интерфейс (не модальное окно). Крестик/«Закрыть»
// убирают сообщение — чат встаёт как был.
// ============================================================================

import { mmOpenInline, mmTranslateText, mmOnGenerationStart, mmShowRollOnMessage } from "./index.build.js";
import { initMemoryLabels } from "./memoryLabels.js";
import { initChapterNav } from "./chapterNav.js";
import { initMemoryTuning } from "./memoryTuning.js";
import { initErrorHints } from "./errorHints.js";
import { initStatBar } from "./statBar.js";
import { initSoulDiary } from "./soulDiary.js";
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const PANEL_ID = "mm-panel";
const BUTTON_ID = "mm-wand-button";

// URL справки рядом с плагином (для значков «?»).
const HELP_URL = new URL("help.html", import.meta.url).href;

// Наблюдатель за перерисовкой интерфейса — чтобы вернуть «?» после обновления.
let mmHostObserver = null;

// ----------------------------------------------------------------------------
// Значки «?» у настроек: клик открывает справку и подсвечивает нужное место
// ----------------------------------------------------------------------------

/** Один раз добавляет стили для значков «?». */
function injectHelpStyles() {
    if (document.getElementById("mm-help-style")) return;
    const style = document.createElement("style");
    style.id = "mm-help-style";
    style.textContent = `
        .mm-help-q {
            display: inline-flex; align-items: center; justify-content: center;
            width: 16px; height: 16px; margin-left: 6px;
            border-radius: 50%; border: 1px solid var(--SmartThemeBorderColor, #888);
            font-size: 11px; line-height: 1; cursor: help; opacity: 0.6;
            user-select: none; vertical-align: middle; flex: 0 0 auto;
            color: var(--SmartThemeQuoteColor, #7096b8);
        }
        .mm-help-q:hover { opacity: 1; border-color: var(--SmartThemeQuoteColor, #7096b8); }
    `;
    document.head.appendChild(style);
}

/** Куда вставлять «?»: после подписи настройки, иначе после самого контрола. */
function helpAnchorEl(ctrl) {
    const wrap = ctrl.closest("label");
    if (wrap) return wrap;
    const esc = (window.CSS && CSS.escape) ? CSS.escape(ctrl.id) : ctrl.id;
    const forLbl = document.querySelector(`#${PANEL_ID} label[for="${esc}"]`);
    if (forLbl) return forLbl;
    return ctrl;
}

/** Ставит «?» у каждой настройки (контрола stmb-*) в контейнере. */
function injectHelpIcons(host) {
    const ctrls = host.querySelectorAll(
        'input[id^="stmb-"], select[id^="stmb-"], textarea[id^="stmb-"]',
    );
    ctrls.forEach((ctrl) => {
        const anchor = helpAnchorEl(ctrl);
        const next = anchor.nextElementSibling;
        if (next && next.classList && next.classList.contains("mm-help-q")) return; // уже стоит
        const q = document.createElement("span");
        q.className = "mm-help-q";
        q.textContent = "?";
        q.title = "Открыть справку по этой настройке";
        q.dataset.help = ctrl.id;
        q.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Открываем справку на нужном месте: #<id-настройки> подсветит её строку.
            window.open(`${HELP_URL}#${encodeURIComponent(ctrl.id)}`, "_blank", "noopener");
        });
        anchor.insertAdjacentElement("afterend", q);
    });
}

/** Вставляет «?» и следит за перерисовкой интерфейса, чтобы вернуть их. */
function watchHelpIcons(host) {
    injectHelpStyles();
    injectHelpIcons(host);
    if (mmHostObserver) mmHostObserver.disconnect();
    mmHostObserver = new MutationObserver(() => {
        // Отключаемся на время своей вставки, чтобы не зациклиться.
        mmHostObserver.disconnect();
        injectHelpIcons(host);
        mmHostObserver.observe(host, { childList: true, subtree: true });
    });
    mmHostObserver.observe(host, { childList: true, subtree: true });
}

/** Значок-ключ 🔧 справа от волшебной палочки. */
function createToolbarButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = $(`
        <div id="${BUTTON_ID}" class="fa-solid fa-wrench interactable" title="Механик машин" tabindex="0"></div>
    `);

    const wand = $("#extensionsMenuButton");
    if (wand.length > 0) {
        wand.after(button);
    } else if ($("#leftSendForm").length > 0) {
        $("#leftSendForm").append(button);
    } else {
        console.warn("[Механик машин] Панель ввода (#leftSendForm) не найдена.");
    }

    // Иконки в #leftSendForm расставляются через CSS `order`, а не по DOM.
    // У волшебной палочки order обычно 4 — ставим ключ сразу после неё.
    const wandOrder = wand.length ? (parseInt(getComputedStyle(wand[0]).order, 10) || 4) : 4;
    button.css("order", wandOrder + 1);
}

/** Убирает панель из чата. */
function closePanel() {
    if (mmHostObserver) {
        mmHostObserver.disconnect();
        mmHostObserver = null;
    }
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
}

/** Создаёт сообщение в чате и рисует в нём настоящий интерфейс приложения. */
async function openPanel() {
    const chat = document.getElementById("chat");
    if (!chat) {
        console.warn("[Механик машин] Контейнер чата (#chat) не найден.");
        return;
    }

    // Если уже открыт — прокрутить к нему.
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
        existing.scrollIntoView({ behavior: "smooth", block: "end" });
        return;
    }

    // Панель как обычное сообщение чата (.mes). Тело #mm-host — сюда движок
    // отрисует свой родной интерфейс.
    const panel = $(`
        <div id="${PANEL_ID}" class="mes mm-mes">
            <div class="mes_block">
                <div class="ch_name flex-container justifySpaceBetween">
                    <div class="flex-container flex1 alignitemscenter">
                        <div class="flex-container alignItemsBaseline">
                            <span class="name_text">Механик машин</span>
                        </div>
                    </div>
                    <div class="mm-x mm-close fa-solid fa-xmark interactable" title="Закрыть" tabindex="0"></div>
                </div>
                <div class="mes_text">
                    <div id="mm-host" class="stmb-popup mm-host">Загрузка интерфейса…</div>
                    <div class="mm-footer">
                        <div class="menu_button mm-close">Закрыть</div>
                    </div>
                </div>
            </div>
        </div>
    `);

    $(chat).append(panel);
    panel[0].scrollIntoView({ behavior: "smooth", block: "end" });

    const host = panel[0].querySelector("#mm-host");
    try {
        // Движок рисует настоящий интерфейс в наш контейнер (в чате).
        await mmOpenInline(host, () => closePanel());
        // Ставим значки «?» у каждой настройки (и возвращаем их после перерисовок).
        watchHelpIcons(host);
    } catch (err) {
        console.error("[Механик машин] Ошибка отрисовки интерфейса в чат:", err);
        host.textContent = "Ошибка отрисовки интерфейса (см. консоль F12).";
    }
}

// ----------------------------------------------------------------------------
// Значок «перевод ИИ» над каждым сообщением (рядом с переводом SillyTavern)
// ----------------------------------------------------------------------------

/** Добавляет кнопку перевода в блок кнопок сообщения (если её ещё нет). */
function addTranslateButton(mes) {
    const extra = mes.querySelector(".extraMesButtons");
    if (!extra || extra.querySelector(".mm-translate-btn")) return;
    const btn = document.createElement("div");
    btn.className = "mes_button mm-translate-btn fa-solid fa-globe interactable";
    btn.title = "Перевести это сообщение (ИИ)";
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        translateMessage(mes);
    });
    const stTranslate = extra.querySelector(".mes_translate");
    if (stTranslate) stTranslate.after(btn);
    else extra.prepend(btn);
}

/** Переводит текст сообщения и показывает результат под ним (повторный клик — убрать). */
async function translateMessage(mes) {
    const textEl = mes.querySelector(".mes_text");
    if (!textEl) return;
    const existing = mes.querySelector(".mm-translation");
    if (existing) { existing.remove(); return; } // переключатель

    const block = document.createElement("div");
    block.className = "mm-translation";
    block.textContent = "Перевод…";
    textEl.after(block);
    try {
        const src = textEl.innerText || textEl.textContent || "";
        const translated = await mmTranslateText(src);
        block.textContent = translated || "(пустой ответ)";
    } catch (err) {
        console.error("[Механик машин] Ошибка перевода:", err);
        block.textContent = "Ошибка перевода: " + (err && err.message ? err.message : err);
        block.classList.add("mm-translation-error");
    }
}

/** Ставит кнопки перевода на все сообщения и следит за новыми. */
function watchTranslateButtons() {
    const chat = document.getElementById("chat");
    if (!chat) return;
    chat.querySelectorAll(".mes").forEach(addTranslateButton);
    // childList без subtree — реагируем на добавление/удаление сообщений,
    // но не на нашу же вставку кнопки внутрь сообщения (нет самозапуска).
    new MutationObserver(() => {
        chat.querySelectorAll(".mes").forEach(addTranslateButton);
    }).observe(chat, { childList: true });
}

// ----------------------------------------------------------------------------
// Кубик 🎲: значок у «Отправить» (вкл/выкл) + управление показом броска.
//
// Два РАЗНЫХ броска:
//   • Бросок ИИ — авто перед ответом (.mm-dice-above над сообщением) + инъекция
//     в модель. Показ регулируется опцией «Не показывать бросок ИИ».
//   • Бросок пользователя — кнопка «🎲 Бросить сейчас» (.mm-dice под сообщением).
//     Это личный бросок юзера — виден ВСЕГДА, опция его не трогает.
// ----------------------------------------------------------------------------
const DICE_BTN_ID = "mm-dice-button";

// тот же путь настроек, что читает бандл: extension_settings.STMemoryBooks.moduleSettings
function mmModuleSettings() {
    const root = extension_settings.STMemoryBooks || (extension_settings.STMemoryBooks = {});
    return root.moduleSettings || (root.moduleSettings = {});
}

// прятать ли АВТО-бросок ИИ (по умолчанию да — как просил пользователь)
function mmHideAiRoll() {
    const ms = mmModuleSettings();
    if (typeof ms.mmDiceHideAiRoll !== "boolean") ms.mmDiceHideAiRoll = true;
    return ms.mmDiceHideAiRoll;
}

function injectDiceStyles() {
    if (document.getElementById("mm-dice-style")) return;
    const st = document.createElement("style");
    st.id = "mm-dice-style";
    st.textContent = `
        #${DICE_BTN_ID} { opacity: .5; transition: opacity .15s, color .15s; }
        #${DICE_BTN_ID}.mm-dice-on { opacity: 1; color: var(--SmartThemeQuoteColor, #7096b8); }
        #${DICE_BTN_ID}.mm-dice-pulse { animation: mm-dice-pulse .6s ease; }
        @keyframes mm-dice-pulse {
            0% { transform: scale(1); }
            45% { transform: scale(1.5); color: var(--SmartThemeQuoteColor, #7096b8); filter: brightness(1.6); }
            100% { transform: scale(1); }
        }
    `;
    document.head.appendChild(st);
}

// короткий «пульс» значка 🎲 — подтверждение, что бросок сделан (числа не видно)
function mmPulseDiceButton() {
    const btn = document.getElementById(DICE_BTN_ID);
    if (!btn) return;
    btn.classList.remove("mm-dice-pulse");
    void btn.offsetWidth; // рестарт анимации
    btn.classList.add("mm-dice-pulse");
    setTimeout(() => btn.classList.remove("mm-dice-pulse"), 700);
}

// прячем ТОЛЬКО авто-бросок ИИ (.mm-dice-above). Ручной бросок юзера
// (.mm-dice без -above) не трогаем — он виден всегда.
function applyDiceRollCss() {
    let st = document.getElementById("mm-dice-hide-style");
    if (!st) {
        st = document.createElement("style");
        st.id = "mm-dice-hide-style";
        document.head.appendChild(st);
    }
    st.textContent = mmHideAiRoll() ? ".mm-dice-above { display: none !important; }" : "";
}

function updateDiceButton(btn) {
    const on = !!mmModuleSettings().mmDiceEnabled;
    btn.classList.toggle("mm-dice-on", on);
    btn.title = on
        ? "🎲 Кубик ВКЛ — бросок ИИ на каждую генерацию. Клик — выключить."
        : "🎲 Кубик выкл. Клик — включить (бросок ИИ на каждую генерацию).";
}

function createDiceButton() {
    injectDiceStyles();
    applyDiceRollCss();
    if (document.getElementById(DICE_BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = DICE_BTN_ID;
    btn.className = "fa-solid fa-dice-d20 interactable";
    btn.tabIndex = 0;
    btn.addEventListener("click", () => {
        const ms = mmModuleSettings();
        ms.mmDiceEnabled = !ms.mmDiceEnabled;
        try { saveSettingsDebounced(); } catch (e) { /* noop */ }
        updateDiceButton(btn);
        // синхронизировать чекбокс в панели действий, если она открыта
        const chk = document.querySelector(".mm-dice-toggle .mm-dice-check");
        if (chk) chk.checked = ms.mmDiceEnabled;
        if (typeof toastr !== "undefined") {
            toastr.info(ms.mmDiceEnabled ? "🎲 Кубик включён" : "🎲 Кубик выключен", "Механик машин");
        }
    });

    const wrench = document.getElementById(BUTTON_ID);            // 🔧
    const wand = document.getElementById("extensionsMenuButton"); // палочка
    if (wrench) wrench.after(btn);
    else if (wand) wand.after(btn);
    else document.getElementById("leftSendForm")?.appendChild(btn);

    const wandOrder = wand ? (parseInt(getComputedStyle(wand).order, 10) || 4) : 4;
    btn.style.order = String(wandOrder + 2); // после 🔧 (order+1)
    updateDiceButton(btn);
}

// убрать ТОЛЬКО авто-броски ИИ (.mm-dice-above); ручной бросок юзера не трогаем
function mmStripAiRoll() {
    const chat = document.getElementById("chat");
    if (chat) chat.querySelectorAll(".mm-dice-above").forEach((n) => n.remove());
}

// оставить максимум ОДИН авто-бросок — тот, что прямо над текущим сообщением
function mmDedupeAiRoll(mesId) {
    const chat = document.getElementById("chat");
    if (!chat) return;
    const mes = chat.querySelector(`.mes[mesid="${mesId}"]`);
    chat.querySelectorAll(".mm-dice-above").forEach((n) => {
        if (!(mes && n === mes.previousElementSibling)) n.remove();
    });
}

// Галку «Не показывать бросок ИИ» дорисовываем в РОДНОЕ окно настроек кубика
// (оно в бандле) — ловим его появление и вставляем чекбокс рядом с «Включить».
function injectHideAiCheckbox(root) {
    if (!root || !root.querySelector) return;
    const en = root.querySelector("#mm-dice-enabled");
    if (!en || root.querySelector("#mm-dice-hide-ai")) return;
    const anchor = en.closest("label") || en.parentElement;
    if (!anchor) return;
    const lbl = document.createElement("label");
    lbl.style.cssText = "display:flex; gap:8px; align-items:center; margin:8px 0;";
    lbl.innerHTML = '<input type="checkbox" id="mm-dice-hide-ai"> Не показывать бросок ИИ (только скрытая инъекция в модель)';
    const chk = lbl.querySelector("input");
    chk.checked = mmHideAiRoll();
    chk.addEventListener("change", () => {
        mmModuleSettings().mmDiceHideAiRoll = chk.checked;
        try { saveSettingsDebounced(); } catch (e) { /* noop */ }
        applyDiceRollCss();
        if (chk.checked) mmStripAiRoll();
    });
    anchor.after(lbl);
}

jQuery(() => {
    createToolbarButton();
    createDiceButton();
    $(document).on("click", `#${BUTTON_ID}`, openPanel);
    $(document).on("click", `#${PANEL_ID} .mm-close`, closePanel);
    watchTranslateButtons();

    // Авто-бросок кубика на каждый ответ ИИ (если режим включён).
    const ctx = (typeof SillyTavern !== "undefined" && SillyTavern.getContext)
        ? SillyTavern.getContext() : null;
    if (ctx?.eventSource && ctx?.eventTypes) {
        // Перед генерацией — бросок ИИ + инъекция в модель. Если бросок ИИ скрыт,
        // сразу убираем его блок (инъекция при этом остаётся).
        // Свайп (альтернативный вариант ►) НЕ перекидывает кубик — используется тот
        // же бросок, что и у сообщения (инъекция прошлого броска сохраняется).
        // Новый бросок только при обычной генерации / перегенерации («с нуля»).
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
            try {
                if (type === "swipe") return; // свайп — тот же бросок, не перекидываем
                mmOnGenerationStart(type, options, dryRun);
                if (mmHideAiRoll()) mmStripAiRoll();
                // подтверждение, что бросок реально ушёл в модель (даже когда скрыт)
                if (mmModuleSettings().mmDiceEnabled && !dryRun && type !== "quiet" && type !== "impersonate") {
                    const inj = ctx.extensionPrompts?.MM_DICE_ROLL?.value || "";
                    if (inj) {
                        console.log("[Механик машин] 🎲 бросок ИИ ушёл в модель:", inj);
                        mmPulseDiceButton();
                    }
                }
            } catch (e) { /* noop */ }
        });
        // После ответа — показать бросок ИИ над сообщением (если не скрыт), ровно один.
        const rendered = ctx.eventTypes.CHARACTER_MESSAGE_RENDERED || ctx.eventTypes.MESSAGE_RECEIVED;
        ctx.eventSource.on(rendered, (id) => {
            try {
                if (mmHideAiRoll()) { mmStripAiRoll(); }
                else { mmShowRollOnMessage(id); mmDedupeAiRoll(id); }
            } catch (e) { /* noop */ }
        });
        // Значок у «Отправить» пересоздаём при смене чата; синхроним с чекбоксом панели.
        if (ctx.eventTypes.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => createDiceButton());
        }
        $(document).on("change click", ".mm-dice-check", () => {
            const b = document.getElementById(DICE_BTN_ID);
            if (b) updateDiceButton(b);
        });
        // Ловим открытие родного окна настроек кубика → вставляем галку «Не показывать бросок ИИ».
        try {
            new MutationObserver((muts) => {
                for (const m of muts) {
                    for (const n of m.addedNodes) {
                        if (!n || n.nodeType !== 1) continue;
                        if (n.id === "mm-dice-enabled") injectHideAiCheckbox(n.parentElement);
                        else if (n.querySelector && n.querySelector("#mm-dice-enabled")) injectHideAiCheckbox(n);
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        } catch (e) { /* noop */ }
    }

    // Бейджи «к какой записи лорбука относится сообщение» + понятная индикация стрелок.
    try {
        initMemoryLabels(ctx?.eventSource, ctx?.eventTypes);
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать бейджи воспоминаний:", e);
    }

    // Оглавление (навигация по главам-воспоминаниям).
    try {
        initChapterNav(ctx);
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать оглавление:", e);
    }

    // Режим памяти (галочка: чистые ключи ↔ смысловая активация/векторы).
    try {
        initMemoryTuning(ctx);
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать режим памяти:", e);
    }

    // Понятные ошибки генерации (тосты + верхняя панель задач).
    try {
        initErrorHints();
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать подсказки ошибок:", e);
    }

    // Универсальная полоска-стат (отдельная сущность, не трогает сайд-трекеры).
    try {
        initStatBar(ctx);
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать полоску-стат:", e);
    }

    // Дневник души (🧠): .md-память на чат + смысловой поиск (серверный плагин soul-md).
    try {
        initSoulDiary(ctx);
    } catch (e) {
        console.warn("[Механик машин] Не удалось инициализировать дневник души:", e);
    }

    console.log("[Механик машин] Готово: 🔧 интерфейс + 🌐 перевод + 🎲 кубик + 🏷️ бейджи + 📖 оглавление + 🧠 дневник.");
});
