// ============================================================================
// Механик машин — «Понятные ошибки».
//
// Плагин при сбоях показывает сырой текст ошибки (часто английский и неочевидный,
// напр. «...maximum context length...» при нехватке токенов). Этот модуль ловит
// такие ошибки — и в тостах, и в верхней панели задач (#top_chat_stmb_jobs) —
// и добавляет понятное объяснение по-русски + рекомендацию, что сделать.
//
// Движок (index.build.js) не трогается: перехват через обёртку toastr и
// наблюдатель за строками ошибок в панели.
// ============================================================================

const MODULE = "Механик машин/ошибки";

// Правила: паттерн в тексте ошибки → заголовок + что делать.
const RULES = [
    {
        re: /context[_ ]?length|maximum context|context window|too many tokens|reduce the length|prompt is too long|input is too long|token(s)?[^.]{0,30}(exceed|limit|too)|\b413\b|payload too large|request too large/i,
        title: "⚠️ Похоже, не хватает токенов",
        text: "Сцена (или контекст) больше, чем модель способна принять. Что сделать: уменьши диапазон сцены (меньше сообщений между ▶ и ◀); включи авто-скрытие старого или меньший интервал авто-сводки; выбери лёгкий промпт (Minimal / Sum Up); либо подними лимит контекста модели в пресете Chat Completion.",
    },
    {
        re: /rate limit|\b429\b|too many requests|quota|insufficient_quota|billing/i,
        title: "⏳ Лимит/квота API",
        text: "API временно отклоняет запросы или кончилась квота. Подожди немного и повтори; проверь баланс/лимиты у провайдера.",
    },
    {
        re: /\b401\b|\b403\b|unauthorized|invalid api key|authentication|forbidden|api key/i,
        title: "🔑 Проблема с ключом/доступом",
        text: "API-ключ неверный или нет доступа к модели. Проверь ключ и подключение в API Connections (🔌).",
    },
    {
        re: /invalid json|not valid json|json parse|failed to parse|unexpected token|non-json|no json|could not parse/i,
        title: "🧩 Модель ответила не в формате JSON",
        text: "Плагин не смог разобрать ответ. Повтори генерацию; НЕ убирай из промпта инструкцию «respond with JSON»; попробуй модель поумнее или уменьши сцену.",
    },
    {
        re: /no visible messages|has no visible|empty scene|no messages in|scene is empty/i,
        title: "🎬 Пустой диапазон сцены",
        text: "В выбранном диапазоне нет видимых сообщений. Проверь маркеры начала (▶) и конца (◀) и не скрыт ли диапазон.",
    },
    {
        re: /failed to fetch|network|timeout|timed out|econn|socket hang|getaddrinfo|\bdns\b|connection refused|err_connection/i,
        title: "🌐 Нет связи с API",
        text: "Не удалось достучаться до API. Проверь интернет, адрес эндпоинта и что бэкенд/прокси запущен.",
    },
    {
        re: /empty response|no response|returned nothing|blank response|response was empty/i,
        title: "📭 Пустой ответ модели",
        text: "Модель вернула пусто. Повтори; проверь Max Response Tokens (не 0), лимиты провайдера; попробуй другую модель.",
    },
];

function matchRule(text) {
    if (!text) return null;
    for (const r of RULES) if (r.re.test(text)) return r;
    return null;
}

// Не спамить одинаковыми подсказками подряд.
let lastHintTitle = null;
let lastHintAt = 0;
function nowMs() {
    // Date.now доступен в браузере
    try { return Date.now(); } catch (e) { return 0; }
}

function showHint(rule) {
    if (!rule) return;
    const t = nowMs();
    if (rule.title === lastHintTitle && t - lastHintAt < 4000) return; // дедуп
    lastHintTitle = rule.title;
    lastHintAt = t;
    try {
        window.toastr?.info?.(rule.text, rule.title, {
            timeOut: 0,            // висит, пока не закроешь — чтобы успеть прочитать
            extendedTimeOut: 0,
            closeButton: true,
            escapeHtml: true,
        });
    } catch (e) {
        console.warn(`[${MODULE}] showHint:`, e);
    }
}

// ----------------------------------------------------------------------------
// Перехват toastr.error / toastr.warning
// ----------------------------------------------------------------------------
function installToastrWrap() {
    const tr = window.toastr;
    if (!tr || tr.__mmHinted) return false;
    ["error", "warning"].forEach((level) => {
        const orig = tr[level] ? tr[level].bind(tr) : null;
        if (!orig) return;
        tr[level] = function (msg, title, opts) {
            const ret = orig(msg, title, opts);
            try {
                const text = `${msg ?? ""} ${title ?? ""}`;
                // только для наших/лорбучных сообщений и явных паттернов
                const rule = matchRule(text);
                if (rule) showHint(rule);
            } catch (e) { /* noop */ }
            return ret;
        };
    });
    tr.__mmHinted = true;
    return true;
}

// ----------------------------------------------------------------------------
// Верхняя панель задач: подсветка ошибок с рекомендацией
// ----------------------------------------------------------------------------
function augmentJobsPanel() {
    const rows = document.querySelectorAll(".stmb-jobs-row-error");
    rows.forEach((row) => {
        if (row.dataset.mmHinted === "1") return;
        const rule = matchRule(row.textContent || "");
        if (!rule) return;
        row.dataset.mmHinted = "1";
        const hint = document.createElement("div");
        hint.className = "mm-err-hint";
        hint.style.cssText =
            "margin-top:4px;padding:6px 8px;border-radius:6px;font-size:0.85em;line-height:1.35;" +
            "background:color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);" +
            "border:1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, transparent);";
        hint.innerHTML = `<b></b><br><span></span>`;
        hint.querySelector("b").textContent = rule.title;
        hint.querySelector("span").textContent = rule.text;
        row.appendChild(hint);
    });
}

let obs = null;
let jobTimer = null;
function startJobsObserver() {
    if (obs) return;
    obs = new MutationObserver(() => {
        clearTimeout(jobTimer);
        jobTimer = setTimeout(() => { try { augmentJobsPanel(); } catch (e) {} }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
}

// ----------------------------------------------------------------------------
// Точка входа
// ----------------------------------------------------------------------------
export function initErrorHints() {
    // toastr может появиться не сразу — пробуем несколько раз.
    let tries = 0;
    const iv = setInterval(() => {
        if (installToastrWrap() || tries++ > 20) clearInterval(iv);
    }, 300);
    startJobsObserver();
}
