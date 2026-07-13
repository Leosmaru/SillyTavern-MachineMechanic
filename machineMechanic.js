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

import { mmOpenInline } from "./index.build.js";

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

jQuery(() => {
    createToolbarButton();
    $(document).on("click", `#${BUTTON_ID}`, openPanel);
    $(document).on("click", `#${PANEL_ID} .mm-close`, closePanel);
    console.log("[Механик машин] Готово: 🔧 рисует интерфейс приложения в чате.");
});
