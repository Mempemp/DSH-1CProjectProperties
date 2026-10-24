// dsh-1c-project-properties — хост-половина плагина.
//
// Хранит параметры 1С в разрезе проекта:
//   <папка проекта>/.dsh/1c-project.json                  — путь к базе, пользователь/пароль, путь к платформе
//   $DSH_HOME/1c-project-properties/settings.json         — общие значения (платформа по умолчанию)
//
// Список проектов = реестр воркспейсов DSH + дополнительные пути, добавленные вручную.
// Все роуты живут под префиксом /1cprops и отдают JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { connect as netConnect } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployRules,
  readPayload,
  removeRules,
} from "./rules-deploy.js";
import {
  PLATFORM_CONTEXT_SERVER,
  platformContextExe,
  platformContextStatus,
  restartPlatformContext,
  startPlatformContext,
  stopPlatformContext,
} from "./platform-context.js";

export const name = "dsh-1c-project-properties";

// webServer — HTTP-роуты, workspaceRegistry — список проектов пользователя.
export const inject = ["webServer", "workspaceRegistry"];

const ROUTE = "/1cprops";
const SCHEMA = "dsh-1c-project-properties/v1";
const PARAMS_DIR = ".dsh";
const PARAMS_FILE = "1c-project.json";
const PARAMS_REL = PARAMS_DIR + "/" + PARAMS_FILE;

// Порядок ключей в файле проекта (и полный список поддерживаемых полей).
const PARAM_KEYS = ["infobasePath", "user", "password", "platformPath", "unlockCode", "dumpDir"];

// $DSH_HOME: та же приоритетность, что у ядра — переменная окружения, иначе ~/.dsh.
const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : join(homedir(), ".dsh");
})();
const COMMON_FILE = join(DSH_HOME, "1c-project-properties", "settings.json");

// ── утилиты файловой системы ────────────────────────────────────────────────

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("тело запроса слишком большое"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Запись через временный файл: падение процесса не оставит обрезанный JSON.
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

// ── пути проектов ───────────────────────────────────────────────────────────

function canonical(p) {
  const abs = resolve(String(p));
  const stripped = abs.replace(/[\\/]+$/, "");
  return stripped || abs;
}

function pathKey(p) {
  const c = canonical(p);
  return process.platform === "win32" ? c.toLowerCase() : c;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── общие (машинные) настройки ──────────────────────────────────────────────

function readCommon() {
  const raw = readJson(COMMON_FILE) ?? {};
  return {
    platformPath: typeof raw.platformPath === "string" ? raw.platformPath : "",
    extraProjects: Array.isArray(raw.extraProjects)
      ? raw.extraProjects.filter((p) => typeof p === "string" && p.trim()).map((p) => canonical(p))
      : [],
  };
}

function writeCommon(next) {
  writeJson(COMMON_FILE, next);
  return next;
}

// ── параметры проекта ───────────────────────────────────────────────────────

function paramsFile(projectPath) {
  return join(projectPath, PARAMS_DIR, PARAMS_FILE);
}

function readParams(projectPath) {
  const file = paramsFile(projectPath);
  const raw = readJson(file);
  const params = {};
  for (const key of PARAM_KEYS) params[key] = typeof raw?.[key] === "string" ? raw[key] : "";
  return { file, hasFile: raw !== null, params };
}

// Сохраняет только известные поля; чужие ключи в файле не теряются.
function saveParams(projectPath, patch) {
  const file = paramsFile(projectPath);
  const current = readJson(file) ?? {};
  const next = { $schema: SCHEMA };
  for (const key of PARAM_KEYS) {
    const value = patch?.[key];
    next[key] = typeof value === "string" ? value : typeof current[key] === "string" ? current[key] : "";
  }
  for (const [key, value] of Object.entries(current)) {
    if (!(key in next)) next[key] = value;
  }
  writeJson(file, next);
  return next;
}

// ── поиск установленных платформ 1С ─────────────────────────────────────────

function compareVersions(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectPlatforms() {
  const roots = [
    join(process.env.ProgramFiles || "C:\\Program Files", "1cv8"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "1cv8"),
  ];
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Programs", "1cv8"));
  // Каталог установки из 1cestart.cfg — на случай нестандартного места.
  for (const dir of installedLocations()) roots.push(dir);

  const found = new Map();
  for (const root of new Set(roots)) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = join(root, entry.name, "bin", "1cv8.exe");
      if (existsSync(exe) && !found.has(entry.name)) found.set(entry.name, exe);
    }
  }
  return [...found.entries()]
    .map(([version, path]) => ({ version, path }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// ── список информационных баз (.v8i) ────────────────────────────────────────
//
// Стандартные места: %APPDATA%\1C\1CEStart\ibases.v8i (список пользователя),
// %PROGRAMDATA%\1C\1CEStart\ibases.v8i (общий список). Файлы 1cestart.cfg и
// 1cescmn.cfg хранятся в UTF-16LE и могут ссылаться на внешние списки
// параметром CommonInfoBases — их тоже читаем.

function configFiles() {
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData";
  return {
    roaming,
    programData,
    cfgs: [
      join(roaming, "1C", "1CEStart", "1cestart.cfg"),
      join(programData, "1C", "1CEStart", "1cestart.cfg"),
      join(programData, "1C", "1CEStart", "1cescmn.cfg"),
    ],
  };
}

/** Чтение текста 1С: UTF-16LE с BOM, затем UTF-8, затем cp1251. */
function readTextFile(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    return "";
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(raw.subarray(2));
    } catch {}
  }
  for (const encoding of ["utf-8", "windows-1251"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch {}
  }
  return raw.toString("utf8");
}

function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}

/** Каталоги установки платформы, объявленные в 1cestart.cfg (InstalledLocation). */
function installedLocations() {
  const dirs = [];
  for (const cfg of configFiles().cfgs) {
    const text = readTextFile(cfg);
    const match = text.match(/^\s*InstalledLocation\s*=\s*(.+)$/mi);
    if (match) dirs.push(expandEnv(match[1].trim()).replace(/[\\/]+$/, ""));
  }
  return dirs;
}

/** Пути внешних списков баз из CommonInfoBases (1cestart.cfg / 1cescmn.cfg). */
function commonInfoBaseFiles() {
  const files = [];
  for (const cfg of configFiles().cfgs) {
    const text = readTextFile(cfg);
    const match = text.match(/^\s*CommonInfoBases\s*=\s*(.+)$/mi);
    if (!match) continue;
    for (const item of match[1].split(";")) {
      const value = expandEnv(item.trim().replace(/^"|"$/g, ""));
      if (value) files.push(value);
    }
  }
  return files;
}

/** Разбор файла .v8i: секции [Имя] с парами Connect=/ID=/Folder=/App=. */
function parseV8i(text, source) {
  const entries = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      if (current) entries.push(current);
      current = { name: section[1].trim(), connect: "", folder: "", app: "", source };
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^([A-Za-z]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].trim();
    if (key === "connect") current.connect = value;
    else if (key === "folder") current.folder = value;
    else if (key === "app") current.app = value;
  }
  if (current) entries.push(current);
  return entries.filter((entry) => entry.name && entry.connect);
}

/**
 * Строка соединения из .v8i → значение для поля «Путь к базе».
 * Файловая база отдаётся путём, клиент-серверная — строкой Srvr/Ref
 * (обе формы понимает resolveBase). Веб-базы для пакетной выгрузки не годятся.
 */
function normalizeConnect(connect) {
  const value = String(connect || "").trim();
  const file = value.match(/^file\s*=\s*"?([^";]+)"?;?$/i);
  if (file) return { value: file[1].trim(), kind: "file" };
  const server = value.match(/srvr\s*=\s*"?([^";]+)"?/i);
  const ref = value.match(/\bref\s*=\s*"?([^";]+)"?/i);
  if (server && ref) {
    return { value: 'Srvr="' + server[1].trim() + '";Ref="' + ref[1].trim() + '";', kind: "server" };
  }
  if (/^\s*ws\s*=/i.test(value)) return { value, kind: "web" };
  return { value, kind: "unknown" };
}

/** Сводный список баз: пользовательский, общий и внешние .v8i. */
function listInfoBases() {
  const { roaming, programData } = configFiles();
  const candidates = [
    { file: join(roaming, "1C", "1CEStart", "ibases.v8i"), source: "список пользователя" },
    { file: join(programData, "1C", "1CEStart", "ibases.v8i"), source: "общий список" },
    ...commonInfoBaseFiles().map((file) => ({ file, source: "внешний список" })),
  ];

  const items = [];
  const sources = [];
  const seen = new Set();
  let webSkipped = 0;

  for (const { file, source } of candidates) {
    if (!existsSync(file)) continue;
    const entries = parseV8i(readTextFile(file), source);
    if (entries.length === 0) continue;
    sources.push({ file, source, count: entries.length });
    for (const entry of entries) {
      const normalized = normalizeConnect(entry.connect);
      if (normalized.kind === "web") {
        webSkipped += 1;
        continue;
      }
      if (!normalized.value) continue;
      const key = normalized.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        name: entry.name,
        value: normalized.value,
        kind: normalized.kind,
        folder: entry.folder,
        app: entry.app,
        source,
      });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return { items, webSkipped, sources };
}

// ── выгрузка конфигурации в файлы (DESIGNER /DumpConfigToFiles) ──────────────
//
// Проверено на 8.3.27.2130 (Windows, интерактивная сессия пользователя):
//   • работает 1cv8.exe; 1cv8s.exe в этой среде молча завершается с кодом 0 и ничего не делает;
//   • stale-локи .cfl в каталоге файловой базы ломают выгрузку
//     («Ошибка блокировки информационной базы для конфигурирования»);
//   • /DumpResult<файл> пишет 0 при успехе и 1 при ошибке — надёжнее кода возврата;
//   • каталог выгрузки и подключаемые параметры передаются отдельными аргументами,
//     без кавычек (spawn без shell).

const DUMP_TIMEOUT_MS = 60 * 60 * 1000;
const JOB_TAIL_CHARS = 4000;

/**
 * Пакетные операции Конфигуратора. Одна за раз: 1С блокирует конфигурацию базы,
 * поэтому параллельный запуск всё равно упадёт на блокировке.
 *
 * `producesFiles` различает операции по тому, чем подтверждается успех: выгрузка
 * обязана создать файлы (код возврата 0 при пустом каталоге — ложный успех,
 * проверено на 8.3.27), а загрузка файлов не создаёт и подтверждается только
 * /DumpResult.
 */
const OPERATIONS = {
  dump: { label: "выгрузка конфигурации", producesFiles: true },
  load: { label: "загрузка конфигурации из файлов", producesFiles: false },
  extensions: { label: "выгрузка расширений", producesFiles: true },
};

/** Один активный процесс на весь плагин (1С блокирует конфигурацию базы). */
let dumpJob = null;

/** Путь к платформе → конкретный exe и рабочий каталог. Принимает и .exe, и папку bin. */
function resolvePlatform(raw) {
  const value = String(raw || "").trim();
  if (!value) return { error: "не задан путь к платформе 1С — заполните его в проекте или в общих настройках" };
  let stat = null;
  try {
    stat = statSync(value);
  } catch {
    return { error: "путь к платформе не найден: " + value };
  }
  if (stat.isFile()) return { exe: value, cwd: dirname(value) };
  if (!stat.isDirectory()) return { error: "путь к платформе не файл и не каталог: " + value };

  // Приоритет: 1cv8.exe (полный клиент, работает в сессии пользователя), затем серверный
  // агент и тонкий клиент — у них набор пакетных команд уже.
  for (const dir of [value, join(value, "bin")]) {
    for (const name of ["1cv8.exe", "1cv8s.exe", "1cv8c.exe"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { exe: candidate, cwd: dir };
    }
  }
  return { error: "в каталоге нет 1cv8.exe: " + value };
}

/** Путь к базе (или строка соединения) → аргумент /F или /S. */
function resolveBase(raw) {
  const value = String(raw || "").trim();
  if (!value) return { error: "не задан путь к базе" };
  if (!/(^|;)\s*(Srvr|Ref|File|IBName)\s*=/i.test(value)) return { arg: "/F" + value };

  const pick = (key) => {
    const match = value.match(new RegExp("(?:^|;)\\s*" + key + "\\s*=\\s*\"?([^\";]+)\"?", "i"));
    return match ? match[1].trim() : "";
  };
  const file = pick("File");
  if (file) return { arg: "/F" + file };
  const server = pick("Srvr");
  const ref = pick("Ref");
  if (server && ref) return { arg: "/S" + server + "\\" + ref };
  return { error: "в строке соединения нет File либо Srvr/Ref: " + value };
}

/** Каталог выгрузки: пусто → корень проекта, относительный путь → внутри проекта. */
function resolveDumpDir(projectPath, raw) {
  const value = String(raw || "").trim();
  if (!value) return projectPath;
  return canonical(isAbsolute(value) ? value : join(projectPath, value));
}

/** Снять stale-локи .cfl файловой базы (без них выгрузка падает на блокировке). */
function cleanLockFiles(dir) {
  const removed = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith(".cfl")) {
        try {
          unlinkSync(join(dir, name));
          removed.push(name);
        } catch {}
      }
    }
  } catch {}
  return removed;
}

/** Конфигуратор пишет /Out в cp1251 на русской Windows, но может и в UTF-8. */
function decodeLog(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    return "";
  }
  for (const encoding of ["utf-8", "windows-1251"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch {}
  }
  return raw.toString("utf8");
}

function countFiles(dir, cap = 200000) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total < cap) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (entry.isFile()) total += 1;
    }
  }
  return total;
}

/** Первая содержательная строка лога — чтобы причина ошибки была видна без раскрытия лога. */
function firstLogLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || "";
}

/** Версия конфигурации — только из <Version> в Configuration.xml (не из ConfigDumpInfo.xml). */
function readConfigVersion(dir) {
  try {
    const raw = readFileSync(join(dir, "Configuration.xml"));
    if (raw.length > 20 * 1024 * 1024) return "";
    const match = raw.toString("utf8").match(/<Version>([^<]+)<\/Version>/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function jobSnapshot() {
  if (!dumpJob) return { state: "idle" };
  const finished = dumpJob.finishedAt ?? Date.now();
  return {
    state: dumpJob.state,
    operation: dumpJob.operation,
    label: dumpJob.label,
    path: dumpJob.path,
    title: dumpJob.title,
    dir: dumpJob.dir,
    startedAt: dumpJob.startedAt,
    finishedAt: dumpJob.finishedAt ?? null,
    elapsedMs: finished - dumpJob.startedAt,
    command: dumpJob.command,
    exitCode: dumpJob.exitCode,
    resultCode: dumpJob.resultCode,
    files: dumpJob.files,
    counts: dumpJob.counts,
    version: dumpJob.version,
    log: dumpJob.log,
    error: dumpJob.error,
  };
}

function dumpStatus(_req, res) {
  // Во время работы число файлов считаем не чаще раза в 5 секунд: обход дерева
  // из десятков тысяч файлов не должен конкурировать с самой выгрузкой за диск.
  if (dumpJob && dumpJob.state === "running" && dumpJob.counts && Date.now() - dumpJob.countedAt > 5000) {
    dumpJob.countedAt = Date.now();
    try {
      dumpJob.files = countFiles(dumpJob.dir);
    } catch {}
  }
  json(res, 200, { ok: true, job: jobSnapshot() });
}

function cancelDump(_req, res) {
  if (!dumpJob || dumpJob.state !== "running" || !dumpJob.child) {
    return json(res, 200, { ok: true, job: jobSnapshot() });
  }
  try {
    spawnSync("taskkill", ["/PID", String(dumpJob.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {}
  dumpJob.state = "cancelled";
  dumpJob.finishedAt = Date.now();
  dumpJob.error = (dumpJob.label || "операция") + " отменена";
  json(res, 200, { ok: true, job: jobSnapshot() });
}

/**
 * Аргументы пакетного запуска Конфигуратора. Чистая функция — её проверяет
 * test/rules-deploy.smoke.mjs, потому что неверный ключ платформа молча
 * игнорирует, и операция «проходит успешно», ничего не сделав.
 *
 * Кавычки не расставляются: spawn запускается без shell, аргументы уходят
 * позиционно, и лишние кавычки внутри значения 1С понимает буквально.
 */
export function buildDesignerArgs(options) {
  const {
    operation,
    baseArg,
    params = {},
    format = "Hierarchical",
    sourceDir,
    targetDir,
    update = false,
    updateDb = true,
    dynamic = true,
    logFile,
    resultFile,
  } = options;

  const args = [
    "DESIGNER",
    baseArg,
    ...(params.user ? ["/N" + params.user] : []),
    ...(params.password ? ["/P" + params.password] : []),
    ...(params.unlockCode ? ["/UC" + params.unlockCode] : []),
  ];
  const notes = [];

  if (operation === "dump") {
    args.push(
      "/DumpConfigToFiles", targetDir,
      "-Format", format,
      ...(update ? ["-update", "-force"] : []),
    );
  } else if (operation === "extensions") {
    // Отдельный каталог обязателен: -AllExtensions в общем каталоге смешал бы
    // объекты расширений с объектами основной конфигурации.
    args.push("/DumpConfigToFiles", targetDir, "-Format", "Hierarchical", "-AllExtensions");
    notes.push("выгружаются все расширения базы в " + targetDir);
  } else if (operation === "load") {
    args.push("/LoadConfigFromFiles", sourceDir, "-Format", format);
    notes.push("источник: " + sourceDir);
    if (updateDb) {
      args.push("/UpdateDBCfg");
      if (dynamic) {
        args.push("-Dynamic+", "-SessionTerminate", "force");
        notes.push("конфигурация базы обновляется динамически (-Dynamic+, сеансы не прерываются)");
      } else {
        notes.push("обновление базы без динамики — нужны монопольный доступ и выход всех пользователей");
      }
    } else {
      notes.push("конфигурация базы не обновляется — изменения останутся только в конфигурации");
    }
  } else {
    throw new Error("неизвестная операция: " + operation);
  }

  args.push(
    "/Out" + logFile,
    "/DumpResult" + resultFile,
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
  );
  return { args, notes };
}

/**
 * Подсказка к ошибке операции. Для расширений она важна: ключ -AllExtensions у
 * /DumpConfigToFiles подтверждён не всеми источниками, и молчаливое «не вышло»
 * здесь читается как неисправность плагина, а не как ограничение версии.
 */
function failureHint(operation) {
  if (operation !== "extensions") return "";
  return " Если эта версия платформы не знает ключ -AllExtensions у /DumpConfigToFiles," +
    " выгрузка расширений в исходники ею не поддерживается — команда для ручной проверки есть в README.";
}

/**
 * Запуск пакетной операции Конфигуратора. Три команды, одни и те же /F|/S, /N,
 * /P, /UC, /Out, /DumpResult:
 *   выгрузка   — /DumpConfigToFiles <каталог> -Format <формат> [-update -force]
 *   загрузка   — /LoadConfigFromFiles <каталог> -Format <формат> [/UpdateDBCfg]
 *   расширения — /DumpConfigToFiles <каталог>\Extensions -Format Hierarchical -AllExtensions
 */
async function startDesignerJob(operation, req, res) {
  const spec = OPERATIONS[operation];
  if (!spec) return json(res, 400, { ok: false, error: "неизвестная операция: " + operation });

  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    return json(res, 400, { ok: false, error: error?.message || String(error) });
  }

  const projectPath = canonical(String(body?.path ?? "").trim());
  if (!isDirectory(projectPath)) return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
  if (dumpJob && dumpJob.state === "running") {
    return json(res, 409, {
      ok: false,
      error: "уже идёт " + (dumpJob.label || "операция") + " проекта «" + dumpJob.title + "» — дождитесь её окончания",
    });
  }

  const common = readCommon();
  // Параметры из запроса сильнее файла проекта: визард проверяет подключение до
  // сохранения, и введённое в поля должно проверяться ровно как введено.
  const params = { ...readParams(projectPath).params };
  const override = body?.params && typeof body.params === "object" ? body.params : {};
  for (const key of PARAM_KEYS) {
    if (typeof override[key] === "string") params[key] = override[key];
  }
  const platform = resolvePlatform(params.platformPath || common.platformPath);
  if (platform.error) return json(res, 400, { ok: false, error: platform.error });
  const base = resolveBase(params.infobasePath);
  if (base.error) return json(res, 400, { ok: false, error: base.error });

  const format = body?.format === "Plain" ? "Plain" : "Hierarchical";
  const sourceDir = resolveDumpDir(projectPath, body?.dir ?? params.dumpDir);
  // Расширения кладём отдельной папкой рядом с конфигурацией (по умолчанию это
  // корень проекта): выгрузка всех расширений в общий каталог смешала бы их
  // объекты с объектами основной конфигурации.
  const targetDir = operation === "extensions"
    ? canonical(join(sourceDir, String(body?.extensionsDir ?? "").trim() || "Extensions"))
    : sourceDir;

  const notes = [];

  if (operation === "load") {
    // Загрузка из каталога без Configuration.xml заменит конфигурацию базы
    // пустой — это отказ, а не попытка, которую 1С потом объяснит своим текстом.
    if (!existsSync(join(sourceDir, "Configuration.xml"))) {
      return json(res, 400, {
        ok: false,
        error: "в каталоге нет Configuration.xml: " + sourceDir +
          ". Загрузка из такого каталога заменит конфигурацию базы пустой — сначала выгрузите конфигурацию в файлы.",
      });
    }
  } else if (operation !== "check") {
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: "не удалось создать каталог: " + (error?.message || error) });
    }
  }

  // -update работает только при наличии файла версий в каталоге выгрузки: без него
  // Конфигуратор падает с ошибкой (в отличие от несовпадения версии формата,
  // которое закрывает -force). Нет файла — делаем полную выгрузку и пишем об этом.
  let update = false;
  if (operation === "dump") {
    update = body?.update === true;
    if (update && !existsSync(join(targetDir, "ConfigDumpInfo.xml"))) {
      update = false;
      notes.push("в каталоге выгрузки нет ConfigDumpInfo.xml — выполнена полная выгрузка, а не обновление");
    }
  }

  // Снятие локов — только для файловой базы, заданной путём (не строкой соединения).
  let removedLocks = [];
  if (body?.cleanLocks === true && base.arg.startsWith("/F")) removedLocks = cleanLockFiles(base.arg.slice(2));

  const jobDir = join(DSH_HOME, "1c-project-properties", "jobs");
  mkdirSync(jobDir, { recursive: true });
  const stamp = String(Date.now());
  const logFile = join(jobDir, operation + "-" + stamp + ".log");
  const resultFile = join(jobDir, operation + "-" + stamp + ".result");

  const { args, notes: argNotes } = buildDesignerArgs({
    operation,
    baseArg: base.arg,
    params,
    format,
    sourceDir,
    targetDir,
    update,
    updateDb: body?.updateDb !== false,
    dynamic: body?.dynamic !== false,
    logFile,
    resultFile,
  });
  notes.push(...argNotes);

  const title = basename(projectPath);
  const logLines = [];
  if (removedLocks.length > 0) logLines.push("сняты lock-файлы: " + removedLocks.join(", "));
  logLines.push(...notes);
  const job = {
    state: "running",
    operation,
    label: spec.label,
    counts: spec.producesFiles,
    path: projectPath,
    title,
    dir: targetDir,
    sourceDir,
    startedAt: Date.now(),
    finishedAt: null,
    command: [platform.exe, ...args.map((a, i) => (i > 0 && ["/P", "/N"].some((k) => a.startsWith(k)) ? a.slice(0, 3) + "…" : a))].join(" "),
    exitCode: null,
    resultCode: null,
    files: 0,
    countedAt: 0,
    version: "",
    log: logLines.length > 0 ? logLines.join("\n") + "\n" : "",
    error: "",
    child: null,
  };
  dumpJob = job;

  let child;
  try {
    child = spawn(platform.exe, args, { cwd: platform.cwd, windowsHide: true, stdio: "ignore" });
  } catch (error) {
    job.state = "failed";
    job.finishedAt = Date.now();
    job.error = "не удалось запустить " + platform.exe + ": " + (error?.message || error);
    return json(res, 500, { ok: false, job: jobSnapshot() });
  }
  job.child = child;

  const timeoutMs = DUMP_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (job.state !== "running") return;
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
    job.state = "failed";
    job.finishedAt = Date.now();
    job.error = spec.label + " превысила лимит " + Math.round(timeoutMs / 60000) + " мин и была остановлена";
    job.log = (job.log + "\n" + decodeLog(logFile)).slice(-JOB_TAIL_CHARS);
  }, timeoutMs);

  const finalize = () => {
    clearTimeout(timer);
    if (job.state === "cancelled") return;
    job.finishedAt = Date.now();
    job.exitCode = child.exitCode;
    const text = decodeLog(logFile);
    job.log = (job.log + (text ? "\n" + text : "")).slice(-JOB_TAIL_CHARS);
    job.resultCode = decodeLog(resultFile).trim();
    job.files = spec.producesFiles ? countFiles(targetDir) : 0;
    job.version = readConfigVersion(sourceDir);

    // Пустой каталог при успешном вердикте платформы — не ошибка, но и не
    // очевидность: у расширений это штатный результат базы без расширений.
    const finishDone = () => {
      job.state = "done";
      if (spec.producesFiles && job.files === 0) {
        job.log = (job.log + "\n" + spec.label + ": файлов не создано." +
          (operation === "extensions"
            ? " Если расширений в базе нет — это нормальный результат; иначе проверьте, поддерживает ли эта версия платформы ключ -AllExtensions."
            : "")).slice(-JOB_TAIL_CHARS);
      }
    };

    // 1C пишет /Out и /DumpResult асинхронно — даём файлам дописаться.
    if (!job.resultCode && (!spec.producesFiles || job.files === 0)) {
      setTimeout(() => {
        job.resultCode = decodeLog(resultFile).trim();
        job.files = spec.producesFiles ? countFiles(targetDir) : 0;
        if (job.resultCode === "0" || (spec.producesFiles && job.files > 0)) {
          finishDone();
          job.version = readConfigVersion(sourceDir);
          return;
        }
        job.state = "failed";
        job.error = (spec.producesFiles
          ? spec.label + " не создала файлов" + (job.exitCode ? " (код " + job.exitCode + ")" : "")
          : spec.label + " не подтверждена: /DumpResult пуст" + (job.exitCode ? " (код " + job.exitCode + ")" : "")) +
          failureHint(operation);
      }, 3000);
      return;
    }

    // /DumpResult — собственный вердикт платформы (0 при успехе). Код возврата
    // процесса ненадёжен: пакетная команда может провалиться при exit 0, а для
    // загрузки /DumpResult вообще единственный признак того, что она прошла.
    if (job.resultCode === "0" || (spec.producesFiles && job.files > 0 && job.exitCode === 0)) {
      finishDone();
      return;
    }
    job.state = "failed";
    job.error = (job.resultCode === "1"
      ? "Конфигуратор сообщил об ошибке: " + (firstLogLine(text) || "см. лог")
      : spec.label + " завершилась без результата" + (job.exitCode ? " (код " + job.exitCode + ")" : "")) +
      failureHint(operation);
  };

  child.on("exit", finalize);
  child.on("error", (error) => {
    job.state = "failed";
    job.finishedAt = Date.now();
    job.error = "процесс 1С: " + (error?.message || error);
    clearTimeout(timer);
  });

  json(res, 202, { ok: true, job: jobSnapshot() });
}

// ── сборка списка проектов ──────────────────────────────────────────────────

function listProjects(ctx, common) {
  const projects = [];
  const seen = new Set();

  let workspaces = [];
  try {
    workspaces = ctx.workspaceRegistry?.list?.() ?? [];
  } catch {
    workspaces = [];
  }
  for (const workspace of workspaces) {
    if (!workspace?.path) continue;
    const key = pathKey(workspace.path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({
      source: "workspace",
      path: canonical(workspace.path),
      title: workspace.title || basename(canonical(workspace.path)),
    });
  }

  for (const extra of common.extraProjects) {
    const key = pathKey(extra);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({ source: "extra", path: canonical(extra), title: basename(canonical(extra)) });
  }

  return projects;
}

function describeProject(entry, common) {
  const info = readParams(entry.path);
  const platformPath = info.params.platformPath;
  return {
    ...entry,
    exists: isDirectory(entry.path),
    hasFile: info.hasFile,
    filePath: info.file,
    params: info.params,
    effectivePlatformPath: platformPath || common.platformPath,
    platformFromCommon: platformPath === "",
  };
}

// ── плагин ──────────────────────────────────────────────────────────────────

/**
 * Наличие набора правил в DSH — единственное, что плагин о нём знает. Ни версии
 * развёрнутого набора, ни дрейфа правок в проекте он не считает: карточка правил
 * только блокирует кнопку и объясняет, чего не хватает.
 */
function describePayload() {
  const payload = readPayload(DSH_HOME);
  return {
    ok: payload.ok,
    root: payload.root,
    error: payload.ok ? undefined : payload.error,
    version: payload.ok ? payload.manifest?.version ?? "" : "",
    derived: payload.ok ? payload.derived === true : false,
  };
}

// ── визард: что лежит в папке проекта ──────────────────────────────────────
//
// Визард добавления проекта спрашивает «это проект 1С?» и подсказывает ответ по
// содержимому папки. Проверка дешёвая: известные файлы в корне плюс ограниченный
// проход по вложенным папкам в поисках исходников .bsl.

const DETECT_BUDGET = 4000;
const DETECT_DEPTH = 4;

function hasBslSources(dir, depth, budget) {
  if (depth > DETECT_DEPTH || budget.left <= 0) return false;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    budget.left -= 1;
    if (budget.left <= 0) return false;
    if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith(".bsl")) return true;
      continue;
    }
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      if (hasBslSources(join(dir, entry.name), depth + 1, budget)) return true;
    }
  }
  return false;
}

function detectProject(projectPath) {
  const info = readParams(projectPath);
  const markers = [];
  if (existsSync(join(projectPath, "Configuration.xml"))) markers.push("выгрузка конфигурации в файлы");
  if (existsSync(join(projectPath, "ConfigDumpInfo.xml"))) markers.push("файл версий выгрузки");
  if (existsSync(join(projectPath, "src", "Configuration", "Configuration.xml"))) markers.push("исходники проекта 1С:EDT");
  if (existsSync(join(projectPath, "DT-INF"))) markers.push("служебные файлы 1С");
  if (hasBslSources(projectPath, 0, { left: DETECT_BUDGET })) markers.push("исходные тексты модулей");
  return {
    ok: true,
    path: projectPath,
    is1c: markers.length > 0 || info.hasFile,
    markers,
    hasParams: info.hasFile,
    hasRules: existsSync(join(projectPath, PARAMS_DIR, "rules-1c")),
    hasDump: existsSync(join(projectPath, "Configuration.xml")),
    params: info.params,
  };
}


// ── визард: быстрая проверка пути к базе ───────────────────────────────────
//
// Открывать Конфигуратор ради «правильно ли указан путь» дорого: платформа
// читает конфигурацию целиком, и на большой базе это десятки секунд. Сначала
// проверяем то, что видно без неё: есть ли каталог базы с файлом 1Cv8.1CD,
// отвечает ли сервер 1С по своему порту, находится ли платформа.

function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    const socket = netConnect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function checkBaseLocally(base) {
  if (base.error) return { label: "База", ok: false, detail: base.error };
  const filePath = base.arg.startsWith("/F") ? base.arg.slice(2) : "";
  if (filePath) {
    if (!isDirectory(filePath)) return { label: "База", ok: false, detail: "папка базы не найдена: " + filePath };
    const hasData = existsSync(join(filePath, "1Cv8.1CD"));
    return {
      label: "База",
      ok: hasData,
      detail: hasData ? "файл 1Cv8.1CD на месте" : "в папке нет файла 1Cv8.1CD: " + filePath,
    };
  }
  const raw = base.arg.slice(2);
  const slash = raw.indexOf("\\");
  const server = slash >= 0 ? raw.slice(0, slash) : raw;
  const ref = slash >= 0 ? raw.slice(slash + 1) : "";
  const colon = server.lastIndexOf(":");
  const host = colon > 0 ? server.slice(0, colon) : server;
  const port = colon > 0 ? Number(server.slice(colon + 1)) || 1541 : 1541;
  const reachable = await tcpReachable(host, port);
  return {
    label: "Сервер",
    ok: reachable,
    detail: reachable ? host + ":" + port + " отвечает" : host + ":" + port + " не отвечает" + (ref ? " (база " + ref + ")" : ""),
  };
}

// ── проверка подключения: внешнее соединение ───────────────────────────────
//
// Пакетный Конфигуратор для вопроса «верный ли путь и пароль» слишком дорог.
// /CheckConfig читает и проверяет всю конфигурацию (30–128 с, замечания не про
// подключение), /DumpCfg пишет файл размером с конфигурацию (на УТ 11.5 —
// 839 МБ) и берёт конфигурацию базы на изменение. Внешнее соединение
// V83.COMConnector делает ровно нужное: авторизуется, открывает базу на чтение
// и отдаёт Метаданные.Версия — 2–3 с, при живых пользователях, без блокировок,
// без процессов 1С. Так это устроено в CF_Extractor (app/com_connector.py).
//
// В Node COM нет, поэтому мост — PowerShell: lib/com-check.ps1 получает строку
// соединения переменной окружения (пароль не ходит по командной строке) и
// пишет вердикт JSON-файлом, чтобы не зависеть от кодовой страницы консоли.

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const COM_SCRIPT = join(LIB_DIR, "com-check.ps1");
const COM_TIMEOUT_MS = 45 * 1000;

/** Строка внешнего соединения из тех же данных, что уходят Конфигуратору. */
export function buildComConnectionString(base, params = {}) {
  if (base.error) return { error: base.error };
  const parts = [];
  if (base.arg.startsWith("/F")) {
    parts.push('File="' + base.arg.slice(2) + '";');
  } else if (base.arg.startsWith("/S")) {
    const raw = base.arg.slice(2);
    const slash = raw.indexOf("\\");
    const server = slash >= 0 ? raw.slice(0, slash) : raw;
    const ref = slash >= 0 ? raw.slice(slash + 1) : "";
    if (!server || !ref) return { error: "в строке соединения нет сервера или имени базы: " + raw };
    parts.push('Srvr="' + server + '";');
    parts.push('Ref="' + ref + '";');
  } else {
    return { error: "непонятный путь к базе: " + base.arg };
  }
  if (params.user) parts.push('Usr="' + params.user + '";');
  if (params.password) parts.push('Pwd="' + params.password + '";');
  return { value: parts.join("") };
}

/** PowerShell той же разрядности, что платформа: COM-класс регистрируется под неё. */
export function pickPowerShell(platformExe) {
  const exe = String(platformExe || "").toLowerCase();
  if (exe.includes("program files (x86)")) {
    const wow = join(process.env.SystemRoot || "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(wow)) return { exe: wow, bitness: 32 };
  }
  return { exe: "powershell.exe", bitness: 64 };
}

/** Текст платформы вместо кода COM: пользователю нужен смысл, а не HRESULT. */
function comErrorText(message) {
  const text = String(message || "").trim();
  if (/80040154|class not registered|класс не зарегистрирован/i.test(text)) {
    return "компонент внешнего соединения 1С не зарегистрирован — платформа установлена без него " +
      "или его разрядность не совпадает с разрядностью платформы";
  }
  if (/800401F3|invalid class string|invalid syntax/i.test(text) && !text.includes("Пользователь")) {
    return "компонент внешнего соединения 1С недоступен: " + text;
  }
  return text;
}

/**
 * Соединиться с базой тем составом данных, что указан в проекте.
 * Возвращает { ok, version, error, elapsedMs, bitness }.
 */
function runComCheck(platformExe, connectionString) {
  const shell = pickPowerShell(platformExe);
  const jobDir = join(DSH_HOME, "1c-project-properties", "jobs");
  mkdirSync(jobDir, { recursive: true });
  const outFile = join(jobDir, "com-" + Date.now() + ".json");
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let child;
    try {
      child = spawn(shell.exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", COM_SCRIPT], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, P1C_CONN: connectionString, P1C_OUT: outFile },
      });
    } catch (error) {
      return finish({ ok: false, error: "не удалось запустить проверку: " + (error?.message || error) });
    }
    const timer = setTimeout(() => {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {}
      try {
        unlinkSync(outFile);
      } catch {}
      finish({
        ok: false,
        error: "база не ответила за " + Math.round(COM_TIMEOUT_MS / 1000) + " с — проверьте путь и доступность сервера",
      });
    }, COM_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: "PowerShell: " + (error?.message || error) });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const data = readJson(outFile);
      try {
        unlinkSync(outFile);
      } catch {}
      if (!data || typeof data !== "object") {
        return finish({ ok: false, error: "проверка не вернула результат" });
      }
      if (data.ok === true) return finish({ ok: true, version: String(data.version || ""), bitness: shell.bitness });
      finish({ ok: false, error: comErrorText(data.error) || "база не открылась", bitness: shell.bitness });
    });
  });
}

// ── визард: серверы MCP приложения ─────────────────────────────────────────
//
// MCP-менеджер держит список серверов в своём каталоге внутри $DSH_HOME. Читаем
// его как есть и только читаем: включать и выключать серверы — дело панели
// менеджера, визарду нужно показать, что уже подключено к агенту.

const MCP_MANAGER_STORE = join(DSH_HOME, "@wingsky-1", "dsh-mcp-manager", "mcp.json");

function listMcpServers() {
  const raw = readJson(MCP_MANAGER_STORE);
  if (!raw || !Array.isArray(raw.servers)) {
    return { ok: true, available: false, file: MCP_MANAGER_STORE, servers: [] };
  }
  const servers = raw.servers
    .filter((server) => server && typeof server.name === "string" && server.name.trim())
    .map((server) => ({
      name: server.name.trim(),
      enabled: server.enabled !== false,
    }));
  return { ok: true, available: true, file: MCP_MANAGER_STORE, servers };
}

// ── платформенный контекст (MCP) ────────────────────────────────────────────
//
// Справку по API платформы агенту отдаёт внешний сервер из vendor/bsl-context-rs
// (MIT): плагин владеет его жизненным циклом, а маршрут к нему отдаёт
// MCP-менеджеру через ctx.mcpManager.registerServer — поэтому сервер виден в
// панели менеджера и его инструменты приходят агенту как mcp__1c-platform-context__*.
//
// Путь к платформе — общее значение из настроек, то же, что у выгрузки
// конфигурации. Пока оно пустое, сервер поднят, но менеджеру не отдан: справка
// без индекса отвечает отказом, и держать её в списке инструментов незачем.

const PLATFORM_CONTEXT_DATA_DIR = join(DSH_HOME, "1c-platform-context");

/** Мост к MCP-менеджеру: он приходит и уходит отдельно от плагина. */
const managerBridge = { service: null, url: "", registered: false };

/** Очередь запусков: смена пути не должна теряться в уже идущем запуске. */
let platformContextQueue = Promise.resolve();

function managerService() {
  return managerBridge.service;
}

/** Готовый сервер — в менеджер; неготовый — снять оттуда. */
async function publishPlatformContext(status) {
  const service = managerService();
  if (!service) return;
  const wanted = status.running && status.indexLoaded && status.url ? status.url : "";

  if (!wanted) {
    if (!managerBridge.registered) return;
    managerBridge.registered = false;
    managerBridge.url = "";
    await service.unregisterServer(PLATFORM_CONTEXT_SERVER);
    return;
  }
  if (managerBridge.registered && managerBridge.url === wanted) {
    // Менеджер мог исчерпать свои попытки переподключения, пока индекс собирался.
    const current = service.getStatus(PLATFORM_CONTEXT_SERVER);
    if (current && current.status !== "connected") await service.reconnect(PLATFORM_CONTEXT_SERVER);
    return;
  }
  if (managerBridge.registered) {
    managerBridge.registered = false;
    await service.unregisterServer(PLATFORM_CONTEXT_SERVER);
  }
  await service.registerServer({
    name: PLATFORM_CONTEXT_SERVER,
    transport: "streamable-http",
    url: wanted,
    description:
      "Справка по API платформы 1С из установленной версии: типы, методы, свойства, " +
      "конструкторы, значения перечислений и проверка BSL-кода против платформы.",
  });
  managerBridge.registered = true;
  managerBridge.url = wanted;
}

/** Снять сервер с учёта в менеджере (если он там был). */
async function withdrawPlatformContext() {
  const service = managerService();
  if (!service || !managerBridge.registered) return;
  managerBridge.registered = false;
  managerBridge.url = "";
  await service.unregisterServer(PLATFORM_CONTEXT_SERVER);
}

/** Запуск (или перезапуск) сервера под действующий путь к платформе. */
function ensurePlatformContext({ restart = false } = {}) {
  const run = async () => {
    const common = readCommon();
    const platform = resolvePlatform(common.platformPath);
    const dir = platform.exe ? platform.cwd : "";
    if (!dir) {
      // Путь не задан (или неверен) — сервер не поднимаем вовсе: процесс и
      // индекс платформы занимают десятки мегабайт, а отдавать менеджеру всё
      // равно нечего. Он стартует сам, когда путь появится: сохранение общих
      // значений зовёт этот же запуск с restart.
      stopPlatformContext();
      const status = platformContextStatus();
      const result = { ok: false, running: false, skipped: true, error: platform.error, ...status };
      try {
        await publishPlatformContext(status);
      } catch (error) {
        result.managerError = error?.message || String(error);
      }
      return result;
    }
    const result = restart
      ? await restartPlatformContext({ dataDir: PLATFORM_CONTEXT_DATA_DIR, platformPath: dir })
      : await startPlatformContext({ dataDir: PLATFORM_CONTEXT_DATA_DIR, platformPath: dir });
    try {
      await publishPlatformContext(result);
    } catch (error) {
      result.managerError = error?.message || String(error);
    }
    return result;
  };
  // Запуски идут по очереди: «start без пути» при apply и «restart после смены
  // пути» — не конкуренты, и второй обязан случиться, даже если первый ещё идёт.
  const job = platformContextQueue.then(run, run);
  platformContextQueue = job.then(
    () => {},
    () => {},
  );
  return job;
}

function describePlatformContext() {
  const common = readCommon();
  const platform = resolvePlatform(common.platformPath);
  return {
    ...platformContextStatus(),
    exe: platformContextExe(),
    pathMissing: String(common.platformPath || "").trim() === "",
    platformError: platform.exe ? "" : platform.error,
    managerAvailable: Boolean(managerService()),
    managerRegistered: managerBridge.registered,
  };
}

export function apply(ctx) {
  // Сервер справки поднимается сразу: путь к платформе может быть ещё не задан,
  // и это штатное состояние первой установки, а не ошибка.
  ctx.inject(["mcpManager"], (mctx) => {
    managerBridge.service = mctx.get("mcpManager") ?? null;
    ensurePlatformContext().catch(() => {});
    mctx.on("dispose", () => {
      // Снимаем сервер с учёта, пока держим сервис: у приложения на выходе
      // порядок dispose у нашего и менеджерского плагина не гарантирован.
      Promise.resolve(withdrawPlatformContext()).catch(() => {});
      managerBridge.service = null;
    });
  });
  ensurePlatformContext().catch(() => {});

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/platform-context",
    handler: (_req, res) => {
      try {
        json(res, 200, { ok: true, version: 1, ...describePlatformContext() });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/platform-context-restart",
    handler: async (_req, res) => {
      try {
        const result = await ensurePlatformContext({ restart: true });
        json(res, result.ok ? 200 : 400, { ok: result.ok, ...describePlatformContext(), error: result.error });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/state",
    handler: (_req, res) => {
      try {
        const common = readCommon();
        const infobases = listInfoBases();
        json(res, 200, {
          ok: true,
          paramsRel: PARAMS_REL,
          commonFile: COMMON_FILE,
          common,
          projects: listProjects(ctx, common).map((entry) => describeProject(entry, common)),
          platforms: detectPlatforms(),
          infobases: infobases.items,
          infobasesWebSkipped: infobases.webSkipped,
          infobasesSources: infobases.sources,
          rulesPayload: describePayload(),
          platformContext: describePlatformContext(),
        });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Общие значения: платформа по умолчанию для проектов, где путь не задан.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/common",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const common = readCommon();
        const previousPlatform = common.platformPath;
        if (typeof body?.platformPath === "string") common.platformPath = body.platformPath.trim();
        writeCommon(common);
        if (common.platformPath !== previousPlatform) {
          // Сервер справки читает каталог платформы при старте — меняем путь делом,
          // а не только на словах. Ответ на запрос ждать этого не должен.
          ensurePlatformContext({ restart: true }).catch(() => {});
        }
        json(res, 200, { ok: true, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Сохранение параметров одного проекта.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-save",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const target = String(body?.path ?? "").trim();
        if (!target || !isAbsolute(target)) {
          return json(res, 400, { ok: false, error: "нужен абсолютный путь к папке проекта" });
        }
        const projectPath = canonical(target);
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        saveParams(projectPath, body?.params ?? {});
        const common = readCommon();
        json(res, 200, { ok: true, ...describeProject({ source: "workspace", path: projectPath }, common) });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Чтение действующих параметров проекта — точка входа для других плагинов и агентов.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project",
    handler: (req, res) => {
      try {
        const target = new URL(req.url, "http://127.0.0.1").searchParams.get("path");
        if (!target) return json(res, 400, { ok: false, error: "параметр path обязателен" });
        const projectPath = canonical(target);
        const common = readCommon();
        const described = describeProject({ source: "lookup", path: projectPath }, common);
        json(res, 200, { ok: true, ...described });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Удаление файла параметров проекта.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-clear",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const file = paramsFile(projectPath);
        try {
          unlinkSync(file);
        } catch {
          // файла нет — уже то, что нужно
        }
        json(res, 200, { ok: true, path: projectPath, hasFile: false, filePath: file });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Дополнительный путь в списке проектов (папка, не зарегистрированная в DSH).
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-add",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isAbsolute(projectPath) || !isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const common = readCommon();
        if (!common.extraProjects.some((p) => pathKey(p) === pathKey(projectPath))) {
          common.extraProjects.push(projectPath);
          writeCommon(common);
        }
        json(res, 200, { ok: true, path: projectPath, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-forget",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        const common = readCommon();
        common.extraProjects = common.extraProjects.filter((p) => pathKey(p) !== pathKey(projectPath));
        writeCommon(common);
        json(res, 200, { ok: true, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // ── пакетные операции Конфигуратора ──────────────────────────────────────
  //
  // Все три идут через один движок и одну задачу: 1С блокирует конфигурацию
  // базы, поэтому одновременно выполняется только одна операция.

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/dump-start",
    handler: (req, res) => {
      startDesignerJob("dump", req, res);
    },
  });
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/load-start",
    handler: (req, res) => {
      startDesignerJob("load", req, res);
    },
  });
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/extensions-start",
    handler: (req, res) => {
      startDesignerJob("extensions", req, res);
    },
  });
  // Проверка подключения внешним соединением: тот же состав данных, что уходит
  // Конфигуратору, но без запуска Конфигуратора — 2–3 с, база не блокируется.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/check-connection",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        const common = readCommon();
        const params = { ...readParams(projectPath).params };
        const override = body?.params && typeof body.params === "object" ? body.params : {};
        for (const key of PARAM_KEYS) {
          if (typeof override[key] === "string") params[key] = override[key];
        }
        const platform = resolvePlatform(params.platformPath || common.platformPath);
        if (platform.error) return json(res, 400, { ok: false, error: platform.error });
        const base = resolveBase(params.infobasePath);
        const connection = buildComConnectionString(base, params);
        if (connection.error) return json(res, 400, { ok: false, error: connection.error });
        const startedAt = Date.now();
        const result = await runComCheck(platform.exe, connection.value);
        return json(res, 200, {
          ok: result.ok === true,
          elapsedMs: Date.now() - startedAt,
          version: result.version || "",
          error: result.error || "",
          bitness: result.bitness || 0,
        });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });
  ctx.webServer.register({ kind: "exact", path: ROUTE + "/dump-status", handler: dumpStatus });
  ctx.webServer.register({ kind: "exact", path: ROUTE + "/dump-cancel", handler: cancelDump });

  // ── правила 1С в проекте (1c-rules) ──────────────────────────────────────
  //
  // Набор правил кладёт десктоп в $DSH_HOME/1c-rules; здесь он раскладывается
  // в проекте в ту структуру, которую читает DSH: <проект>/.dsh/skills для
  // навыков и <проект>/AGENTS.md как всегда включённый контекст. Ссылки правил
  // на content/... при этом переписываются на проектные пути — без этого они
  // указывают в никуда. Подробности контракта — lib/rules-deploy.js.

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/rules-deploy",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const result = deployRules({
          dshHome: DSH_HOME,
          projectPath,
          sections: Array.isArray(body?.sections) && body.sections.length > 0 ? body.sections : undefined,
          params: readParams(projectPath).params,
          common: readCommon(),
          includePassword: body?.includePassword === true,
          useEdt: body?.useEdt === true,
          dryRun: body?.dryRun === true,
          force: body?.force === true,
        });
        json(res, result.ok ? 200 : 400, result);
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/rules-remove",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const result = removeRules({ projectPath, force: body?.force === true });
        json(res, result.ok ? 200 : 400, result);
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Определение проекта 1С по папке — для визарда добавления проекта.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/detect",
    handler: (req, res) => {
      try {
        const target = new URL(req.url, "http://127.0.0.1").searchParams.get("path");
        if (!target) return json(res, 400, { ok: false, error: "параметр path обязателен" });
        if (!isAbsolute(target)) return json(res, 400, { ok: false, error: "нужен абсолютный путь к папке проекта" });
        const projectPath = canonical(target);
        if (!isDirectory(projectPath)) return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        json(res, 200, detectProject(projectPath));
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Быстрая проверка пути к базе и платформы — без запуска Конфигуратора.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/path-check",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        const common = readCommon();
        const params = { ...readParams(projectPath).params };
        const override = body?.params && typeof body.params === "object" ? body.params : {};
        for (const key of PARAM_KEYS) {
          if (typeof override[key] === "string") params[key] = override[key];
        }
        const platform = resolvePlatform(params.platformPath || common.platformPath);
        const base = resolveBase(params.infobasePath);
        const checks = [
          { label: "Платформа", ok: !platform.error, detail: platform.error || platform.exe },
          await checkBaseLocally(base),
        ];
        json(res, 200, { ok: true, okAll: checks.every((item) => item.ok), checks });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Серверы MCP приложения — только чтение, для последнего шага визарда.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/mcp-servers",
    handler: (_req, res) => {
      try {
        json(res, 200, listMcpServers());
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Уходя, не оставляем висящий Конфигуратор и не держим порт справки.
  ctx.on("dispose", () => {
    if (dumpJob?.state === "running" && dumpJob.child) {
      try {
        spawnSync("taskkill", ["/PID", String(dumpJob.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {}
      dumpJob.state = "cancelled";
      dumpJob.finishedAt = Date.now();
    }
    stopPlatformContext();
    Promise.resolve(withdrawPlatformContext()).catch(() => {});
  });
}
