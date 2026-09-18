# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.18.1` (09.09.2026) |
| Ассет | `bsl-context-v0.18.1-x86_64-pc-windows-msvc.zip` |
| sha256 ассета | `2a958b8f6242e5d34d24004e9cc4c9778bd74860f7049d6dd3de97702dfb79b0` |
| sha256 `bsl-context-rs.exe` | `aa59902cfdc2ea258d26c0567d5593d35f2149d2d521d76af253b5c70b0c6f92` |
| Лицензия | MIT (см. `LICENSE`), часть кода портирована из `alkoleft/mcp-bsl-platform-context` (MIT) |

Обновление: заменить `bsl-context-rs.exe` (и `LICENSE` / `README_RU.md` /
`CHANGELOG.md` рядом) файлами из нового релиза, затем обновить эту таблицу и
хеши. Проверка целостности после распаковки:

```bash
sha256sum vendor/bsl-context-rs/bsl-context-rs.exe
```
