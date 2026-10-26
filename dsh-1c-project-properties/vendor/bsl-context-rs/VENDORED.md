# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.23.1` (23.10.2026) |
| Ассет | `bsl-context-windows-x64.zip` |
| sha256 ассета | `147c2c30f8fe1406ddbee274e08aa292e730979f7dc9dafa5228c38bb9e48477` |
| sha256 `bsl-context-rs.exe` | `0581cc59b5a5bfce9b34e3c49a000146c746f4c00619e7b38298bbe684937a0d` |
| Размер `bsl-context-rs.exe` | 15 386 112 байт |
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
