# dsh-1c-project-properties

Плагин DeepSeek Harness: **параметры 1С в разрезе проекта**.

Добавляет в Settings отдельную вкладку **«1С: параметры»**: сверху — общие значения
(путь к платформе по умолчанию), ниже — список проектов и форма параметров выбранного
проекта. Значения проекта лежат **в его собственной папке**, в файле
`.dsh/1c-project.json`, поэтому переезжают вместе с проектом, видны в git и доступны
другим инструментам (плагинам, агентам, скриптам).

## Что хранится

На проект:

| Поле | Ключ в JSON | Смысл |
|---|---|---|
| Путь к базе | `infobasePath` | папка файловой базы либо строка соединения `Srvr="srv";Ref="base";` |
| Пользователь | `user` | имя пользователя 1С для авторизации |
| Пароль | `password` | пароль (хранится в открытом виде — см. ниже) |
| Путь к платформе | `platformPath` | `...\1cv8.exe`; **пусто = берётся значение из общих настроек** |

Общие (на машину, для всех проектов): путь к платформе по умолчанию — файл
`$DSH_HOME/1c-project-properties/settings.json` (`$DSH_HOME` = переменная окружения,
иначе `~/.dsh`).

Список проектов = воркспейсы DSH + пути, добавленные вручную в этой же вкладке. Порядок
обхода: реестр воркспейсов, затем дополнительные пути; дубликаты по пути отбрасываются.

## Файл параметров проекта

```json
{
  "$schema": "dsh-1c-project-properties/v1",
  "infobasePath": "Srvr=\"srv-1c\";Ref=\"buh\";",
  "user": "Администратор",
  "password": "***",
  "platformPath": ""
}
```

* Путь: `<папка проекта>/.dsh/1c-project.json`, кодировка UTF-8, отступ 2.
* Запись атомарная (временный файл + переименование) — обрезанного JSON не будет.
* Плагин пишет только четыре своих ключа; посторонние ключи в файле сохраняются.
* **Пароль лежит открытым текстом.** Не коммитьте файл в git и не публикуйте проект,
  если в нём есть учётные данные.

## Установка

Требуется dsh ≥ 0.1.2-rc.1 (вкладка использует слот `settings.section`).

```bash
# из папки плагина (режим разработки, link — правки видны после перезапуска dsh)
dsh plugin --profile web add /путь/к/dsh-1c-project-properties

# из собранного архива
dsh plugin --profile web add ./dsh-1c-project-properties-0.1.0.tgz

# из GitHub release
dsh plugin --profile web add https://github.com/Mempemp/DSH-1CProjectProperties/releases/download/v0.1.0/dsh-1c-project-properties-0.1.0.tgz
```

На Windows-профиле с нестандартным pnpm-store команда может потребовать
`--store-dir="<путь к стору>"` (dsh передаёт аргументы pnpm дословно).

После установки: перезапустить `dsh web` (хост-половина) и обновить страницу в браузере
(клиентская половина). Проверка:

```bash
dsh --profile web --dump-config | grep 1c-project-properties
curl -s http://127.0.0.1:3080/1cprops/state | head -c 200
```

## HTTP-роуты

Все ответы — JSON. Роуты нужны в первую очередь клиентской половине, но ими можно
пользоваться из других плагинов, агентов и скриптов.

| Метод и путь | Назначение |
|---|---|
| `GET /1cprops/state` | общие настройки, список проектов, найденные платформы 1С |
| `POST /1cprops/common` | `{platformPath}` — сохранить общее значение |
| `POST /1cprops/project-save` | `{path, params}` — записать файл параметров проекта |
| `GET /1cprops/project?path=…` | действующие параметры проекта (с подстановкой общего пути к платформе) |
| `POST /1cprops/project-clear` | `{path}` — удалить файл параметров |
| `POST /1cprops/project-add` | `{path}` — добавить папку в список проектов |
| `POST /1cprops/project-forget` | `{path}` — убрать дополнительный путь из списка |

Пример для внешнего потребителя:

```bash
curl -s "http://127.0.0.1:3080/1cprops/project?path=D:%5CWork%5Chrm1"
```

## Структура плагина

```
package.json          dsh.bundle.patch → cordis.patch.yml; dsh.client → lib/client.js
cordis.patch.yml      одна строка insert: монтирует плагин в композицию профиля
lib/index.js          хост: роуты /1cprops/*, чтение и запись JSON, поиск платформ 1С
lib/client.js         браузер: секция settings.section («1С: параметры»)
```

Хост-половина — ESM с `export { name, inject, apply }`, `inject = ["webServer", "workspaceRegistry"]`.
Клиентская — модуль для `window.__ModuleLoader__` с `factory(require)` и `return { apply, inject: ["slots"] }`.
Внешних зависимостей нет: только `node:*` и React из профиля.

## Лицензия

MIT
