# Механик машин (Machine Mechanic)

Расширение для **SillyTavern**. Иконка-ключ 🔧 рядом с волшебной палочкой
открывает полный интерфейс приложения **прямо в чате как сообщение**, целиком
на русском. У каждой настройки есть значок «?» с контекстной справкой и
подсветкой нужного места.

## Установка (по ссылке)
В SillyTavern: **Extensions → Install extension** → вставить URL этого репозитория.
Затем обновить страницу (F5).

Кнопка 🔧 появится внизу, у поля ввода, рядом с волшебной палочкой.

## Разработка / сборка
```
npm install
npm run build   # esbuild: index.js + style.css -> index.build.js + style.build.css
```
`machineMechanic.js` и `help.html` грузятся напрямую — их правки видны сразу (F5),
без пересборки. Пересборка нужна только после правок `index.js` / `style.css`.

## Лицензия и атрибуция
Это форк расширения **SillyTavern Memory Books** (© aikohanasaki),
распространяется под лицензией **AGPL-3.0** (см. `LICENSE`).
Оригинал: https://github.com/aikohanasaki/SillyTavern-MemoryBooks
