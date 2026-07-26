// ============================================================================
// soul-md — серверный плагин SillyTavern.
//
// Пишет/дописывает дневник в .md и ищет по смыслу РОДНЫМ эмбеддером ST
// (getTransformersVector -> all-mpnet-base-v2, тот же, что использует Vector Storage).
// Никакого Ollama и внешних сервисов: модель уже крутится внутри ST.
//
// ВАЖНО: файлы привязаны к КОНКРЕТНОМУ ЧАТУ (папка = id чата). Удаляешь чат в ST ->
// событие CHAT_DELETED -> фронт зовёт /purge -> дневник этого чата стирается целиком.
//
// Маршруты (нужен enableServerPlugins: true в config.yaml):
//   POST /api/plugins/soul-md/append  { chat, date, text }
//   POST /api/plugins/soul-md/query   { chat, query, k }   -> { memory }
//   POST /api/plugins/soul-md/docs    { chat }             -> { docs: [{name,text}] }
//   POST /api/plugins/soul-md/purge   { chat }             -> удалить дневник чата
//
// Файлы: plugins/soul-md/data/<id_чата>/Diary_<ГГГГ-ММ-ДД>.md
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const info = { id: 'soul-md', name: 'Soul MD', description: 'Дневник .md на чат + родной поиск по смыслу' };

const ROOT = path.join(__dirname, 'data');

// РОДНОЙ эмбеддер ST. embedding.js — ESM, тянем динамическим import по file:// пути
// (кросс-платформенно: Windows и Termux/Linux).
const EMB_PATH = pathToFileURL(path.join(__dirname, '..', '..', 'src', 'vectors', 'embedding.js')).href;
let _embed = null;
async function embed(text) {
    if (!_embed) ({ getTransformersVector: _embed } = await import(EMB_PATH));
    return _embed(text); // вектор уже нормализован (normalize:true)
}

// векторы нормализованы -> косинус == скалярное произведение
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// имя папки из id чата (одинаково для записи и для удаления — иначе не совпадёт)
const safe = (s) => String(s || '').replace(/[^\p{L}\p{N} _-]/gu, '_').trim();
const chatDir = (chat) => { const c = safe(chat); return c ? path.join(ROOT, c) : null; };

// имя файла дока (с точкой и .md), без обхода каталогов
const safeFile = (s) => {
    const f = String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '_');
    return (f && f.endsWith('.md') && !f.includes('..')) ? f : null;
};

async function init(router) {
    // 1) ДОПИСАТЬ реплику в дневник этого чата — без переписывания
    router.post('/append', (req, res) => {
        try {
            const { chat, date, text } = req.body || {};
            const dir = chatDir(chat);
            if (!dir) return res.json({ ok: false, skipped: 'no-chat' });
            if (!text || !String(text).trim()) return res.json({ ok: false, skipped: 'empty' });
            fs.mkdirSync(dir, { recursive: true });
            const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
            const time = new Date().toTimeString().slice(0, 5);
            fs.appendFileSync(path.join(dir, `Diary_${day}.md`), `\n\n**[${time}]**\n${String(text).trim()}`, 'utf-8');
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // 2) ДНЕВНИК = последние N записей по времени (как Soul of Waifu), без семантики
    router.post('/query', (req, res) => {
        try {
            const { chat, k = 3 } = req.body || {};
            const dir = chatDir(chat);
            if (!dir || !fs.existsSync(dir)) return res.json({ memory: '' });
            const chunks = [];
            for (const f of fs.readdirSync(dir).filter(n => n.startsWith('Diary_') && n.endsWith('.md')).sort())
                for (const p of fs.readFileSync(path.join(dir, f), 'utf-8').split(/\n\n+/))
                    if (p.trim()) chunks.push(p.trim());
            res.json({ memory: chunks.slice(-Math.max(1, k)).join('\n\n') });
        } catch (e) { res.status(500).json({ memory: '', error: String(e) }); }
    });

    // 3) ОТДАТЬ все .md чата для листалки во фронте
    router.post('/docs', (req, res) => {
        try {
            const dir = chatDir((req.body || {}).chat);
            if (!dir || !fs.existsSync(dir)) return res.json({ docs: [] });
            const docs = fs.readdirSync(dir).filter(n => n.endsWith('.md'))
                .map(n => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf-8') }));
            res.json({ docs });
        } catch (e) { res.status(500).json({ docs: [], error: String(e) }); }
    });

    // 4) ПЕРЕЗАПИСАТЬ именованный трекер (Psyche.md / Status.md) — обновление на месте
    router.post('/tracker', (req, res) => {
        try {
            const { chat, name, text } = req.body || {};
            const dir = chatDir(chat);
            const nm = safe(name).replace(/\s+/g, '_');
            if (!dir || !nm) return res.json({ ok: false, skipped: 'no-chat-or-name' });
            if (!text || !String(text).trim()) return res.json({ ok: false, skipped: 'empty' });
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${nm}.md`), String(text).trim(), 'utf-8');
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // 5) ПРОЧИТАТЬ один трекер (прошлую версию — отдаём модели для обновления на месте)
    router.post('/get', (req, res) => {
        try {
            const { chat, name } = req.body || {};
            const dir = chatDir(chat);
            const nm = safe(name).replace(/\s+/g, '_');
            const file = (dir && nm) ? path.join(dir, `${nm}.md`) : null;
            const text = (file && fs.existsSync(file)) ? fs.readFileSync(file, 'utf-8') : '';
            res.json({ text });
        } catch (e) { res.status(500).json({ text: '', error: String(e) }); }
    });

    // 5.5) ПЕРЕЗАПИСАТЬ произвольный док целиком (ручная правка из вьюера)
    router.post('/save', (req, res) => {
        try {
            const { chat, name, text } = req.body || {};
            const dir = chatDir(chat);
            const fn = safeFile(name);
            if (!dir || !fn) return res.json({ ok: false, skipped: 'bad-name' });
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, fn), String(text == null ? '' : text), 'utf-8');
            // правка меняет тексты -> сбросить кэш векторов, чтобы поиск пересчитался
            try { const vc = path.join(dir, '_vectors.json'); if (fs.existsSync(vc)) fs.unlinkSync(vc); } catch (_) {}
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // --- ТЕМЫ (topics/) — по одному файлу на субъект, Archivist перезаписывает ---
    const topicsDir = (chat) => { const d = chatDir(chat); return d ? path.join(d, 'topics') : null; };
    const topFile = (name) => safeFile((name || '').endsWith('.md') ? name : `${name}.md`);

    // список тем (имя + текст) — вьюер + контекст Router'у
    router.post('/topics', (req, res) => {
        try {
            const dir = topicsDir((req.body || {}).chat);
            if (!dir || !fs.existsSync(dir)) return res.json({ topics: [] });
            const topics = fs.readdirSync(dir).filter(n => n.endsWith('.md') || n.endsWith('.md.off'))
                .map(n => {
                    const off = n.endsWith('.off');
                    const base = off ? n.slice(0, -4) : n; // убрать .off
                    return { name: base, text: fs.readFileSync(path.join(dir, n), 'utf-8'), off };
                });
            res.json({ topics });
        } catch (e) { res.status(500).json({ topics: [], error: String(e) }); }
    });

    // перезаписать тему (Archivist)
    router.post('/topic-save', (req, res) => {
        try {
            const { chat, name, text } = req.body || {};
            const dir = topicsDir(chat);
            const fn = topFile(name);
            if (!dir || !fn) return res.json({ ok: false, skipped: 'bad-name' });
            if (!text || !String(text).trim()) return res.json({ ok: false, skipped: 'empty' });
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, fn), String(text).trim(), 'utf-8');
            res.json({ ok: true, name: fn });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // RAG по темам (тянем актуальные факты по смыслу)
    router.post('/topics-query', async (req, res) => {
        try {
            const { chat, query, k = 3 } = req.body || {};
            const dir = topicsDir(chat);
            if (!dir || !query || !fs.existsSync(dir)) return res.json({ memory: '' });
            const items = fs.readdirSync(dir).filter(n => n.endsWith('.md'))
                .map(n => ({ n, t: fs.readFileSync(path.join(dir, n), 'utf-8').trim() })).filter(x => x.t);
            if (!items.length) return res.json({ memory: '' });
            const qv = await embed(query);
            for (const it of items) it.s = dot(qv, await embed(it.t.slice(0, 1000)));
            items.sort((a, b) => b.s - a.s);
            const top = items.slice(0, Math.max(1, k));
            res.json({ memory: top.map(x => x.t).join('\n\n'), used: top.map(x => x.n.replace(/\.md$/, '')) });
        } catch (e) { res.status(500).json({ memory: '', error: String(e) }); }
    });

    // удалить одну тему
    router.post('/topic-delete', (req, res) => {
        try {
            const { chat, name } = req.body || {};
            const dir = topicsDir(chat); const fn = topFile(name);
            if (dir && fn) {
                for (const p of [path.join(dir, fn), path.join(dir, fn + '.off')])
                    if (fs.existsSync(p)) fs.unlinkSync(p);
            }
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // исключить/вернуть тему (переименование .md <-> .md.off; в поиск идут только .md)
    router.post('/topic-exclude', (req, res) => {
        try {
            const { chat, name, off } = req.body || {};
            const dir = topicsDir(chat); const fn = topFile(name);
            if (!dir || !fn) return res.json({ ok: false });
            const active = path.join(dir, fn), disabled = active + '.off';
            if (off && fs.existsSync(active)) fs.renameSync(active, disabled);
            else if (!off && fs.existsSync(disabled)) fs.renameSync(disabled, active);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });

    // 6) УДАЛИТЬ дневник чата целиком (вызывается при удалении чата в ST)
    router.post('/purge', (req, res) => {
        try {
            const dir = chatDir((req.body || {}).chat);
            if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
    });
}

module.exports = { info, init };
