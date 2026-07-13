// Сборка плагина «Механик машин» через esbuild (замена bun-сборки Memory Books).
//
// Что делает:
//  - точки входа: index.js и style.css
//  - на выходе: index.build.js и style.build.css
//  - импорты SillyTavern (все, что начинаются с "../") помечаются external —
//    они НЕ вшиваются, а резолвятся движком ST в рантайме.
//  - всё остальное (модули ./*.js и зависимость dirty-json) вшивается внутрь.
//
// Запуск:  npm run build

import { build } from "esbuild";

// Плагин: любой импорт вида "../..." оставить внешним (это код SillyTavern).
const externalizeSillyTavern = {
    name: "externalize-sillytavern-imports",
    setup(b) {
        b.onResolve({ filter: /^\.\.\// }, (args) => ({
            path: args.path,
            external: true,
        }));
    },
};

const result = await build({
    entryPoints: ["index.js", "style.css"],
    outdir: ".",
    entryNames: "[name].build",
    bundle: true,
    format: "esm",
    platform: "browser",
    minify: false,        // не минифицируем — так проще отлаживать наш форк
    sourcemap: "external",
    logLevel: "info",
    plugins: [externalizeSillyTavern],
    allowOverwrite: true,
});

if (result.errors && result.errors.length) {
    console.error("❌ Сборка с ошибками");
    process.exit(1);
}
console.log("✓ Сборка готова: index.build.js + style.build.css");
