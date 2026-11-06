// Чтение и запись параметров проекта — то немногое, что проверкам нужно от
// файла .dsh/1c-project.json. Ключи добавляются к существующим, остальные
// поля не трогаются.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PARAMS_REL = ".dsh/1c-project.json";

export function paramsFile(projectPath) {
  return join(projectPath, PARAMS_REL);
}

export function readParams(projectPath) {
  const file = paramsFile(projectPath);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) || {};
  } catch {
    return {};
  }
}

export function patchParams(projectPath, patch) {
  const file = paramsFile(projectPath);
  // Проект может включаться агентом до того, как плагин создал .dsh.
  mkdirSync(join(projectPath, ".dsh"), { recursive: true });
  const next = { ...readParams(projectPath), ...patch };
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return next;
}

/**
 * Проверки включены и выгрузка задана — без этого проверять нечего.
 *
 * По умолчанию выключено: пока пользователь не поставил галочку, ни проверка
 * файлов, ни проверка кода до записи не запускаются и движок не скачивается.
 */
export function checksReady(projectPath) {
  const params = readParams(projectPath);
  return {
    params,
    enabled: params.checksEnabled === true,
    dumpDir: typeof params.dumpDir === "string" ? params.dumpDir : "",
  };
}
