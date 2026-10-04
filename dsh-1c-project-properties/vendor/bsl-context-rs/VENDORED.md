# Откуда взялся бинарник

`bsl-context-rs.exe` — сторонний исполняемый файл, поставляется в этом плагине без
изменений. Взято из релиза:

| Поле | Значение |
| --- | --- |
| Проект | https://github.com/Regsorm/bsl-context |
| Релиз | `v0.21.5` (03.10.2026) |
| Ассет | `bsl-context-windows-x64.zip` |
| sha256 ассета | `ff2270e9ea24da3a9c07c7780f14d132fbf8ff28247daf70c32fdd0f5bddbf1f` |
| sha256 `bsl-context-rs.exe` | `041fb7012a130fc35967d70f91128924689c52094f0ed54988ac6bbcb41ac387` |
| Размер `bsl-context-rs.exe` | 14 500 864 байт |
| Лицензия | MIT (см. `LICENSE`), часть кода портирована из `alkoleft/mcp-bsl-platform-context` (MIT) |

Обновление: заменить `bsl-context-rs.exe` (и `LICENSE` / `README_RU.md` /
`CHANGELOG.md` рядом) файлами из нового релиза, затем обновить эту таблицу и
хеши. В архивах релиза файлы лежат во вложенном каталоге
`bsl-context-<версия>-<target>/`, а не в корне; имя самого ассета между
релизами меняется (`bsl-context-v0.20.0-x86_64-pc-windows-msvc.zip` →
`bsl-context-windows-x64.zip`), поэтому версия берётся из тега, а не из имени
файла. Проверка целостности после распаковки:

```bash
sha256sum vendor/bsl-context-rs/bsl-context-rs.exe
```
