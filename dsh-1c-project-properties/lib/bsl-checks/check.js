// Проверка файлов и сборка результата для интерфейса и агента.
//
// Сценарий один: агент правит файл и просит проверить именно его. Полного
// обхода проекта по расписанию нет, отдельной кнопки «проверить всё» нет.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { markFindings, acceptFindings, loadAccepted } from "./acceptance.js";
import { syncResidentConfig, writeConfig } from "./config.js";
import { ensureEngine, resolveBinary, runAnalyze } from "./engine.js";
import { checkFilesResident } from "./snippet.js";
import { dropSymbolDependent, metadataState } from "./metadata.js";

// Последний результат проверки: панель в боковой колонке показывает его без
// запуска анализа. Хранится в проекте, как и принятые замечания.
const LAST_REL = ".dsh/bsl-checks/last.json";

export function loadLast(projectRoot) {
  const file = join(projectRoot, LAST_REL);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveLast(projectRoot, result, dumpRoot) {
  const file = join(projectRoot, LAST_REL);
  mkdirSync(join(projectRoot, ".dsh/bsl-checks"), { recursive: true });
  const payload = {
    checkedAt: result.checkedAt,
    elapsedSecs: result.elapsedSecs,
    presetId: result.presetId,
    dumpDir: dumpRoot,
    counts: result.counts,
    metadata: result.metadata,
    files: result.files.map((file) => ({
      path: file.path,
      passed: file.passed,
      hidden: file.hidden,
      findings: file.findings.slice(0, 500).map((finding) => ({
        key: finding.key,
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        line: finding.line,
        column: finding.column,
        accepted: finding.accepted,
      })),
    })),
  };
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function posix(value) {
  return value.split("\\").join("/");
}

function stripLongPath(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

// Анализатор отдаёт пути со смешанными разделителями (C:/dir\file.bsl),
// поэтому сравниваем их и считаем относительные только по прямым слэшам.
function normPath(value) {
  return stripLongPath(value).split("\\").join("/");
}

function samePath(a, b) {
  return normPath(a).toLowerCase() === normPath(b).toLowerCase();
}

function relativeTo(root, target) {
  return posix(relative(root, target) || target);
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Проверить перечисленные файлы проекта.
 *
 * projectRoot — где живут наши служебные файлы (.dsh/bsl-checks),
 * dumpRoot — каталог выгрузки, с ним работает анализатор.
 *
 * @param {{
 *   projectRoot: string,
 *   dumpRoot: string,
 *   preset: { id: string, off: string[] },
 *   files?: string[],
 *   by?: string,
 *   autoAccept?: boolean,
 *   timeoutMs?: number
 * }} options
 */
export async function checkFiles(options) {
  const { projectRoot, dumpRoot, preset } = options;
  const wanted = (options.files || []).map((file) =>
    isAbsolute(file) ? resolve(file) : resolve(dumpRoot, file)
  );

  let binary = resolveBinary();
  if (!binary) {
    const downloaded = await ensureEngine();
    if (!downloaded.ok) return { ok: false, error: downloaded.error };
    binary = downloaded.binary;
  }

  const configFile = writeConfig({ projectRoot, dumpRoot, off: preset.off });
  // Резидентный сервер читает конфигурацию из корня выгрузки, а не из пакета плагина.
  const rulesConfig = syncResidentConfig({ dumpRoot, off: preset.off });
  const relativeFiles = wanted.map((file) => relativeTo(dumpRoot, file));

  // Файлы проверяет резидентный сервер: конфигурация загружается один раз, и
  // повторная проверка стоит десятки миллисекунд вместо секунды на процесс.
  // Командная строка остаётся запасным путём (и единственным, если резидента
  // нет) — она перезагружает конфигурацию на каждом вызове.
  let run = null;
  let fromResident = false;
  if (relativeFiles.length) {
    const resident = await checkFilesResident({
      binary,
      sourceDir: dumpRoot,
      files: relativeFiles,
      off: preset.off,
      timeoutMs: options.timeoutMs,
    });
    if (resident.ok) {
      const findings = [];
      for (const entry of resident.files) {
        const absolute = resolve(dumpRoot, entry.path);
        for (const finding of entry.findings) {
          findings.push({
            code: finding.code,
            message: finding.message,
            severity: finding.severity,
            start_line: finding.line - 1,
            start_column: finding.column - 1,
            path: absolute,
          });
        }
      }
      run = { ok: true, findings, elapsedSecs: (resident.elapsedMs || 0) / 1000 };
      fromResident = true;
    }
  }

  if (!run) {
    run = await runAnalyze({
      binary,
      sourceDir: dumpRoot,
      configFile,
      files: relativeFiles.length ? relativeFiles : undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  // Если фильтр по изменённым файлам посчитан от другого корня, ответ будет
  // пустым: повторяем полный прогон и сужаем результат сами.
  if (!fromResident && run.ok && wanted.length && !run.findings.length) {
    const full = await runAnalyze({ binary, sourceDir: dumpRoot, configFile, timeoutMs: options.timeoutMs });
    if (full.ok) run = full;
  }
  if (!run.ok) return { ok: false, error: run.error || "проверка не удалась", stderr: run.stderr };

  const wantedSet = new Set(wanted.map((file) => normPath(file).toLowerCase()));
  const files = new Map();
  for (const raw of run.findings) {
    const absolute = stripLongPath(raw.path);
    if (wanted.length && !wantedSet.has(normPath(absolute).toLowerCase())) continue;
    const relPath = relativeTo(dumpRoot, absolute);
    const lines = readLines(absolute);
    const snippet = lines[raw.start_line] || "";
    if (!files.has(relPath)) files.set(relPath, { path: relPath, findings: [] });
    files.get(relPath).findings.push({
      code: raw.code,
      message: raw.message,
      severity: raw.severity,
      line: Number(raw.start_line) + 1,
      column: Number(raw.start_column) + 1,
      path: relPath,
      snippet,
    });
  }

  // Прогон без символов даёт ложные «неизвестный метод» и «нет метаданных»:
  // такие находки снимаем сами, движок об этом только предупреждает в stderr.
  const metadata = metadataState({ dumpRoot, stderr: run.stderr });
  let droppedByMetadata = 0;
  if (!metadata.symbolsAvailable) {
    const filtered = dropSymbolDependent(run.findings);
    run.findings = filtered.findings;
    droppedByMetadata = filtered.dropped;
  }

  const store = loadAccepted(projectRoot);
  const all = [];
  for (const file of files.values()) {
    file.findings.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
    const marked = markFindings(file.findings, store);
    file.findings = marked.findings;
    all.push(...marked.findings);
  }

  // Порога по важности нет: что профиль включил, то и показываем.
  const counts = {
    total: all.length,
    new: all.filter((finding) => !finding.accepted).length,
    accepted: all.filter((finding) => finding.accepted).length,
    all: all.length,
  };

  const result = {
    ok: true,
    presetId: preset.id,
    checkedAt: new Date().toISOString(),
    elapsedSecs: run.elapsedSecs,
    files: [...files.values()].map((file) => ({
      path: file.path,
      passed: file.findings.length === 0,
      findings: file.findings,
      hidden: 0,
    })),
    counts,
    findings: all,
    warnings: rulesConfig.ok ? [] : [rulesConfig.error],
    metadata: { ...metadata, droppedByMetadata },
  };

  saveLast(projectRoot, result, dumpRoot);

  if (options.autoAccept && counts.new) {
    const accepted = acceptFindings({
      projectRoot,
      findings: visible,
      by: options.by || "agent",
      prunePaths: [...files.keys()],
    });
    result.acceptedNow = accepted.added;
  }

  return result;
}

/** Проверить один файл. */
export function checkFile(options) {
  return checkFiles({ ...options, files: [options.file] });
}

export function acceptanceCount(projectRoot) {
  return loadAccepted(projectRoot).items.length;
}

export function dumpRootExists(dumpRoot) {
  return Boolean(dumpRoot) && existsSync(dumpRoot);
}

export { samePath, normPath };
