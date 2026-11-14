# 0.15.10

## Сервер справки обновлён до bsl-context v0.24.1

`vendor/bsl-context-rs/bsl-context-rs.exe` — сборка из релиза `v0.24.1`
(09.11.2026), лицензия MIT. Рядом лежат `LICENSE`, `README_RU.md`,
`CHANGELOG.md` того же релиза.

| Поле | Значение |
| --- | --- |
| Ассет | `bsl-context-windows-x64.zip` |
| sha256 ассета | `1986343d89af0cd1e09378982a5fcfef027d299d5571c9fa82ea61f15d4415d6` |
| sha256 `bsl-context-rs.exe` | `2a4f557736c9855ab8ba88337da20555b6c3f5eb6d2df4c40ecb0738fcf27500` |
| Размер `bsl-context-rs.exe` | 15 587 328 байт |

Таблица происхождения в `vendor/bsl-context-rs/VENDORED.md` и раздел о
структуре в `README.md` называют релиз `v0.24.1`.

## Контракт инструментов совпадает с v0.23.1

Сверка снята с двух бинарников: `initialize` и `tools/list` на старом и новом
(`probe`, MCP 2025-06-18, streamable-http на loopback, конфиг без
`platform_path`).

- 14 инструментов, имена те же: `search`, `info`, `get_member`, `get_members`,
  `get_constructors`, `get_enum_values`, `validate_enum`,
  `validate_method_call`, `validate_module`, `reserved_names`,
  `rebuild_symbol_index`, `symbol_sources_status`, `reconnect_symbol_source`,
  `reload_config`.
- Наборы аргументов (`inputSchema.properties`) и обязательные поля у всех 14
  совпадают с v0.23.1; правило `playbook/platform.md` перечисляет те же имена и
  те же аргументы.
- `default_validation_level`, `host`, `port`, `platform_path`, `log_dir`,
  `log_level` — ключи конфига, который пишет `lib/platform-context.js`, сервер
  v0.24.1 принимает; ответ `/health` сохраняет поля `status`, `version`,
  `index_loaded`, `index_stats`, `unavailable_reason`.

Расхождение одно — текст описания `validate_module` и состав его находок:

- добавлен вид находки `unavailable_in_context`: платформенный метод, метод
  типа или конструктор вызван в контексте выполнения (сервер, тонкий клиент,
  веб-клиент, толстый клиент, внешнее соединение), где справка его не
  описывает. Уверенность `high`, в части «толстого клиента» — `medium`;
- поле `confidence` получило третье значение `medium`; набор значений —
  `high`, `medium`, `low`;
- в ответах инструментов появилась строка `**Доступность:** …`;
- формат кэша платформенного индекса — 4. Кэш формата 3 отбрасывается, индекс
  собирается из `shcntx_ru.hbk` при первом запуске; путь кэша и его раскладку
  плагин не задаёт и не читает.

## Проверки

- 16 наборов `node test/<файл>.smoke.mjs`, у каждого код возврата 0, 474 отметки
  `ok`/`PASS`, падений нет.
- `test/platform-context.smoke.mjs` — на платформе 8.3.27.2130 с новым
  бинарником: старт без пути, старт с платформой, сборка индекса, `tools/list`
  по MCP (`search`, `get_members`), повторный запуск, перезапуск, остановка.
- `test/platform-context-host.smoke.mjs` — регистрация в MCP-менеджере,
  перезапуск после смены общего пути к платформе, снятие с учёта.
- `lib/platform-context.js` на вендоренном бинарнике с платформой 8.3.27.2130:
  в статусе `version = 0.24.1`, индекс собран (500 глобальных методов,
  100 глобальных свойств, 2414 типа, 675 перечислений), `tools/list` отдаёт
  14 имён, остановка снимает процесс.
