# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.19.1` (19.09.2026) |
| Ассет | `bsl-context-v0.19.1-x86_64-pc-windows-msvc.zip` |
| sha256 ассета | `8ec743268337e3ab2bd9106bd24bfcd40bdbaca91d208a04a1ad1706626a3a05` |
| sha256 `bsl-context-rs.exe` | `eff0b5e09470b9633190e44c1d3ef016175109b1e11354cf00f6620783d38bd1` |
| Размер `bsl-context-rs.exe` | 12 705 792 байта |
| Лицензия | MIT (см. `LICENSE`), часть кода портирована из `alkoleft/mcp-bsl-platform-context` (MIT) |

Обновление: заменить `bsl-context-rs.exe` (и `LICENSE` / `README_RU.md` /
`CHANGELOG.md` рядом) файлами из нового релиза, затем обновить эту таблицу и
хеши. В архивах релиза файлы лежат во вложенном каталоге
`bsl-context-<версия>-<target>/`, а не в корне. Проверка целостности после
распаковки:

```bash
sha256sum vendor/bsl-context-rs/bsl-context-rs.exe
```
