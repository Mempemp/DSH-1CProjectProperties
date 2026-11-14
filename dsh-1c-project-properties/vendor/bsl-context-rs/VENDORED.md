# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.24.1` (09.11.2026) |
| Ассет | `bsl-context-windows-x64.zip` |
| sha256 ассета | `1986343d89af0cd1e09378982a5fcfef027d299d5571c9fa82ea61f15d4415d6` |
| sha256 `bsl-context-rs.exe` | `2a4f557736c9855ab8ba88337da20555b6c3f5eb6d2df4c40ecb0738fcf27500` |
| Размер `bsl-context-rs.exe` | 15 587 328 байт |
| Лицензия | MIT (см. `LICENSE`), часть кода портирована из `alkoleft/mcp-bsl-platform-context` (MIT) |

Обновление: заменить `bsl-context-rs.exe` (и `LICENSE` / `README_RU.md` /
`CHANGELOG.md` рядом) файлами из нового релиза, затем обновить эту таблицу и
хеши. Раскладка архива между релизами меняется: до 0.22 включительно файлы лежали в
`bsl-context-<версия>-<target>/`, с 0.23 — в `bsl-context-windows-x64/` (без версии в
имени каталога), а имя самого ассета раньше было
`bsl-context-v0.20.0-x86_64-pc-windows-msvc.zip` — поэтому версия берётся из тега,
а не из пути. Проверка целостности после распаковки:

```bash
sha256sum vendor/bsl-context-rs/bsl-context-rs.exe
```
