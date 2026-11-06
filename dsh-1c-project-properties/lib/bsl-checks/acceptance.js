// Принятые замечания проекта.
//
// Штатная базовая линия анализатора к сдвигу строк не устойчива: после одной
// добавленной строки сверху уже принятые замечания снова приходят как новые
// (проверено на живом движке — три из четырёх). Поэтому принятие ведём сами и
// сопоставляем по коду правила, пути файла и тексту строки, без номера строки.
//
// Хранилище проектное: <проект>/.dsh/bsl-checks/accepted.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STORE_REL = ".dsh/bsl-checks/accepted.json";

const MAX_ITEMS = 20000;

/** Текст строки в устойчивом виде: пробелы схлопнуты, регистр сохранён. */
export function normalizeSnippet(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ключ замечания: код + путь + текст строки + номер одинакового срабатывания. */
export function findingKey(finding, occurrence = 0) {
  return [finding.code, finding.path, normalizeSnippet(finding.snippet), occurrence].join("|");
}

function storePath(projectRoot) {
  return join(projectRoot, STORE_REL);
}

export function loadAccepted(projectRoot) {
  const file = storePath(projectRoot);
  if (!existsSync(file)) return { version: 1, items: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(raw?.items) ? raw.items.filter((item) => item && typeof item.k === "string") : [];
    return { version: 1, items };
  } catch {
    // Битый файл считается пустым: проверка покажет всё как новое, но ничего
    // не стирает и не падает.
    return { version: 1, items: [], error: "файл принятых замечаний не прочитан" };
  }
}

export function saveAccepted(projectRoot, store) {
  const file = storePath(projectRoot);
  mkdirSync(join(projectRoot, ".dsh/bsl-checks"), { recursive: true });
  const items = store.items.slice(-MAX_ITEMS);
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 0) + "\n", "utf8");
  renameSync(tmp, file);
}

/**
 * Разметить находки как новые или принятые.
 *
 * occurrence считается внутри файла по порядку строк: два одинаковых замечания
 * в одном файле остаются различимыми, а сдвиг строк на них не влияет.
 *
 * @returns {{ findings: object[], acceptedKeys: Set<string> }}
 */
export function markFindings(findings, store) {
  const acceptedKeys = new Set(store.items.map((item) => item.k));
  const counters = new Map();
  const out = findings.map((finding) => {
    const base = finding.code + "|" + finding.path + "|" + normalizeSnippet(finding.snippet);
    const occurrence = counters.get(base) || 0;
    counters.set(base, occurrence + 1);
    const key = findingKey(finding, occurrence);
    return { ...finding, key, accepted: acceptedKeys.has(key) };
  });
  return { findings: out, acceptedKeys };
}

/**
 * Принять перечисленные находки (по ключам) и убрать из хранилища записи,
 * которых больше нет в коде проверенных файлов.
 *
 * @param {{ projectRoot: string, findings: object[], keys?: string[], by?: string, prunePaths?: string[] }} options
 */
export function acceptFindings({ projectRoot, findings, keys, by = "user", prunePaths = [] }) {
  const store = loadAccepted(projectRoot);
  const known = new Map(store.items.map((item) => [item.k, item]));
  const wanted = keys && keys.length ? new Set(keys) : null;
  // Ключи обычно приходят готовыми из проверки. Если вызывающий передал голые
  // находки, считаем их сами — иначе в хранилище попадёт запись без ключа.
  const prepared = findings.every((item) => typeof item.key === "string")
    ? findings
    : markFindings(findings, store).findings;
  const findingsForPrune = prepared;
  let added = 0;
  for (const finding of prepared) {
    if (wanted && !wanted.has(finding.key)) continue;
    if (known.has(finding.key)) continue;
    known.set(finding.key, {
      k: finding.key,
      code: finding.code,
      path: finding.path,
      snippet: normalizeSnippet(finding.snippet),
      at: new Date().toISOString(),
      by,
    });
    added += 1;
  }
  // Чистка по файлам имеет смысл только когда проверка действительно вернула
  // находки. Вызов «принять по ключам» без находок не должен стирать хранилище.
  if (prunePaths.length && prepared.length) {
    const present = new Set(findingsForPrune.filter((item) => prunePaths.includes(item.path)).map((item) => item.key));
    for (const [key, item] of known) {
      if (prunePaths.includes(item.path) && !present.has(key)) known.delete(key);
    }
  }
  store.items = [...known.values()];
  saveAccepted(projectRoot, store);
  return { ok: true, added, total: store.items.length };
}

/** Вернуть принятые: конкретные ключи, файл целиком или всё. */
export function restoreFindings({ projectRoot, keys, path: filePath, all = false }) {
  const store = loadAccepted(projectRoot);
  const before = store.items.length;
  if (all) store.items = [];
  else if (keys && keys.length) {
    const drop = new Set(keys);
    store.items = store.items.filter((item) => !drop.has(item.k));
  } else if (filePath) {
    store.items = store.items.filter((item) => item.path !== filePath);
  }
  saveAccepted(projectRoot, store);
  return { ok: true, removed: before - store.items.length, total: store.items.length };
}
