// rules-deploy — раскладка правил 1С (1c-rules) в конкретный проект.
//
// Правила приходят из payload'а, который десктоп сеет в $DSH_HOME/1c-rules
// (kind: payload в installer-flavor.yml). Здесь они превращаются в проектную
// раскладку DSH:
//
//   <проект>/AGENTS.md                     точка входа (always-on у DSH)
//   <проект>/.dsh/rules-1c/*.md            48 правил, читаются по ссылкам
//   <проект>/.dsh/agents-1c/*.md           13 ролей субагентов
//   <проект>/.dsh/commands-1c/*.md         30 сценариев-команд
//   <проект>/.dsh/skills/<имя>/**          12 скиллов (+ 4 OpenSpec)
//   <проект>/openspec/**                   workspace OpenSpec
//   <проект>/.dev.env                      параметры проекта для правил
//   <проект>/.dsh/1c-rules.json            манифест развёрнутого набора
//
// Смысл именно такого размещения: DSH ищет проектные скиллы в
// <корень>/.dsh/skills и <корень>/.agents/skills (ранг выше пользовательского
// $DSH_HOME/skills), а always-on контекст — в AGENTS.md от корня проекта до
// рабочего каталога. Поэтому файлы обязаны быть на своих местах, иначе DSH их
// просто не увидит.
//
// Исходники правил написаны под раскладку репозитория-источника и ссылаются на
// `content/rules/...`, `content/agents/...`, `content/commands/...`,
// `content/skills/...` и `AGENTS.md`. Такие ссылки переписываются в проектные
// (rewritePaths) — иначе агент получает указатели в никуда.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

// ── константы раскладки ─────────────────────────────────────────────────────

export const PAYLOAD_DIR = "1c-rules";
export const PAYLOAD_MANIFEST = "payload.json";

export const RULES_DIR_REL = ".dsh/rules-1c";
export const AGENTS_DIR_REL = ".dsh/agents-1c";
export const COMMANDS_DIR_REL = ".dsh/commands-1c";
export const SKILLS_DIR_REL = ".dsh/skills";
export const MANIFEST_REL = ".dsh/1c-rules.json";
export const ENVIRONMENT_REL = ".dsh/rules-1c/dsh-environment.md";

/** Разделы развёртывания, которыми управляет UI. */
export const SECTIONS = Object.freeze(["entry", "rules", "agents", "commands", "skills", "openspec", "devEnv"]);

export const SECTION_LABELS = Object.freeze({
  entry: "Точка входа и файлы правил",
  rules: "Правила (content/rules)",
  agents: "Роли субагентов (content/agents)",
  commands: "Сценарии (content/commands)",
  skills: "Навыки (content/skills)",
  openspec: "OpenSpec (workspace + навыки)",
  devEnv: ".dev.env из параметров проекта",
});

const MANIFEST_FORMAT = "dsh-1c-rules-deploy";
const MANIFEST_FORMAT_VERSION = 1;
const MANAGED_MARK = "<!-- managed by dsh-1c-project-properties: 1c-rules -->";
const MIGRATION_START = "<!-- 1c-rules:migrated:start -->";
const MIGRATION_END = "<!-- 1c-rules:migrated:end -->";

/**
 * Файлы, которые плагин создаёт один раз и после этого не трогает. При удалении
 * правил они остаются в проекте: это место для правил пользователя, и в
 * `USER-RULES.md` к тому же вклеивается прежний AGENTS.md — удалять его нельзя.
 */
const PROTECTED_FILES = Object.freeze(["USER-RULES.md", "memory.md", "LLM-RULES.md"]);

/** Идентификаторы MCP-серверов, которые ожидают правила → фактические в DSH. */
const MCP_ALIASES = Object.freeze({
  "1c-code-metadata-mcp": ["1c_code_metadata_mcp", "onec-code-metadata"],
  "1C-docs-mcp": ["1c_help_mcp", "onec-docs"],
  "1c-docs-mcp": ["1c_help_mcp", "onec-docs"],
  "1c-templates-mcp": ["1c_templates_mcp", "onec-templates"],
  "1c-ssl-mcp": ["1c_ssl_mcp", "onec-ssl"],
  "1c-syntax-checker-mcp": ["1c_syntax_checker_mcp", "onec-syntax-checker"],
  "1c-graph-metadata-mcp": ["onec-graph-metadata"],
  "1c-code-check-mcp": ["onec-code-check"],
  "1c-data-mcp": [],
});

// ── утилиты ─────────────────────────────────────────────────────────────────

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Хеш файла как есть — для нетекстовых файлов (скрипты навыков, шаблоны). */
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
  cpSync(from, to);
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
    } catch {}
    break;
  }
}

// ── payload ─────────────────────────────────────────────────────────────────

/**
 * Состояние payload'а правил в $DSH_HOME. Отсутствие payload'а — не ошибка
 * плагина, а нормальный случай (десктоп старой версии или плагин поставлен
 * отдельно), поэтому возвращается флагом, а не исключением.
 */
export function readPayload(dshHome) {
  const root = join(dshHome, PAYLOAD_DIR);
  const manifestFile = join(root, PAYLOAD_MANIFEST);
  if (!existsSync(root)) {
    return {
      ok: false,
      root,
      manifestFile,
      error:
        "набор правил не найден: " +
        root +
        ". Его кладёт DSH Desktop при первом запуске (элемент «payload» каталога установщика).",
    };
  }
  const contentDir = join(root, "content");
  if (!isDirectory(contentDir)) {
    return { ok: false, root, manifestFile, error: "в наборе правил нет каталога content: " + contentDir };
  }
  const manifest = JSON.parse(readText(manifestFile) || "null");
  if (!manifest || typeof manifest !== "object") {
    // Дерево на месте, а манифеста нет: набор скопирован вручную или посеян
    // старой версией. Раскладывать его всё равно можно — версия просто
    // неизвестна; версии плагин не отслеживает, поэтому это не предупреждение.
    return {
      ok: true,
      root,
      manifestFile,
      contentDir,
      derived: true,
      manifest: { id: PAYLOAD_DIR, version: "", digest: "", seededAt: "", derived: true },
    };
  }
  return { ok: true, root, manifestFile, manifest, contentDir };
}

// ── переписывание ссылок ────────────────────────────────────────────────────

const CONTENT_TARGETS = Object.freeze({
  rules: RULES_DIR_REL,
  agents: AGENTS_DIR_REL,
  commands: COMMANDS_DIR_REL,
});

/**
 * Ссылки вида `content/rules/<файл>` из репозитория-источника → проектные.
 * Отдельно правится форма `skills/<имя>/tools/...`: в документации скиллов это
 * путь «относительно каталога скиллов активного инструмента», и в проекте он
 * равен `.dsh/skills/<имя>/tools/...`. Уже переписанные пути не трогаются —
 * `skills/` ищется только там, где перед ним не стоит `/`.
 */
export function rewritePaths(text) {
  let out = String(text);
  out = out.replace(
    /content\/(rules|agents|commands)\/([A-Za-z0-9._<>-]+\.md)/gu,
    (_match, section, name) => `${CONTENT_TARGETS[section]}/${name}`,
  );
  out = out.replace(/content\/skills\//gu, `${SKILLS_DIR_REL}/`);
  out = out.replace(
    /(^|[\s`"'(])skills\/([A-Za-z0-9._<>-]+)\//gu,
    (_match, lead, name) => `${lead}${SKILLS_DIR_REL}/${name}/`,
  );
  return out;
}

// ── окружение: MCP и особенности DSH ────────────────────────────────────────

function configuredServers(dshHome) {
  const names = new Set();
  for (const file of [join(dshHome, "mcp-servers.json"), join(dshHome, "dsh-mcp.json")]) {
    const parsed = JSON.parse(readText(file) || "null");
    const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
    for (const server of servers) {
      const name = server?.serverName ?? server?.name ?? server?.id;
      if (typeof name === "string" && name.trim() !== "") names.add(name.trim());
    }
  }
  return [...names].sort();
}

/**
 * Сгенерированный раздел правил: то, чего нет в апстриме, но без чего его
 * инварианты не работают в DSH — фактические имена MCP-серверов, механика
 * субагентов и slash-команд, место .dev.env.
 */
export function renderEnvironmentDoc(dshHome, options = {}) {
  const available = configuredServers(dshHome);
  const availableSet = new Set(available);
  const rows = Object.entries(MCP_ALIASES).map(([expected, aliases]) => {
    const hit = aliases.find((alias) => availableSet.has(alias));
    return `| \`${expected}\` | ${hit ? `\`${hit}\`` : "— не установлен"} |`;
  });
  const sections = options.sections ?? SECTIONS;
  const lines = [
    "# Правила 1С в DSH: окружение",
    "",
    "Файл сгенерирован плагином `dsh-1c-project-properties` при развёртывании правил.",
    "Правила в этом проекте — адаптация [comol/ai_rules_1c](https://github.com/comol/ai_rules_1c):",
    "тексты правил сохранены, переписаны только пути и описана среда DSH ниже.",
    "",
    "## Где что лежит",
    "",
    "| Что | Путь |",
    "|---|---|",
    `| Точка входа (читает DSH) | \`AGENTS.md\` в корне проекта |`,
    `| Правила, читаются по ссылкам | \`${RULES_DIR_REL}/\` |`,
    `| Роли субагентов | \`${AGENTS_DIR_REL}/\` |`,
    `| Сценарии-команды | \`${COMMANDS_DIR_REL}/\` |`,
    `| Навыки (DSH видит их как проектные) | \`${SKILLS_DIR_REL}/\` |`,
    `| Параметры проекта 1С | \`.dsh/1c-project.json\` (правит плагин) |`,
    `| Параметры для правил | \`.dev.env\` |`,
    `| Манифест развёртывания | \`${MANIFEST_REL}\` |`,
    "",
    "## Особенности DSH, которые правила учитывают",
    "",
    "- **Скиллы.** DSH читает проектные навыки из `.dsh/skills` и `.agents/skills`; они",
    "  имеют приоритет над пользовательскими `$DSH_HOME/skills`. Скрипты навыков лежат",
    `  в \`${SKILLS_DIR_REL}/<навык>/tools/...\`.`,
    "- **Всегда включённый контекст.** DSH сам загружает только `AGENTS.md` (и",
    "  `AGENTS.local.md`) — от корня проекта до рабочего каталога, с бюджетом 64 КиБ.",
    "  Остальные файлы правил читаются по ссылкам, как и задумано их автором.",
    "- **`USER-RULES.md` не загружается автоматически.** DSH его не читает: файл",
    "  существует как место для ваших правил и читается агентом по ссылке из `AGENTS.md`.",
    "- **Роли субагентов.** В DSH нет markdown-описаний субагентов: файлы в",
    `  \`${AGENTS_DIR_REL}/\` — это роли, которые нужно передавать промптом в инструменты`,
    "  `subagent` / `agent_teams`, а не подключаемые агенты.",
    "- **Slash-команды проекта.** DSH регистрирует команды только плагинами и не читает",
    `  \`*.md\` из проекта: файлы в \`${COMMANDS_DIR_REL}/\` — сценарии, которые нужно`,
    "  выполнять по названию («выполни сценарий updaterules»), а не слэшем.",
    "",
    "## MCP-серверы",
    "",
    "Правила построены вокруг MCP-first поиска и ссылаются на серверы из каталога",
    "апстрима. В этой установке DSH доступны следующие соответствия:",
    "",
    "| Ожидается правилами | Фактически в DSH |",
    "|---|---|",
    ...rows,
    "",
    ...(available.length > 0
      ? [
          "Настроенные серверы: " + available.map((name) => `\`${name}\``).join(", ") + ".",
          "",
          "Если сервер не установлен, правило, которое на него опирается, обязано",
          "перейти к своей резервной ветке (обычно это `content/rules/help-corpus-retrieval.md`,",
          "в проекте — `" + RULES_DIR_REL + "/help-corpus-retrieval.md`) — молчаливое",
          "«сервер недоступен, сделаю как получится» недопустимо.",
        ]
      : ["Настроенных MCP-серверов не найдено — правила будут работать по резервным веткам."]),
    "",
    "## Разделы развёртывания",
    "",
    "Развёрнуто: " + sections.map((section) => SECTION_LABELS[section] ?? section).join(", ") + ".",
    "",
  ];
  return lines.join("\n");
}

// ── .dev.env ────────────────────────────────────────────────────────────────

/**
 * `.dev.env` собирается из примера апстрима: значения известных ключей
 * подставляются, комментарии и остальные ключи сохраняются как есть.
 */
export function renderDevEnv(exampleText, values) {
  const known = new Set(Object.keys(values));
  const seen = new Set();
  const out = String(exampleText)
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^([A-Z0-9_]+)\s*=/u.exec(line);
      if (!match) return line;
      const key = match[1];
      if (!known.has(key)) return line;
      seen.add(key);
      return `${key}=${values[key]}`;
    });
  const missing = [...known].filter((key) => !seen.has(key)).sort();
  if (missing.length > 0) {
    out.push("", "# Добавлено плагином 1С: Параметры проектов при развёртывании правил.");
    for (const key of missing) out.push(`${key}=${values[key]}`);
  }
  return out.join("\n").replace(/\n*$/u, "\n");
}

function readConfigurationValue(projectPath) {
  const values = { platformVersion: "", prefix: "" };
  const configuration = join(projectPath, "Configuration.xml");
  if (isFile(configuration)) {
    const match = /<CompatibilityMode>([^<]+)<\/CompatibilityMode>/u.exec(readText(configuration));
    if (match) values.platformVersion = match[1].trim();
  }
  const extension = join(projectPath, "ConfigurationExtension.xml");
  if (isFile(extension)) {
    const match = /<NamePrefix>([^<]*)<\/NamePrefix>/u.exec(readText(extension));
    if (match) values.prefix = match[1].trim();
  }
  return values;
}

// ── план и выполнение ───────────────────────────────────────────────────────

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
  const parsed = JSON.parse(readText(join(projectPath, MANIFEST_REL)) || "null");
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
 * Совпадает ли файл с тем, что мы записали. Текстовые файлы мы пишем из строки
 * (UTF-8), нетекстовые копируем байт в байт — поэтому способ сравнения
 * запоминается в манифесте, иначе всё нетекстовое вечно считалось бы правкой.
 */
function matchesTracked(file, entry) {
  if (entry === undefined) return false;
  try {
    return (entry.binary ? sha256File(file) : sha256(readFileSync(file, "utf8"))) === entry.digest;
  } catch {
    return false;
  }
}

/**
 * Короткая сводка для списка проектов: без чтения и хеширования развёрнутых
 * файлов (их сотни), поэтому годится для отдачи в общем состоянии вкладки.
 */
export function rulesSummary(projectPath) {
  const manifest = readDeployManifest(projectPath);
  if (manifest === null) return { deployed: false };
  return {
    deployed: true,
    version: manifest.raw.payload?.version ?? "",
    digest: manifest.raw.payload?.digest ?? "",
    deployedAt: manifest.raw.deployedAt ?? "",
    sections: Array.isArray(manifest.raw.sections) ? manifest.raw.sections : [],
    files: manifest.byPath.size,
    derived: manifest.raw.payload?.derived === true,
  };
}

/**
 * Состояние развёртывания в проекте: что лежит, что изменено пользователем,
 * что исчезло. Ничего не пишет.
 */
export function rulesStatus(options) {
  const { dshHome, projectPath } = options;
  const payload = readPayload(dshHome);
  const manifest = readDeployManifest(projectPath);
  if (manifest === null) {
    return { deployed: false, payload, modified: [], missing: [], counts: { files: 0 } };
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
    payload,
    version: manifest.raw.payload?.version ?? "",
    digest: manifest.raw.payload?.digest ?? "",
    deployedAt: manifest.raw.deployedAt ?? "",
    sections: Array.isArray(manifest.raw.sections) ? manifest.raw.sections : [],
    counts: { files: manifest.byPath.size },
    modified,
    missing,
    stalePayload: payload.ok && (manifest.raw.payload?.digest ?? "") !== (payload.manifest.digest ?? ""),
  };
}

function entryTargets(projectPath) {
  return {
    agents: join(projectPath, "AGENTS.md"),
    backup: join(projectPath, "AGENTS.md.bak.md"),
    userRules: join(projectPath, "USER-RULES.md"),
    memory: join(projectPath, "memory.md"),
    llmRules: join(projectPath, "LLM-RULES.md"),
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

/**
 * Точка входа правил. Политика — как в апстриме: чужой AGENTS.md не
 * затирается, а уезжает в `AGENTS.md.bak.md` с вклейкой в USER-RULES.md;
 * собственный текст правил после переписывания путей становится управляемым
 * файлом с маркером.
 *
 * Отличие от апстрима одно и принципиальное: DSH не читает USER-RULES.md сам,
 * поэтому управляемый AGENTS.md явно велит его прочитать — иначе вклеенный
 * текст пользователя оказался бы недостижим.
 */
function deployEntry(journal, context) {
  const { projectPath, payloadRoot, tracked, record, recordKept } = context;
  const targets = entryTargets(projectPath);
  const body = rewritePaths(readText(join(payloadRoot, "AGENTS.md")));
  if (body.trim() === "") {
    journal.warn("в наборе правил нет AGENTS.md — точка входа не развёрнута");
    return;
  }
  const managed = [MANAGED_MARK, renderEntryHeader(), "", body].join("\n");
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
    mergeUserRules(journal, targets.userRules, current, payloadRoot, record);
    record("AGENTS.md", journal.putFile(targets.agents, "AGENTS.md", managed, undefined).digest);
  } else {
    // Свой файл узнаём по маркеру, а не по манифесту: манифест мог быть удалён,
    // а файл остаться управляемым. Правки пользователя внутри — сохраняем.
    const result = journal.putFile(targets.agents, "AGENTS.md", managed, trackedEntry, {
      managed: current !== null,
    });
    record("AGENTS.md", result.digest);
  }

  for (const [name, file] of [
    ["USER-RULES.md", targets.userRules],
    ["memory.md", targets.memory],
    ["LLM-RULES.md", targets.llmRules],
  ]) {
    const source = join(payloadRoot, name);
    if (!existsSync(source)) continue;
    const targetRel = posix(relative(projectPath, file));
    if (isFile(file)) {
      journal.add(targetRel, "unchanged", "файл пользователя — не перезаписывается");
      recordKept(targetRel, file, false);
      continue;
    }
    const copied = journal.putCopy(source, file, targetRel, undefined);
    record(targetRel, copied.digest, true);
  }
}

function renderEntryHeader() {
  return [
    "> Этот файл развёрнут плагином «1С: Параметры проектов» из набора правил",
    "> 1c-rules. Правки здесь будут перезаписаны при обновлении; свои правила",
    "> складывайте в `USER-RULES.md` и читайте его вместе с этим файлом.",
    "",
    `> Окружение DSH (пути, MCP-серверы, субагенты, команды): \`${ENVIRONMENT_REL}\`.`,
    "",
  ].join("\n");
}

/** Вклейка прежнего AGENTS.md в USER-RULES.md между маркерами. */
function mergeUserRules(journal, userRules, original, payloadRoot, record) {
  const template = existsSync(join(payloadRoot, "USER-RULES.md"))
    ? readText(join(payloadRoot, "USER-RULES.md"))
    : "# Правила проекта\n";
  const existing = isFile(userRules) ? readText(userRules) : template;
  const block = [MIGRATION_START, "## Перенесено из AGENTS.md", "", original.trim(), MIGRATION_END].join("\n");
  const start = existing.indexOf(MIGRATION_START);
  const end = existing.indexOf(MIGRATION_END);
  const next = start !== -1 && end !== -1 && end > start
    ? existing.slice(0, start) + block + existing.slice(end + MIGRATION_END.length)
    : `${existing.replace(/\n*$/u, "\n")}\n${block}\n`;
  const targetRel = "USER-RULES.md";
  record(targetRel, journal.putFile(userRules, targetRel, next, undefined).digest);
}

/**
 * Разворачивает правила в проект. `dryRun` возвращает тот же отчёт, ничего не
 * записывая — на нём строится предпросмотр в UI.
 */
export function deployRules(options) {
  const {
    dshHome,
    projectPath,
    sections = SECTIONS,
    params = {},
    common = {},
    includePassword = false,
    useEdt = false,
    dryRun = false,
    force = false,
  } = options;

  const payload = readPayload(dshHome);
  if (!payload.ok) {
    return { ok: false, dryRun, error: payload.error, payload };
  }
  if (!isDirectory(projectPath)) {
    return { ok: false, dryRun, error: "папка проекта не найдена: " + projectPath, payload };
  }
  const wanted = new Set(sections.filter((section) => SECTIONS.includes(section)));
  const previous = readDeployManifest(projectPath);
  const tracked = previous?.byPath ?? new Map();
  if (force) tracked.clear();
  const journal = new Journal(dryRun);
  /** targetRel → { digest, binary } для манифеста следующего запуска. */
  const nextFiles = new Map();
  const { root, manifest, contentDir } = payload;

  const record = (targetRel, digest, binary = false) => {
    if (digest !== undefined) nextFiles.set(targetRel, { digest, binary });
  };
  const trackedDigest = (rel) => tracked.get(rel)?.digest;
  /**
   * Файл уже лежит и остаётся как есть. Записываем его в новый манифест только
   * если он наш (был развёрнут раньше): иначе мы бы присвоили себе файл
   * пользователя, а следующий прогон его бы удалил как «лишний».
   */
  const recordKept = (targetRel, file, binary) => {
    if (!tracked.has(targetRel)) return;
    record(targetRel, binary ? sha256File(file) : sha256(readText(file)), binary);
  };

  const copySection = (sourceDir, targetDir) => {
    if (!isDirectory(sourceDir)) return 0;
    let count = 0;
    for (const rel of listFiles(sourceDir)) {
      const targetRel = posix(join(targetDir, rel));
      const targetFile = join(projectPath, targetRel);
      const isText = rel.endsWith(".md");
      const result = isText
        ? journal.putFile(targetFile, targetRel, rewritePaths(readText(join(sourceDir, rel))), trackedDigest(targetRel))
        : journal.putCopy(join(sourceDir, rel), targetFile, targetRel, trackedDigest(targetRel));
      record(targetRel, result.digest, !isText);
      count += 1;
    }
    return count;
  };

  // Точка входа и файлы правил пользователя.
  if (wanted.has("entry")) {
    deployEntry(journal, { projectPath, payloadRoot: root, tracked, record, recordKept });
  }

  if (wanted.has("rules")) copySection(join(contentDir, "rules"), RULES_DIR_REL);
  if (wanted.has("agents")) copySection(join(contentDir, "agents"), AGENTS_DIR_REL);
  if (wanted.has("commands")) copySection(join(contentDir, "commands"), COMMANDS_DIR_REL);
  if (wanted.has("skills")) copySection(join(contentDir, "skills"), SKILLS_DIR_REL);
  if (wanted.has("openspec")) {
    copySection(join(contentDir, "openspec-bundle", "claude-code", ".claude", "skills"), SKILLS_DIR_REL);
    const openspecSource = join(root, "openspec");
    if (isDirectory(openspecSource)) {
      for (const rel of listFiles(openspecSource)) {
        const targetRel = posix(join("openspec", rel));
        const targetFile = join(projectPath, targetRel);
        if (isFile(targetFile)) {
          journal.add(targetRel, "unchanged", "OpenSpec не перезаписывается");
          recordKept(targetRel, targetFile, true);
          continue;
        }
        const result = journal.putCopy(join(openspecSource, rel), targetFile, targetRel, undefined);
        record(targetRel, result.digest, true);
      }
    } else {
      journal.warn("в наборе правил нет каталога openspec — workspace не развёрнут");
    }
  }

  if (wanted.has("devEnv")) {
    const envFile = join(projectPath, ".dev.env");
    if (isFile(envFile)) {
      journal.add(".dev.env", "unchanged", "файл уже есть — значения пользователя не трогаем");
      recordKept(".dev.env", envFile, false);
    } else {
      const example = readText(join(root, ".dev.env.example"));
      if (example.trim() === "") {
        journal.warn("в наборе правил нет .dev.env.example — файл параметров не создан");
      } else {
        const detected = readConfigurationValue(projectPath);
        const values = {
          PLATFORM_PATH: params.platformPath || common.platformPath || "",
          PLATFORM_VERSION: detected.platformVersion,
          INFOBASE_PATH: params.infobasePath || "",
          IB_USER: params.user || "",
          USE_EDT: useEdt ? "true" : "false",
          PREFIX: detected.prefix,
        };
        if (includePassword) values.IB_PASSWORD = params.password || "";
        const text = renderDevEnv(example, values);
        journal.putFile(envFile, ".dev.env", text, undefined);
        record(".dev.env", sha256(text));
        if (!includePassword && (params.password || "") !== "") {
          journal.note("пароль базы в .dev.env не перенесён (IB_PASSWORD) — включите опцию, если он нужен правилам");
        }
        // Чужой .gitignore не правим: это файл проекта, а не наш.
        const gitignore = join(projectPath, ".gitignore");
        if (isFile(gitignore) && !/^\s*\.dev\.env\s*$/mu.test(readText(gitignore))) {
          journal.warn(".dev.env создан, но его нет в .gitignore проекта — добавьте строку .dev.env");
        }
      }
    }
  }

  // Сгенерированный раздел окружения: он наш, поэтому перезаписывается всегда.
  if (wanted.has("rules")) {
    const text = renderEnvironmentDoc(dshHome, { sections: [...wanted] });
    const result = journal.putFile(
      join(projectPath, ENVIRONMENT_REL),
      ENVIRONMENT_REL,
      text,
      trackedDigest(ENVIRONMENT_REL),
    );
    record(ENVIRONMENT_REL, result.digest);
    if (journal.counts.written > 0) {
      journal.note("Сгенерирован " + ENVIRONMENT_REL + " — описание окружения DSH, на него ссылаются правила");
    }
  }

  // Файлы, которые были развёрнуты раньше и больше не нужны: удаляем только
  // неизменённые (и никогда — файлы пользователя из PROTECTED_FILES), чтобы не
  // потерять его правки.
  for (const [rel, entry] of tracked) {
    if (nextFiles.has(rel)) continue;
    if (PROTECTED_FILES.includes(rel)) {
      journal.add(rel, "preserved", "файл пользователя — остаётся в проекте");
      continue;
    }
    const file = join(projectPath, rel);
    if (!isFile(file)) continue;
    if (!matchesTracked(file, entry)) {
      journal.add(rel, "preserved", "файл изменён пользователем — оставлен при обновлении");
      continue;
    }
    if (!dryRun) {
      unlinkSync(file);
      removeEmptyDirs(dirname(file), projectPath);
    }
    journal.add(rel, "removed", "файла больше нет в наборе правил");
  }

  const nextManifest = {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    project: projectPath,
    deployedAt: new Date().toISOString(),
    sections: [...wanted],
    payload: {
      id: manifest.id ?? "",
      version: manifest.version ?? "",
      digest: manifest.digest ?? "",
      seededAt: manifest.seededAt ?? "",
      derived: manifest.derived === true,
    },
    files: [...nextFiles]
      .map(([path, entry]) => ({ path, digest: entry.digest, ...(entry.binary ? { binary: true } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (!dryRun) writeText(join(projectPath, MANIFEST_REL), JSON.stringify(nextManifest, null, 2) + "\n");

  return {
    ok: true,
    dryRun,
    payload: { id: manifest.id, version: manifest.version, digest: manifest.digest, root },
    summary: journal.counts,
    files: journal.files,
    notes: journal.notes,
    warnings: journal.warnings,
  };
}

/**
 * Убирает развёрнутые правила. Шаблоны (`USER-RULES.md`, `memory.md`,
 * `LLM-RULES.md`) остаются — как и в апстриме. Управляемый AGENTS.md удаляется,
 * а сохранённый `AGENTS.md.bak.md` возвращается на место, если пользователь не
 * правил развёрнутый файл.
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

  // Точку входа разбираем отдельно и до общего прохода: за ней стоит
  // сохранённый AGENTS.md.bak.md, который надо вернуть на место, а не удалить.
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
