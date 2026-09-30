# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.20.0` (30.09.2026) |
| Ассет | `bsl-context-v0.20.0-x86_64-pc-windows-msvc.zip` |
| sha256 ассета | `2f713f5dd0f66fe8734b18bc6e78bebd8a04e8aba420b44f8ab20f17289444bd` |
| sha256 `bsl-context-rs.exe` | `00c0410bc8c0517a448fa8d7cc1b7cdb0a88239c3ef6aab458c022f4a135ac61` |
| Размер `bsl-context-rs.exe` | 14 433 280 байт |
| Лицензия | MIT (см. `LICENSE`), часть кода портирована из `alkoleft/mcp-bsl-platform-context` (MIT) |

Обновление: заменить `bsl-context-rs.exe` (и `LICENSE` / `README_RU.md` /
`CHANGELOG.md` рядом) файлами из нового релиза, затем обновить эту таблицу и
хеши. В архивах релиза файлы лежат во вложенном каталоге
`bsl-context-<версия>-<target>/`, а не в корне. Проверка целостности после
распаковки:

```bash
sha256sum vendor/bsl-context-rs/bsl-context-rs.exe
```
