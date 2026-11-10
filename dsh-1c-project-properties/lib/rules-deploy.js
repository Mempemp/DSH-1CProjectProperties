// Раскладка правил в проект.
//
// Разворачивается один слой: AGENTS.md, плейбуки в `.dsh/rules-own/`,
// USER-RULES.md и справка environment.md. Файлы, которые уже лежат в проекте,
// плагин не удаляет: повторная раскладка не затирает правки пользователя.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── раскладка ───────────────────────────────────────────────────────────────

export const OWN_DIR_REL = ".dsh/rules-own";
export const MANIFEST_REL = ".dsh/1c-rules.json";
export const ENVIRONMENT_REL = OWN_DIR_REL + "/environment.md";

/** Плейбуки плагина: шапка AGENTS.md, USER-RULES.md, справка — рядом с lib/. */
const PLAYBOOK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "playbook");

const MANIFEST_FORMAT = "dsh-1c-rules-deploy";
const MANIFEST_FORMAT_VERSION = 4;
const MANAGED_MARK = "<!-- managed by dsh-1c-project-properties: 1c-rules -->";
const MIGRATION_START = "<!-- 1c-rules:migrated:start -->";
const MIGRATION_END = "<!-- 1c-rules:migrated:end -->";

/** Файлы, которые плагин создаёт один раз и после этого не трогает. */
const PROTECTED_FILES = Object.freeze(["USER-RULES.md", "memory.md", "LLM-RULES.md"]);

const USER_RULES_FALLBACK = [
  "# Правила проекта",
  "",
  "Свои правила проекта. Файл не перезаписывается плагином: пишите здесь, а не в `AGENTS.md`.",
  "",
].join("\n");

// ── утилиты ─────────────────────────────────────────────────────────────────

// ── утилиты ─────────────────────────────────────────────────────────────────

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function posix(value) {
  return value.split("\\").join("/");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Битый JSON в пользовательском файле не должен ронять развёртывание. */
function readJson(file) {
  const text = readText(file);
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(posix(relative(base, full)));
  }
  return out.sort();
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(from));
}

function removeEmptyDirs(dir, stopAt) {
  let current = resolve(dir);
  const stop = resolve(stopAt);
  while (current.startsWith(stop) && current !== stop) {
    try {
      if (readdirSync(current).length === 0) {
        rmSync(current, { recursive: true, force: true });
        current = dirname(current);
        continue;
      }
    } catch {
      // пустая или уже удалённая папка — не причина падать
    }
    break;
  }
}

function configuredServers(dshHome) {
  const names = new Set();
  for (const file of [join(dshHome, "mcp-servers.json"), join(dshHome, "dsh-mcp.json")]) {
    const parsed = readJson(file);
    const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
    for (const server of servers) {
      const name = server?.serverName ?? server?.name ?? server?.id;
      if (typeof name === "string" && name.trim() !== "") names.add(name.trim());
    }
  }
  return [...names].sort();
}

// ── журнал и манифест ───────────────────────────────────────────────────────

class Journal {
  constructor(dryRun) {
    this.dryRun = dryRun;
    this.files = [];
    this.notes = [];
    this.warnings = [];
    this.counts = { written: 0, unchanged: 0, preserved: 0, removed: 0 };
  }

  add(path, status, detail) {
    this.files.push(detail === undefined ? { path, status } : { path, status, detail });
    if (status in this.counts) this.counts[status] += 1;
  }

  note(text) {
    this.notes.push(text);
  }

  warn(text) {
    this.warnings.push(text);
  }

  /** Вернул true — файл записан (или был бы записан при dryRun). */
  putFile(file, targetRel, text, trackedDigest, options = {}) {
    const digest = sha256(text);
    if (isFile(file)) {
      const current = readFileSync(file, "utf8");
      if (current === text) {
        this.add(targetRel, "unchanged");
        return { digest, written: false };
      }
      if (options.managed !== true) {
        if (trackedDigest !== undefined && sha256(current) !== trackedDigest) {
          this.add(targetRel, "preserved", "файл изменён пользователем — оставлен как есть");
          return { digest: trackedDigest, written: false };
        }
        if (trackedDigest === undefined) {
          this.add(targetRel, "preserved", "файл есть в проекте и не наш — оставлен как есть");
          return { digest: undefined, written: false };
        }
      }
    }
    if (!this.dryRun) writeText(file, text);
    this.add(targetRel, "written");
    return { digest, written: true };
  }

  putCopy(source, file, targetRel, trackedDigest) {
    const digest = sha256File(source);
    if (isFile(file)) {
      if (sha256File(file) === digest) {
        this.add(targetRel, "unchanged");
        return { digest, written: false };
      }
      if (trackedDigest === undefined) {
        this.add(targetRel, "preserved", "файл есть в проекте и не наш — оставлен как есть");
        return { digest: undefined, written: false };
      }
      if (sha256File(file) !== trackedDigest) {
        this.add(targetRel, "preserved", "файл изменён пользователем — оставлен как есть");
        return { digest: trackedDigest, written: false };
      }
    }
    if (!this.dryRun) copyFile(source, file);
    this.add(targetRel, "written");
    return { digest, written: true };
  }
}

function readDeployManifest(projectPath) {
  const parsed = readJson(join(projectPath, MANIFEST_REL));
  if (!parsed || parsed.format !== MANIFEST_FORMAT) return null;
  const byPath = new Map();
  for (const entry of Array.isArray(parsed.files) ? parsed.files : []) {
    if (typeof entry?.path === "string" && typeof entry?.digest === "string") {
      byPath.set(posix(entry.path), { digest: entry.digest, binary: entry.binary === true });
    }
  }
  return { raw: parsed, byPath };
}

/**
 * Совпадает ли файл с тем, что мы записали. Текстовые файлы пишутся из строки,
 * нетекстовые копируются байт в байт — способ сравнения запоминается в манифесте.
 */
function matchesTracked(file, entry) {
  if (entry === undefined) return false;
  try {
    return (entry.binary ? sha256File(file) : sha256(readFileSync(file, "utf8"))) === entry.digest;
  } catch {
    return false;
  }
}

function playbookText(name) {
  const local = join(PLAYBOOK_DIR, name);
  return isFile(local) ? readText(local) : "";
}

function readEntryHeader(journal) {
  const header = playbookText("AGENTS.header.md").trim();
  if (header !== "") return header;
  journal.warn("в пакете нет playbook/AGENTS.header.md — в AGENTS.md записана короткая встроенная шапка");
  return [
    "> Этот файл развёрнут плагином «1С: Параметры проектов» и будет перезаписан при",
    "> обновлении правил. Свои правила складывайте в `USER-RULES.md`.",
  ].join("\n");
}

/**
 * Блок расширенного набора в AGENTS.md: где лежат файлы и что главнее.
 * Собственный AGENTS.md набора не вставляется — он ведёт в инструменты,
 * которых в поставке нет.
 */

function renderEnvironmentDoc(dshHome) {
  const available = configuredServers(dshHome);
  const lines = [
    "# Окружение DSH",
    "",
    "Сгенерировано плагином «1С: Параметры проектов». Файл перезаписывается при",
    "развёртывании правил; свои заметки пишите в `USER-RULES.md`.",
    "",
    "## Что где лежит",
    "",
    "| Что | Где |",
    "|---|---|",
    "| Наши правила и плейбуки | `.dsh/rules-own/` |",
    "| Точка входа | `AGENTS.md` |",
    "| Правила пользователя | `USER-RULES.md` |",
    "",
    "## MCP-серверы",
    "",
    available.length > 0
      ? "Настроенные серверы: " + available.map((name) => `\`${name}\``).join(", ") + "."
      : "Настроенных MCP-серверов не найдено.",
    "",
    "## Замечания",
    "",
    "- DSH сам загружает только `AGENTS.md`; остальные файлы читаются по ссылкам.",
    "- `USER-RULES.md` не загружается автоматически — его читают по ссылке из `AGENTS.md`.",
    "",
  ];
  return lines.join("\n");
}

/**
 * Точка входа правил. Чужой AGENTS.md не затирается, а уезжает в
 * `AGENTS.md.bak.md` с вклейкой в USER-RULES.md: это текст пользователя.
 */

function deployEntry(journal, context) {
  const { projectPath, tracked, record, recordKept } = context;
  const targets = entryTargets(projectPath);
  const header = readEntryHeader(journal);
  const lines = [MANAGED_MARK, header, ""];
  if (!header.includes(ENVIRONMENT_REL)) lines.push(`> Окружение DSH: \`${ENVIRONMENT_REL}\`.`, "");

  const managed = lines.join("\n");
  const trackedEntry = tracked.get("AGENTS.md");

  const current = isFile(targets.agents) ? readText(targets.agents) : null;
  if (current !== null && !current.includes(MANAGED_MARK)) {
    const backup = uniqueBackupPath(projectPath);
    if (!journal.dryRun) renameSync(targets.agents, backup);
    journal.add(
      posix(relative(projectPath, backup)),
      "written",
      "прежний AGENTS.md сохранён и вклеен в USER-RULES.md",
    );
    mergeUserRules(journal, targets.userRules, current, record);
    record("AGENTS.md", journal.putFile(targets.agents, "AGENTS.md", managed, undefined).digest);
  } else {
    const result = journal.putFile(targets.agents, "AGENTS.md", managed, trackedEntry, {
      managed: current !== null,
    });
    record("AGENTS.md", result.digest);
  }

  for (const name of PROTECTED_FILES) {
    const file = join(projectPath, name);
    if (isFile(file)) {
      journal.add(name, "preserved", "файл пользователя — не перезаписывается");
      recordKept(name, file, false);
      continue;
    }
    const text = name === "USER-RULES.md" ? playbookText(name) || USER_RULES_FALLBACK : "";
    if (text === "") continue;
    const result = journal.putFile(file, name, text, undefined);
    record(name, result.digest);
  }
}

/** Вклейка прежнего AGENTS.md в USER-RULES.md между маркерами. */
function mergeUserRules(journal, userRules, original, record) {
  const template = playbookText("USER-RULES.md") || USER_RULES_FALLBACK;
  const existing = isFile(userRules) ? readText(userRules) : template;
  const block = [MIGRATION_START, "## Перенесено из AGENTS.md", "", original.trim(), MIGRATION_END].join("\n");
  const start = existing.indexOf(MIGRATION_START);
  const end = existing.indexOf(MIGRATION_END);
  const next =
    start !== -1 && end !== -1 && end > start
      ? existing.slice(0, start) + block + existing.slice(end + MIGRATION_END.length)
      : `${existing.replace(/\n*$/u, "\n")}\n${block}\n`;
  const targetRel = "USER-RULES.md";
  record(targetRel, journal.putFile(userRules, targetRel, next, undefined).digest);
}

function entryTargets(projectPath) {
  return {
    agents: join(projectPath, "AGENTS.md"),
    backup: join(projectPath, "AGENTS.md.bak.md"),
    userRules: join(projectPath, "USER-RULES.md"),
  };
}

function uniqueBackupPath(projectPath) {
  const base = join(projectPath, "AGENTS.md.bak.md");
  if (!existsSync(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = join(projectPath, `AGENTS.md.bak.${index}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(projectPath, `AGENTS.md.bak.${Date.now()}.md`);
}

// ── развёртывание ───────────────────────────────────────────────────────────

/**
 * Раскладывает правила в проект: AGENTS.md, плейбуки, USER-RULES.md, справка.
 * Ничего не удаляет; правки пользователя в плейбуках остаются за ним.
 */
export function deployRules(options) {
  const { dshHome, projectPath, dryRun = false, force = false } = options;

  if (!isDirectory(projectPath)) {
    return { ok: false, dryRun, error: "папка проекта не найдена: " + projectPath };
  }

  const previous = readDeployManifest(projectPath);
  const tracked = previous?.byPath ?? new Map();
  if (force) tracked.clear();
  const journal = new Journal(dryRun);
  const nextFiles = new Map();

  const record = (targetRel, digest, binary = false) => {
    if (digest !== undefined) nextFiles.set(targetRel, { digest, binary });
  };
  const trackedDigest = (rel) => tracked.get(rel)?.digest;
  const recordKept = (targetRel, file, binary) => {
    if (!tracked.has(targetRel)) return;
    record(targetRel, binary ? sha256File(file) : sha256(readText(file)), binary);
  };

  deployEntry(journal, { projectPath, tracked, record, recordKept });

  if (isDirectory(PLAYBOOK_DIR)) {
    for (const rel of listFiles(PLAYBOOK_DIR)) {
      if (rel.includes("/")) continue;
      if (rel === "AGENTS.header.md" || rel === "USER-RULES.md") continue;
      const targetRel = posix(join(OWN_DIR_REL, rel));
      const result = journal.putFile(
        join(projectPath, targetRel),
        targetRel,
        readText(join(PLAYBOOK_DIR, rel)),
        trackedDigest(targetRel),
      );
      record(targetRel, result.digest);
    }
  }

  const environment = renderEnvironmentDoc(dshHome);
  const envResult = journal.putFile(
    join(projectPath, ENVIRONMENT_REL),
    ENVIRONMENT_REL,
    environment,
    trackedDigest(ENVIRONMENT_REL),
  );
  record(ENVIRONMENT_REL, envResult.digest);

  const manifest = {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    project: projectPath,
    deployedAt: new Date().toISOString(),
    files: [...nextFiles]
      .map(([path, entry]) => ({ path, digest: entry.digest, ...(entry.binary ? { binary: true } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (!dryRun) writeText(join(projectPath, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");

  return {
    ok: true,
    dryRun,
    summary: journal.counts,
    files: journal.files,
    notes: journal.notes,
    warnings: journal.warnings,
  };
}

// ── состояние ───────────────────────────────────────────────────────────────

/** Короткая сводка для списка проектов: без чтения и хеширования файлов. */
export function rulesSummary(projectPath) {
  const manifest = readDeployManifest(projectPath);
  if (manifest === null) return { deployed: false };
  return {
    deployed: true,
    deployedAt: manifest.raw.deployedAt ?? "",
    files: manifest.byPath.size,
  };
}

/** Состояние раскладки: что лежит, что изменено, что исчезло. */
export function rulesStatus(options = {}) {
  const { projectPath } = options;
  const manifest = readDeployManifest(projectPath);
  if (manifest === null) {
    return { deployed: false, modified: [], missing: [], counts: { files: 0 } };
  }
  const modified = [];
  const missing = [];
  for (const [rel, entry] of manifest.byPath) {
    const file = join(projectPath, rel);
    if (!isFile(file)) {
      missing.push(rel);
      continue;
    }
    if (!matchesTracked(file, entry)) modified.push(rel);
  }
  return {
    deployed: true,
    deployedAt: manifest.raw.deployedAt ?? "",
    counts: { files: manifest.byPath.size },
    modified,
    missing,
  };
}

// ── удаление ────────────────────────────────────────────────────────────────

/**
 * Убирает развёрнутые файлы. Вызывается только явной командой «удалить
 * правила»: шаблоны (`USER-RULES.md`, `memory.md`, `LLM-RULES.md`) остаются,
 * управляемый AGENTS.md удаляется, а сохранённый AGENTS.md.bak.md возвращается
 * на место, если пользователь не правил развёрнутый файл.
 */
export function removeRules(options) {
  const { projectPath, force = false } = options;
  const previous = readDeployManifest(projectPath);
  if (previous === null) {
    return { ok: false, error: "в проекте нет манифеста развёрнутых правил" };
  }
  const removed = [];
  const kept = [];
  const targets = entryTargets(projectPath);
  const entryRel = "AGENTS.md";
  const entryFile = targets.agents;
  const entryManaged = isFile(entryFile) && readText(entryFile).includes(MANAGED_MARK);
  const entryEntry = previous.byPath.get(entryRel);
  const entryUntouched = entryManaged && (entryEntry === undefined || matchesTracked(entryFile, entryEntry));
  let restored = "";
  if (entryManaged && (force || entryUntouched)) {
    const backups = [targets.backup];
    for (let index = 2; index < 100; index += 1) {
      const candidate = join(projectPath, `AGENTS.md.bak.${index}.md`);
      if (isFile(candidate)) backups.push(candidate);
    }
    const available = backups.filter((candidate) => isFile(candidate));
    if (available.length > 0) {
      const source = available[available.length - 1];
      renameSync(source, entryFile);
      restored = posix(relative(projectPath, entryFile));
      for (const candidate of available) {
        kept.push({
          path: posix(relative(projectPath, candidate)),
          reason: candidate === source ? "возвращён на место как AGENTS.md" : "оставлен как есть",
        });
      }
    } else {
      unlinkSync(entryFile);
      removed.push(entryRel);
    }
  } else if (entryManaged) {
    kept.push({ path: entryRel, reason: "изменён пользователем" });
  }

  for (const [rel, entry] of previous.byPath) {
    if (rel === entryRel) continue;
    if (PROTECTED_FILES.includes(rel)) {
      kept.push({ path: rel, reason: "файл пользователя — остаётся в проекте" });
      continue;
    }
    const file = join(projectPath, rel);
    if (!isFile(file)) continue;
    if (!force && !matchesTracked(file, entry)) {
      kept.push({ path: rel, reason: "изменён пользователем" });
      continue;
    }
    unlinkSync(file);
    removeEmptyDirs(dirname(file), projectPath);
    removed.push(rel);
  }

  unlinkSync(join(projectPath, MANIFEST_REL));
  return {
    ok: true,
    removed,
    kept,
    restored,
    notes: ["USER-RULES.md, memory.md и LLM-RULES.md оставлены в проекте — это ваши файлы"],
  };
}
