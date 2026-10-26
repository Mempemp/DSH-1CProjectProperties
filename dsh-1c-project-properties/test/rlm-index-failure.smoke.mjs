// Отказ индексации: причина в карточке и отсутствие потока повторных сборок.
//
// Регрессия на то, что человек видел в интерфейсе на живом проекте:
//   «Последняя попытка 26.10.2026, 17:26:51 завершилась ошибкой: index завершился с
//    кодом 1» — при том что движок сказал понятное: «Формат исходников не распознан
//    как cf или edt, и ни одного .bsl-файла в дереве не найдено».
// В журнале рядом лежал второй дефект: сборка повторялась каждые ~1.2 секунды, потому
// что неудача снимала защиту «уже запускали в этой сессии», а карточка опрашивает
// состояние раз в секунду.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { indexFailureIsPermanent, indexFailureReason } = await import(
  pathToFileURL(resolve(here, "..", "lib", "rlm-runner.js")).href
);

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + extra : ""));
  if (!ok) fails++;
};

// ── причина берётся словами движка, а не кодом возврата ───────────────────
const engineLines = [
  "index build C:\\Users\\A.Sizyh\\Desktop\\Рэбот\\Типа проекты\\ЗУП",
  "Error: Формат исходников не распознан как cf или edt, и ни одного .bsl-файла в дереве не найдено (либо дерево недоступно для чтения) — индекс строить не по чему.",
];
check(
  "причина = текст движка",
  indexFailureReason(engineLines) ===
    "Формат исходников не распознан как cf или edt, и ни одного .bsl-файла в дереве не найдено (либо дерево недоступно для чтения) — индекс строить не по чему.",
  indexFailureReason(engineLines).slice(0, 60),
);
check(
  "английская метка тоже снимается",
  indexFailureReason(["Error: index not found. Run 'index build' first."]) === "index not found. Run 'index build' first.",
);
check("без метки берётся последняя строка", indexFailureReason(["строка 1", "последняя причина"]) === "последняя причина");
check("пусто — пустая причина", indexFailureReason([]) === "");
check("длинная причина обрезается", indexFailureReason(["Error: " + "я".repeat(900)]).length === 400);
// Причина не должна терять кириллицу и тире — раньше в карточку попадал только код.
check("кириллица в причине целая", /Формат исходников/.test(indexFailureReason(engineLines)));

// ── детерминированный отказ не повторяется, отказ среды — повторяется ─────
const permanent = [
  "Формат исходников не распознан как cf или edt, и ни одного .bsl-файла в дереве не найдено (либо дерево недоступно для чтения) — индекс строить не по чему.",
  "index not found. Run 'index build' first.",
  "rlm-bsl-index не найден: установите rlm-tools-bsl",
  "папка выгрузки не найдена: C:\\нет\\такой\\папки — поправьте путь в параметрах проекта",
  "папка проекта не найдена: C:\\нет\\такой\\папки",
];
for (const text of permanent) {
  check("не повторяем: " + text.slice(0, 46), indexFailureIsPermanent(text) === true);
}
const temporary = [
  "таймаут: 45 мин",
  "git status не отвечает",
  "EPERM: operation not permitted, rename index.db",
  "index завершился с кодом 1, причину движок не назвал",
];
for (const text of temporary) {
  check("повторяем при следующем опросе: " + text.slice(0, 40), indexFailureIsPermanent(text) === false);
}

// ── автосборка не может снова и снова запускать сборку после отказа ───────
// Проверяется по исходнику: решение принимается в одном месте, и в ветке отказа нет
// безусловного удаления из набора «уже собирали в этой сессии».
const source = readFileSync(resolve(here, "..", "lib", "rlm-runner.js"), "utf8");
check(
  "защита от повторов остаётся при детерминированном отказе",
  /if \(indexFailureIsPermanent\(job\.error\)\) \{[\s\S]{0,200}?autoStopped\.set\(key[\s\S]{0,120}?return;/.test(source),
);
check(
  "повтор возможен только для отказов среды",
  /\/\/ Остальное \(таймаут, занятый файл, диск\)[\s\S]{0,120}?indexAutoOpened\.delete\(key\);/.test(source),
);
check("состояние отдаёт признак остановки", /autoStopped: path \?/.test(source));
check("ручной запуск снимает остановку", /if \(options\.auto !== true\) rt\.index\.autoStopped\.delete/.test(source));

console.log(fails ? `\n${fails} FAIL` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
