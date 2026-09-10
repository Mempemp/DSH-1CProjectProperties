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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

/** Один активный процесс выгрузки на весь плагин (1С блокирует конфигурацию базы). */
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
    version: dumpJob.version,
    log: dumpJob.log,
    error: dumpJob.error,
  };
}

function dumpStatus(_req, res) {
  // Во время работы число файлов считаем не чаще раза в 5 секунд: обход дерева
  // из десятков тысяч файлов не должен конкурировать с самой выгрузкой за диск.
  if (dumpJob && dumpJob.state === "running" && Date.now() - dumpJob.countedAt > 5000) {
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
  dumpJob.error = "выгрузка отменена";
  json(res, 200, { ok: true, job: jobSnapshot() });
}

async function startDump(ctx, req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    return json(res, 400, { ok: false, error: error?.message || String(error) });
  }

  const projectPath = canonical(String(body?.path ?? "").trim());
  if (!isDirectory(projectPath)) return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
  if (dumpJob && dumpJob.state === "running") {
    return json(res, 409, { ok: false, error: "уже идёт выгрузка проекта «" + dumpJob.title + "» — дождитесь её окончания" });
  }

  const common = readCommon();
  const params = readParams(projectPath).params;
  const platform = resolvePlatform(params.platformPath || common.platformPath);
  if (platform.error) return json(res, 400, { ok: false, error: platform.error });
  const base = resolveBase(params.infobasePath);
  if (base.error) return json(res, 400, { ok: false, error: base.error });

  const format = body?.format === "Plain" ? "Plain" : "Hierarchical";
  const dir = resolveDumpDir(projectPath, body?.dir ?? params.dumpDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return json(res, 400, { ok: false, error: "не удалось создать каталог выгрузки: " + (error?.message || error) });
  }

  // -update работает только при наличии файла версий в каталоге выгрузки: без него
  // Конфигуратор падает с ошибкой (в отличие от несовпадения версии формата,
  // которое закрывает -force). Нет файла — делаем полную выгрузку и пишем об этом.
  const notes = [];
  let update = body?.update === true;
  if (update && !existsSync(join(dir, "ConfigDumpInfo.xml"))) {
    update = false;
    notes.push("в каталоге выгрузки нет ConfigDumpInfo.xml — выполнена полная выгрузка, а не обновление");
  }

  // Снятие локов — только для файловой базы, заданной путём (не строкой соединения).
  let removedLocks = [];
  if (body?.cleanLocks === true && base.arg.startsWith("/F")) removedLocks = cleanLockFiles(base.arg.slice(2));

  const jobDir = join(DSH_HOME, "1c-project-properties", "jobs");
  mkdirSync(jobDir, { recursive: true });
  const stamp = String(Date.now());
  const logFile = join(jobDir, "dump-" + stamp + ".log");
  const resultFile = join(jobDir, "dump-" + stamp + ".result");

  const args = [
    "DESIGNER",
    base.arg,
    ...(params.user ? ["/N" + params.user] : []),
    ...(params.password ? ["/P" + params.password] : []),
    ...(params.unlockCode ? ["/UC" + params.unlockCode] : []),
    "/DumpConfigToFiles", dir,
    "-Format", format,
    ...(update ? ["-update", "-force"] : []),
    "/Out" + logFile,
    "/DumpResult" + resultFile,
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
  ];

  const title = basename(projectPath);
  const logLines = [];
  if (removedLocks.length > 0) logLines.push("сняты lock-файлы: " + removedLocks.join(", "));
  logLines.push(...notes);
  const job = {
    state: "running",
    path: projectPath,
    title,
    dir,
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

  const timer = setTimeout(() => {
    if (job.state !== "running") return;
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {}
    job.state = "failed";
    job.finishedAt = Date.now();
    job.error = "выгрузка превысила лимит " + Math.round(DUMP_TIMEOUT_MS / 60000) + " мин и была остановлена";
    job.log = (job.log + "\n" + decodeLog(logFile)).slice(-JOB_TAIL_CHARS);
  }, DUMP_TIMEOUT_MS);

  const finalize = () => {
    clearTimeout(timer);
    if (job.state === "cancelled") return;
    job.finishedAt = Date.now();
    job.exitCode = child.exitCode;
    const text = decodeLog(logFile);
    job.log = (job.log + (text ? "\n" + text : "")).slice(-JOB_TAIL_CHARS);
    job.resultCode = decodeLog(resultFile).trim();
    job.files = countFiles(dir);

    // 1C пишет /Out и /DumpResult асинхронно — даём файлам дописаться.
    if (!job.resultCode && job.files === 0) {
      setTimeout(() => {
        job.resultCode = decodeLog(resultFile).trim();
        job.files = countFiles(dir);
        job.state = job.resultCode === "0" || job.files > 0 ? "done" : "failed";
        if (job.state === "failed") job.error = "выгрузка не создала файлов" + (job.exitCode ? " (код " + job.exitCode + ")" : "");
        else job.version = readConfigVersion(dir);
      }, 3000);
      return;
    }

    if (job.resultCode === "0" || (job.files > 0 && job.exitCode === 0)) {
      job.state = "done";
      job.version = readConfigVersion(dir);
      return;
    }
    job.state = "failed";
    job.error = job.resultCode === "1"
      ? "Конфигуратор сообщил об ошибке: " + (firstLogLine(text) || "см. лог")
      : "выгрузка не создала файлов" + (job.exitCode ? " (код " + job.exitCode + ")" : "");
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

export function apply(ctx) {
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
        if (typeof body?.platformPath === "string") common.platformPath = body.platformPath.trim();
        writeCommon(common);
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

  // ── выгрузка конфигурации в файлы ────────────────────────────────────────

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/dump-start",
    handler: (req, res) => {
      startDump(ctx, req, res);
    },
  });
  ctx.webServer.register({ kind: "exact", path: ROUTE + "/dump-status", handler: dumpStatus });
  ctx.webServer.register({ kind: "exact", path: ROUTE + "/dump-cancel", handler: cancelDump });

  // Уходя, не оставляем висящий Конфигуратор.
  ctx.on("dispose", () => {
    if (dumpJob?.state === "running" && dumpJob.child) {
      try {
        spawnSync("taskkill", ["/PID", String(dumpJob.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {}
      dumpJob.state = "cancelled";
      dumpJob.finishedAt = Date.now();
    }
  });
}
