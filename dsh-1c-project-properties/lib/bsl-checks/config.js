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
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const CONFIG_DIR = ".dsh/bsl-checks";
// Имя файла — то, которое анализатор ищет сам: MCP-сервер в режиме stdio
// не принимает --config и читает конфигурацию из каталога проекта.
export const CONFIG_FILE = CONFIG_DIR + "/bsl-analyzer.toml";

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
