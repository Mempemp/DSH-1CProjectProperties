// Служебный конфиг анализатора.
//
// Файл целиком наш: его генерирует плагин при каждой проверке, править руками
// не нужно и нечего. Пользовательские настройки живут в .dsh/1c-project.json
// (включено, набор) и в $DSH_HOME (свои наборы), а не здесь.
//
// Справка платформы берётся встроенная (bundled): она не требует установленной
// 1С, не строит второй кеш и даёт тот же результат проверок, что и разбор
// синтакс-помощника. Текстовые описания остаются у MCP-сервера платформенного
// контекста, которому они и нужны.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { catalog } from "./catalog.js";
import { isAbsolute, join, relative } from "node:path";

export const CONFIG_DIR = ".dsh/bsl-checks";
// Имя файла — то, которое анализатор ищет сам: MCP-сервер в режиме stdio
// не принимает --config и читает конфигурацию из каталога проекта.
export const CONFIG_FILE = CONFIG_DIR + "/bsl-analyzer.toml";

// Резидентный сервер ищет конфигурацию не в каталоге проекта, а в корне
// выгрузки — рядом с Configuration.xml. Список включённых правил живёт там,
// иначе профиль до анализатора не доходит.
export const RESIDENT_CONFIG_FILE = "bsl-analyzer.toml";
const RESIDENT_MARKER = "# Сгенерировано dsh-1c-project-properties";

/** Правила, которые анализатор держит выключенными, а профиль включает. */
export function rulesToEnable(off = []) {
  const offSet = new Set(off);
  return catalog()
    .filter((rule) => rule.enabled === false && !offSet.has(rule.code))
    .map((rule) => rule.code)
    .sort();
}

/**
 * Приводит `<выгрузка>/bsl-analyzer.toml` к состоянию профиля.
 * Файл нужен только для правил, выключенных в анализаторе по умолчанию:
 * остальные работают сами, а `off` отсекается после ответа.
 */
export function syncResidentConfig({ dumpRoot, off = [] }) {
  if (!dumpRoot) return { ok: true, written: false, enabled: [] };
  const file = join(dumpRoot, RESIDENT_CONFIG_FILE);
  const enabled = rulesToEnable(off);
  const ours = existsSync(file) && readFileSync(file, "utf8").includes(RESIDENT_MARKER);
  if (!enabled.length) {
    if (ours) rmSync(file, { force: true });
    return { ok: true, written: false, enabled: [] };
  }
  if (existsSync(file) && !ours) {
    return {
      ok: false,
      written: false,
      enabled,
      error:
        "в корне выгрузки есть свой bsl-analyzer.toml — правила, выключенные в анализаторе по умолчанию, "
        + "включатся только после того, как вы добавите их туда сами",
    };
  }
  const body = [
    RESIDENT_MARKER + ": список правил, которые анализатор выключает по умолчанию,",
    "# а профиль включает. Файл перезаписывается при каждой проверке.",
    "",
    "[diagnostics.parameters]",
    ...enabled.map((code) => code + " = true"),
    "",
  ].join("\n");
  writeFileSync(file, body, "utf8");
  return { ok: true, written: true, enabled };
}

function posix(value) {
  return value.split("\\").join("/");
}

/** Путь выгрузки как его видит анализатор: относительный, если внутри проекта. */
export function sourceRoot(projectRoot, dumpRoot) {
  const rel = relative(projectRoot, dumpRoot);
  if (!rel || rel === "") return ".";
  if (isAbsolute(rel) || rel.startsWith("..")) return posix(dumpRoot);
  return posix(rel);
}

/**
 * @param {{ projectRoot: string, dumpRoot: string, off?: string[] }} options
 * @returns {string} текст bsl-analyzer.toml
 */
export function renderConfig({ projectRoot, dumpRoot, off = [] }) {
  const lines = [
    "# Сгенерировано dsh-1c-project-properties. Правки будут перезаписаны.",
    "[platform_help]",
    'source = "bundled"',
    "",
    "[source]",
    'root = "' + sourceRoot(projectRoot, dumpRoot) + '"',
  ];
  if (off.length) {
    lines.push("", "[diagnostics.parameters]");
    for (const code of [...new Set(off)].sort()) lines.push(code + " = false");
  }
  return lines.join("\n") + "\n";
}

/** Записать конфиг в проект; возвращает путь к файлу. */
export function writeConfig({ projectRoot, dumpRoot, off }) {
  const dir = join(projectRoot, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(projectRoot, CONFIG_FILE);
  const body = renderConfig({ projectRoot, dumpRoot, off });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
  return file;
}
