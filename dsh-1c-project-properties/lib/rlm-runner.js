// Движок rlm-tools-bsl — модуль плагина dsh-1c-project-properties.
//
// Раньше это был отдельный плагин dsh-rlm-tools-bsl: поднимает сервер rlm-tools-bsl
// (MCP для анализа кода 1С по HTTP) при старте DSH и гасит его вместе с DSH.
// Настройки — $DSH_HOME/rlm-tools-bsl/settings.json (каталог сохранён прежним, чтобы
// установленный движок и его Python-окружение не терялись при переезде),
// stdout сервера — $DSH_HOME/rlm-tools-bsl/logs/server.out.log.
// Все роуты остались под префиксом /rlm — на них завязана карточка «Индекс rlm».
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROUTE = "/rlm";
const SERVER_NAME = "rlm-tools-bsl";
const MCP_SERVER_NAME = "rlm";
const HOST = "127.0.0.1";
const PLUGIN_VERSION = "0.1.11";
const SCHEMA = "dsh-rlm-tools-bsl/v1";
const DEFAULT_PORT = 9330;
// Холодный старт (uv-обёртка → python → импорт пакета) на рабочей машине занимает
// около 30 с, поэтому окно ожидания вдвое больше: иначе здоровый сервер объявлялся мёртвым.
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 2_000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const UV_INSTALL_SCRIPT = "irm https://astral.sh/uv/install.ps1 | iex";

// Дополнительные ключи (command, env, takeover, autoInstall) задаются только строкой плагина в cordis.patch.yml.
const DEFAULTS = {
  command: "",
  port: DEFAULT_PORT,
  env: {},
  takeover: true,
  autoInstall: true,
  mcpAutoRegister: true,
};
const FIELD_KEYS = Object.keys(DEFAULTS);

let detectedCache = null;
const portOwnerCache = new Map();

// $DSH_HOME: та же приоритетность, что у ядра — переменная окружения, иначе ~/.dsh.
const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : join(homedir(), ".dsh");
})();
const DIR = join(DSH_HOME, SERVER_NAME);
const SETTINGS_FILE = join(DIR, "settings.json");
const LOG_FILE = join(DIR, "logs", "server.out.log");
// Автоустановка: окружение инструмента, его исполняемые файлы и Python — внутри папки плагина.
const TOOL_DIR = join(DIR, "tool");
const TOOL_BIN_DIR = join(DIR, "bin");
const PYTHON_DIR = join(DIR, "python");

// Известные менеджеры MCP и их хранилища: файл и поле с именем сервера.
const PROFILES_DIR = join(DSH_HOME, "profiles");
const MCP_MANAGER_PACKAGE = "@wingsky-1/dsh-mcp-manager";
// С 0.2.5 менеджер держит список серверов в своей папке. Файл в корне $DSH_HOME
// остался от версий до 0.2.5: сам менеджер переносит его в новое место и убирает.
const MCP_MANAGER_HOME = join(DSH_HOME, MCP_MANAGER_PACKAGE);
const MCP_MANAGER_STORE = join(MCP_MANAGER_HOME, "mcp.json");
const MCP_MANAGER_LEGACY_STORE = join(DSH_HOME, "dsh-mcp.json");

// Менеджер читает ровно один файл: свой (0.2.5+) либо файл-предшественник в корне
// $DSH_HOME. Раскладку видно по его папке — её он заводит при первом запуске, —
// а пока её нет, версию спрашиваем у установленного пакета.
const MCP_MANAGER_LAYOUT_SINCE = [0, 2, 5]; // 0.2.5 — с неё список переехал в свою папку

function managerDirs() {
  const candidates = [join(PROFILES_DIR, "node_modules", MCP_MANAGER_PACKAGE)];
  try {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(PROFILES_DIR, entry.name, "node_modules", MCP_MANAGER_PACKAGE));
    }
  } catch {
    // профилей ещё нет
  }
  return candidates.filter((dir) => existsSync(dir));
}

function managerVersion() {
  for (const dir of managerDirs()) {
    try {
      const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (typeof version === "string") return version;
    } catch {
      // недоступный package.json — смотрим следующий профиль
    }
  }
  return "";
}

// Раскладка менеджера: своя папка или её файл — новая; файл-предшественник на
// диске — старая (его ещё переносит сам менеджер). Ничего нет — смотрим версию
// установленного пакета, а без пакета считаем раскладку актуальной.
function storeLayoutIsCurrent() {
  if (existsSync(MCP_MANAGER_STORE) || existsSync(MCP_MANAGER_HOME)) return true;
  if (existsSync(MCP_MANAGER_LEGACY_STORE)) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(managerVersion());
  if (!match) return true;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== MCP_MANAGER_LAYOUT_SINCE[index]) return parts[index] > MCP_MANAGER_LAYOUT_SINCE[index];
  }
  return true;
}

function managerStorePath() {
  return storeLayoutIsCurrent() ? MCP_MANAGER_STORE : MCP_MANAGER_LEGACY_STORE;
}

function managerStores() {
  return [
    {
      manager: storeLayoutIsCurrent() ? MCP_MANAGER_PACKAGE : `${MCP_MANAGER_PACKAGE} (до 0.2.5)`,
      pkg: MCP_MANAGER_PACKAGE,
      file: managerStorePath(),
      nameField: "name",
    },
    { manager: "dsh-mcp-manager", pkg: "dsh-mcp-manager", file: join(DSH_HOME, "mcp-servers.json"), nameField: "serverName" },
  ];
}

// ── утилиты ────────────────────────────────────────────────────────────────

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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Явно заданное значение: пустая строка и пустой объект считаются «не задано».
function isSet(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function tailLines(file, lines) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const handle = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, start);
      return buffer.toString("utf8").split(/\r?\n/).slice(-lines);
    } finally {
      closeSync(handle);
    }
  } catch {
    return [];
  }
}

function readSettings() {
  const raw = readJson(SETTINGS_FILE) ?? {};
  const out = {};
  for (const key of FIELD_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

// Каталог логов сервера обязателен для записи: под файловой песочницей DSH сервер
// падает с кодом 1 и PermissionError. Подсказка полезнее кода выхода — показываем её.
function writeHint() {
  const tail = tailLines(LOG_FILE, 60).join("\n");
  if (!/PermissionError|Access is denied|WinError 5\b/i.test(tail)) return "";
  return " — каталог .config\\rlm-tools-bsl недоступен для записи: добавьте его в разрешённые пути DSH или задайте RLM_CONFIG_FILE и RLM_INDEX_DIR в переменных окружения плагина";
}

// ── конфигурация запуска ───────────────────────────────────────────────────

function pickConfig(config) {
  const out = {};
  for (const key of FIELD_KEYS) {
    if (config && config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

function detectCommand(fresh = false) {
  const now = Date.now();
  if (!fresh && detectedCache && now - detectedCache.at < 15000) return detectedCache.value;
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, [SERVER_NAME], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  let value = "";
  if (found.status === 0) {
    value = String(found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  }
  if (!value) {
    const exe = process.platform === "win32" ? SERVER_NAME + ".exe" : SERVER_NAME;
    for (const dir of [join(homedir(), ".local", "bin"), TOOL_BIN_DIR]) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) {
        value = candidate;
        break;
      }
    }
  }
  detectedCache = { at: now, value };
  return value;
}

// uv ищется в PATH, затем в %USERPROFILE%\.local\bin и в bin самого плагина (куда его кладёт автоустановка).
function detectUv() {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, ["uv"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (found.status === 0) {
    const first = String(found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  for (const candidate of [join(homedir(), ".local", "bin", exe), join(TOOL_BIN_DIR, exe)]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

// Приоритет: значения из settings.json → значения строки плагина в cordis.patch.yml → встроенные.
function effectiveConfig(rt, fresh = false) {
  const sources = {};
  const out = {};
  for (const key of FIELD_KEYS) {
    const fromSettings = rt.settings[key];
    const fromPatch = rt.patchConfig[key];
    if (isSet(fromSettings)) {
      out[key] = fromSettings;
      sources[key] = "settings";
    } else if (isSet(fromPatch)) {
      out[key] = fromPatch;
      sources[key] = "patch";
    } else {
      out[key] = DEFAULTS[key];
      sources[key] = "default";
    }
  }
  out.port = Number(out.port) || DEFAULT_PORT;
  out.env = out.env && typeof out.env === "object" && !Array.isArray(out.env) ? out.env : {};
  out.takeover = out.takeover !== false;
  out.autoInstall = out.autoInstall !== false;
  out.mcpAutoRegister = out.mcpAutoRegister !== false;
  if (!isSet(out.command)) {
    const detected = detectCommand(fresh);
    if (detected) {
      out.command = detected;
      sources.command = "detected";
    }
  }
  return { config: out, sources, detected: detectCommand(fresh) };
}

function launchArgs(cfg) {
  return ["--transport", "streamable-http", "--host", HOST, "--port", String(cfg.port)];
}

// ── менеджеры MCP ──────────────────────────────────────────────────────────

// Сервис менеджера MCP в контексте хаба (его ctx.provide("mcpManager")).
const MANAGER_SERVICE = "mcpManager";

// Менеджер установлен хотя бы в одном профиле?
function managerInstalled(pkg) {
  if (pkg === MCP_MANAGER_PACKAGE) return managerDirs().length > 0;
  const candidates = [join(PROFILES_DIR, "node_modules", pkg)];
  try {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(PROFILES_DIR, entry.name, "node_modules", pkg));
    }
  } catch {
    // профилей ещё нет
  }
  return candidates.some((dir) => existsSync(dir));
}

function storeEntry(target, url) {
  const entry = { transport: "streamable-http", url, enabled: true };
  entry[target.nameField] = MCP_SERVER_NAME;
  return entry;
}

// Прописывает сервер в хранилища менеджеров MCP: существующий файл либо файл менеджера,
// найденного в профилях. Запись с нашим именем обновляется, остальные не трогаются.
function registerInManagers(url) {
  const results = [];
  for (const target of managerStores()) {
    try {
      const exists = existsSync(target.file);
      if (!exists && !managerInstalled(target.pkg)) {
        results.push({ manager: target.manager, file: target.file, skipped: true });
        continue;
      }
      const parsed = exists ? readJson(target.file) : null;
      if (exists && (!parsed || !Array.isArray(parsed.servers))) {
        results.push({ manager: target.manager, file: target.file, error: "файл не разобран как { version, servers }" });
        continue;
      }
      const data = parsed ?? { version: 1, servers: [] };
      if (!Array.isArray(data.servers)) data.servers = [];
      if (!data.version) data.version = 1;
      const entry = storeEntry(target, url);
      const index = data.servers.findIndex((item) => item && item[target.nameField] === MCP_SERVER_NAME);
      const next = index >= 0 ? { ...data.servers[index], ...entry } : entry;
      if (index >= 0 && JSON.stringify(next) === JSON.stringify(data.servers[index])) {
        results.push({ manager: target.manager, file: target.file, action: "unchanged" });
        continue;
      }
      if (index >= 0) data.servers[index] = next;
      else data.servers.push(next);
      writeJson(target.file, data);
      results.push({ manager: target.manager, file: target.file, action: index >= 0 ? "updated" : "added" });
    } catch (error) {
      results.push({ manager: target.manager, file: target.file, error: error?.message || String(error) });
    }
  }
  return results;
}

// Менеджер MCP судит запись один раз: пока открыто его окно загрузки, он ждёт поверхность
// инструментов, и без неё оставляет запись неподключённой до ручного действия. Наш сервер
// отвечает позже этого окна (python поднимается около десяти секунд), поэтому после готовности
// просим менеджер пересмонтировать запись — тогда состояние пересчитается само. Сервис
// необязательный: без менеджера или на старых версиях просто ничего не делаем.
async function syncManagerRecord(rt) {
  const manager = rt.ctx?.get?.(MANAGER_SERVICE);
  if (!manager || typeof manager.reconnect !== "function") return;
  try {
    const status = typeof manager.getStatus === "function" ? manager.getStatus(MCP_SERVER_NAME) : null;
    // Живое соединение не рвём: пересмонтировать нужно только застрявший вердикт.
    if (status && status.status === "connected") return;
    await manager.reconnect(MCP_SERVER_NAME);
    logInfo(rt, "менеджер MCP: запись пересмонтирована после готовности сервера");
  } catch (error) {
    logInfo(rt, "менеджер MCP: пересмонтировать запись не удалось — " + (error?.message || String(error)));
  }
}

// ── внешние процессы ───────────────────────────────────────────────────────

// Чужой процесс, слушающий порт: PID по netstat и имя по tasklist.
// Кэш — только для частых опросов состояния из UI; в путях запуска и остановки
// нужна свежая проверка (fresh), иначе перезапуск ловит устаревшее «порт свободен».
function portOwner(port, fresh = false) {
  const now = Date.now();
  if (!fresh) {
    const cached = portOwnerCache.get(port);
    if (cached && now - cached.at < 2000) return cached.value;
  }
  const value = portOwnerUncached(port);
  portOwnerCache.set(port, { at: now, value });
  return value;
}

function portOwnerUncached(port) {
  try {
    const net = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    let pid = null;
    for (const line of String(net.stdout ?? "").split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (!(parts[1] ?? "").endsWith(":" + port)) continue;
      const candidate = Number(parts[parts.length - 1]);
      if (Number.isInteger(candidate) && candidate > 0) pid = candidate;
    }
    if (!pid) return null;
    let image = null;
    if (process.platform === "win32") {
      const list = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
      const match = String(list.stdout ?? "").match(/^"([^"]+)"/m);
      if (match) image = match[1];
    }
    return { pid, image };
  } catch {
    return null;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // rlm-tools-bsl.exe — трамплин: python-сервер живёт в дочерних процессах, нужен /T.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // процесс уже мёртв — это и есть цель
  }
}

function isRlmProcess(proc) {
  const image = String(proc?.Name ?? "").toLowerCase();
  if (image === SERVER_NAME + ".exe" || image === SERVER_NAME) return true;
  if (image.startsWith("python")) return /rlm[_-]?tools[_-]?bsl|rlm_tools_bsl/i.test(String(proc?.CommandLine ?? ""));
  return false;
}

// Верхний процесс семейства rlm, владеющий портом: трамплин-exe запускает python-цепочку,
// убивать надо её начало, иначе остаются сироты с занятым портом.
function rlmProcessTop(pid) {
  if (process.platform !== "win32") return pid;
  try {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (run.status !== 0) return pid;
    const parsed = JSON.parse(String(run.stdout ?? "").trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const byPid = new Map(list.map((proc) => [Number(proc.ProcessId), proc]));
    let current = Number(pid);
    for (let guard = 0; guard < 16; guard += 1) {
      const parentId = Number(byPid.get(current)?.ParentProcessId);
      const parent = byPid.get(parentId);
      if (!parent || !isRlmProcess(parent)) break;
      current = parentId;
    }
    return current;
  } catch {
    return pid;
  }
}

// Порт занимает не наш прямой потомок: exe-обёртка uv поднимает python, и слушает уже он.
// Поэтому «чужой ли процесс» решаем по дереву, а не сравнением с pid потомка.
function processTree(rootPid) {
  if (process.platform !== "win32" || !rootPid) return null;
  try {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
    const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (run.status !== 0) return null;
    const parsed = JSON.parse(String(run.stdout ?? "").trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const children = new Map();
    for (const proc of list) {
      const parent = Number(proc.ParentProcessId);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(proc.ProcessId));
    }
    const tree = new Set([Number(rootPid)]);
    const queue = [Number(rootPid)];
    while (queue.length) {
      for (const child of children.get(queue.shift()) ?? []) {
        if (tree.has(child)) continue;
        tree.add(child);
        queue.push(child);
      }
    }
    return tree;
  } catch {
    return null;
  }
}

// ── пробы сервера ──────────────────────────────────────────────────────────

function sseJson(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // не финальная строка — пропускаем
    }
  }
  return null;
}

// Личность сервера: /health отдаёт generic {"status":"ok"}, имя и версию знает только MCP initialize.
async function probeIdentity(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`http://${HOST}:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: SERVER_NAME, version: PLUGIN_VERSION } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: "HTTP " + response.status };
    const payload = sseJson(await response.text());
    const info = payload?.result?.serverInfo;
    if (!info?.name) return { ok: false, error: "ответ initialize без serverInfo" };
    return { ok: info.name === SERVER_NAME, serverName: info.name, version: info.version ?? null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!portOwner(port, true)) return true;
    await sleep(250);
  }
  return !portOwner(port, true);
}

// ── состояние плагина ──────────────────────────────────────────────────────

function createRuntime(ctx, config) {
  return {
    ctx,
    patchConfig: pickConfig(config),
    settings: readSettings(),
    child: null,
    childPid: null,
    adopted: null,
    version: null,
    startedAt: null,
    starting: false,
    stopping: false,
    installing: false,
    mcpRegistration: [],
    lastError: null,
    lastExit: null,
    index: { job: null, jobSeq: 0, infoCache: new Map(), autoTimer: null },
  };
}

function logInfo(rt, message) {
  try {
    rt.ctx?.logger?.info?.("rlm-tools-bsl: " + message);
  } catch {
    // логгер недоступен — состояние всё равно видно во вкладке
  }
}

function snapshot(rt) {
  const { config, sources, detected } = effectiveConfig(rt);
  const running = Boolean(rt.child) || Boolean(rt.adopted);
  const url = `http://${HOST}:${config.port}/mcp`;
  const snippet = JSON.stringify({ serverName: MCP_SERVER_NAME, transport: "streamable-http", url, enabled: true }, null, 2);
  return {
    ok: true,
    server: {
      name: SERVER_NAME,
      url,
      running,
      starting: rt.starting,
      stopping: rt.stopping,
      installing: rt.installing,
      managed: Boolean(rt.child),
      adopted: Boolean(rt.adopted),
      pid: rt.childPid ?? rt.adopted?.pid ?? null,
      version: rt.version,
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : null,
      lastError: rt.lastError,
      portOwner: running ? null : portOwner(config.port),
    },
    config: { command: config.command, port: config.port, env: config.env, takeover: config.takeover, detected, sources },
    mcp: { serverName: MCP_SERVER_NAME, transport: "streamable-http", url, enabled: true, snippet, registration: rt.mcpRegistration },
    paths: { dir: DIR, settings: SETTINGS_FILE, log: LOG_FILE, indexLog: INDEX_LOG, indexRoot: indexRoot(rt), dshHome: DSH_HOME },
    logTail: tailLines(LOG_FILE, 30),
  };
}

// ── жизненный цикл сервера ─────────────────────────────────────────────────

// Запуск внешней команды с выводом в лог: цикл событий не блокируем, установка идёт минутами.
function runToLog(command, args, options = {}) {
  return new Promise((done) => {
    let output = "";
    try {
      writeFileSync(LOG_FILE, `\n===== ${new Date().toISOString()} ${command} ${args.join(" ")}\n`, { encoding: "utf8", flag: "a" });
    } catch {
      // лог недоступен — не повод не запускать
    }
    const child = spawn(command, args, { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    const finish = (code) => {
      try {
        writeFileSync(LOG_FILE, output, { encoding: "utf8", flag: "a" });
      } catch {
        // см. выше
      }
      done({ code, output });
    };
    const timer = setTimeout(() => {
      output += "\n[таймаут выполнения команды]\n";
      try {
        child.kill();
      } catch {
        // уже мёртв
      }
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      output += "\n" + (error?.message || String(error));
      finish(-1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

// Автоустановка rlm-tools-bsl в папку плагина: uv берётся из PATH, при отсутствии — ставится
// официальным скриптом внутрь bin/, затем инструмент ставится с каталогами внутри DIR.
async function autoInstall(rt) {
  rt.installing = true;
  try {
    mkdirSync(DIR, { recursive: true });
    let uv = detectUv();
    if (!uv) {
      logInfo(rt, "uv не найден — ставлю его в " + TOOL_BIN_DIR);
      const boot = await runToLog("powershell", ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", UV_INSTALL_SCRIPT], {
        env: { ...process.env, UV_INSTALL_DIR: TOOL_BIN_DIR, UV_NO_MODIFY_PATH: "1", UV_DISABLE_UPDATE: "1" },
      });
      if (boot.code !== 0) {
        rt.lastError = `uv не найден, а установить его не удалось (код ${boot.code}); вывод — в хвосте лога. Поставьте uv вручную: powershell -ExecutionPolicy ByPass -c "${UV_INSTALL_SCRIPT}"`;
        return "";
      }
      uv = detectUv();
    }
    if (!uv) {
      rt.lastError = "uv не найден и после установки; укажите его в PATH или поставьте вручную";
      return "";
    }
    logInfo(rt, `устанавливаю ${SERVER_NAME} через uv в ${DIR}`);
    const result = await runToLog(uv, ["tool", "install", SERVER_NAME], {
      env: {
        ...process.env,
        UV_TOOL_DIR: TOOL_DIR,
        UV_TOOL_BIN_DIR: TOOL_BIN_DIR,
        UV_PYTHON_INSTALL_DIR: PYTHON_DIR,
        UV_NO_MODIFY_PATH: "1",
      },
    });
    if (result.code !== 0) {
      rt.lastError = `установка ${SERVER_NAME} не удалась (код ${result.code}); вывод — в хвосте лога (если включена файловая песочница DSH — разрешите запись в ${DIR})`;
      return "";
    }
    const installed = detectCommand(true);
    if (!installed) rt.lastError = `установка прошла, но исполняемый файл не найден в ${TOOL_BIN_DIR}`;
    return installed;
  } finally {
    rt.installing = false;
  }
}

async function startServer(rt) {
  if (rt.child || rt.adopted || rt.starting) return snapshot(rt);
  rt.starting = true;
  rt.lastError = null;
  rt.lastExit = null;
  rt.version = null;
  try {
    const { config } = effectiveConfig(rt, true);

    const existing = await probeIdentity(config.port, 1500);
    if (existing.ok) {
      // Сервер уже поднят (остался от прошлой сессии) — второй не запускаем.
      const owner = portOwner(config.port, true);
      rt.adopted = { pid: rlmProcessTop(owner?.pid), listener: owner?.pid ?? null };
      rt.version = existing.version;
      rt.startedAt = Date.now();
      if (config.mcpAutoRegister) rt.mcpRegistration = registerInManagers(`http://${HOST}:${config.port}/mcp`);
      logInfo(rt, `сервер уже работает (pid ${rt.adopted.pid ?? "?"}), подключаюсь как внешний`);
      if (config.mcpAutoRegister) await syncManagerRecord(rt);
      return snapshot(rt);
    }
    if (existing.serverName) {
      rt.lastError = `порт ${config.port} занят другим MCP-сервером: ${existing.serverName}`;
      return snapshot(rt);
    }
    if (!config.command && config.autoInstall) {
      const installed = await autoInstall(rt);
      if (!installed) return snapshot(rt);
      config.command = installed;
      logInfo(rt, `установлен ${SERVER_NAME}: ${installed}`);
    }
    if (!config.command) {
      rt.lastError = `не найдена команда ${SERVER_NAME}: установите пакет (uv tool install ${SERVER_NAME}) или задайте путь ключом command в строке плагина`;
      return snapshot(rt);
    }

    mkdirSync(dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_ROTATE_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      // лога ещё нет
    }
    const header = `\n===== ${new Date().toISOString()} запуск: ${config.command} ${launchArgs(config).join(" ")}\n`;
    const handle = openSync(LOG_FILE, "a");
    try {
      writeFileSync(LOG_FILE, header, { encoding: "utf8", flag: "a" });
      const child = spawn(config.command, launchArgs(config), {
        cwd: DIR,
        env: { ...process.env, ...config.env },
        stdio: ["ignore", handle, handle],
        windowsHide: true,
        detached: false,
      });
      rt.child = child;
      rt.childPid = child.pid ?? null;
      rt.startedAt = Date.now();
      child.on("exit", (code, signal) => {
        if (rt.child !== child) return;
        rt.child = null;
        rt.childPid = null;
        rt.startedAt = null;
        rt.version = null;
        rt.lastExit = { code, signal: signal ?? null, at: new Date().toISOString() };
        if (!rt.stopping) rt.lastError = `процесс завершился сам (код ${code ?? signal ?? "?"}); хвост лога — ниже`;
      });
      child.on("error", (error) => {
        rt.lastError = "не удалось запустить процесс: " + (error?.message || String(error));
        // Процесс не запустился (нет pid) — состоянием не управляем, иначе статус «работает» врёт.
        if (!child.pid && rt.child === child) {
          rt.child = null;
          rt.childPid = null;
          rt.startedAt = null;
          rt.version = null;
        }
      });
    } finally {
      closeSync(handle);
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!rt.child) break;
      // spawn не удался (нет файла/прав): pid нет, ждать 30 секунд незачем
      if (!rt.childPid && rt.lastError) break;
      const probe = await probeIdentity(config.port, 1500);
      if (probe.ok) {
        rt.version = probe.version;
        logInfo(rt, `сервер поднят на ${HOST}:${config.port} (v${probe.version ?? "?"})`);
        break;
      }
      await sleep(400);
    }
    if (rt.version && config.mcpAutoRegister) {
      rt.mcpRegistration = registerInManagers(`http://${HOST}:${config.port}/mcp`);
      const touched = rt.mcpRegistration.filter((item) => item.action && item.action !== "unchanged").map((item) => item.manager);
      if (touched.length) logInfo(rt, "MCP-запись обновлена: " + touched.join(", "));
      await syncManagerRecord(rt);
    }
    if (!rt.version && !rt.lastError) {
      // Медленный первый старт (импорт python-пакета, установка CLI индекса) — одна
      // повторная проба: сервер мог подняться на последней секунде окна ожидания.
      const late = await probeIdentity(config.port, 3000);
      if (late.ok) {
        rt.version = late.version;
        logInfo(rt, `сервер поднят на ${HOST}:${config.port} (v${late.version ?? "?"})`);
      }
    }
    if (!rt.version) {
      if (!rt.lastError) {
        const owner = portOwner(config.port, true);
        const tree = rt.childPid ? processTree(rt.childPid) : null;
        const ours = Boolean(owner) && Boolean(tree) && tree.has(Number(owner.pid));
        rt.lastError = owner && !ours
          ? `порт ${config.port} занят процессом ${owner.image ?? "?"} (pid ${owner.pid})`
          : `сервер не ответил за ${Math.round(START_TIMEOUT_MS / 1000)} с; хвост лога — ниже`;
      }
      rt.lastError += writeHint();
    }
    return snapshot(rt);
  } finally {
    rt.starting = false;
  }
}

async function stopServer(rt) {
  const { config } = effectiveConfig(rt);
  const owned = rt.childPid;
  const adopted = rt.adopted?.pid ?? null;
  rt.stopping = true;
  try {
    if (owned) {
      killTree(owned);
    } else if (adopted && config.takeover) {
      // Сервер поднят не нами (остался от прошлой сессии): раз он на нашем порту — гасим вместе с DSH.
      killTree(adopted);
    }
    const freed = await waitPortFree(config.port, STOP_TIMEOUT_MS);
    rt.child = null;
    rt.childPid = null;
    rt.adopted = null;
    rt.version = null;
    rt.startedAt = null;
    rt.lastError = freed ? null : `порт ${config.port} всё ещё занят после остановки`;
    return snapshot(rt);
  } finally {
    rt.stopping = false;
  }
}

async function restartServer(rt) {
  const { config } = effectiveConfig(rt);
  await stopServer(rt);
  await waitPortFree(config.port, STOP_TIMEOUT_MS);
  return startServer(rt);
}
function saveSettings(rt, patch) {
  const next = { ...readRawSettings(), ...rt.settings };
  if (patch?.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("порт должен быть целым числом 1..65535");
    next.port = port;
  }
  next.$schema = SCHEMA;
  writeJson(SETTINGS_FILE, next);
  rt.settings = readSettings();
  return next;
}

// ── индекс rlm (rlm-bsl-index) ──────────────────────────────────────────────
//
// Индекс — отдельный файл bsl_index.db, который строит CLI rlm-bsl-index.
// Сервер им не управляет; плагин ведёт индексы по проектам: флаг «индексировать»,
// сборка и обновление, статус и автоматические прогоны (старт DSH, раз в неделю).
// Настройки лежат в том же settings.json — раздел index, чтобы файл оставался один.

const INDEX_COMMAND = process.platform === "win32" ? "rlm-bsl-index.exe" : "rlm-bsl-index";
const INDEX_LOG = join(DIR, "logs", "index.log");

/** Ответ CLI на неподдерживаемый формат источника: интерактивный вопрос или совет про флаг. */
const UNSUPPORTED_FORMAT = /allow-unsupported-format|unsupported format|\\[y\\/N\\]/i;
const INDEX_INFO_TIMEOUT_MS = 10_000;
const INDEX_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const INDEX_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_INFO_TTL_MS = 15_000;

let indexCommandCache = null;

function detectIndexCommand() {
  const now = Date.now();
  if (indexCommandCache && now - indexCommandCache.at < 15000) return indexCommandCache.value;
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, ["rlm-bsl-index"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  let value = "";
  if (found.status === 0) {
    value = String(found.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
  }
  if (!value) {
    for (const dir of [join(homedir(), ".local", "bin"), TOOL_BIN_DIR]) {
      const candidate = join(dir, INDEX_COMMAND);
      if (existsSync(candidate)) {
        value = candidate;
        break;
      }
    }
  }
  indexCommandCache = { at: now, value };
  return value;
}

function readRawSettings() {
  const raw = readJson(SETTINGS_FILE);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function readIndexConfig() {
  const raw = readRawSettings();
  const index = raw.index && typeof raw.index === "object" && !Array.isArray(raw.index) ? raw.index : {};
  const projects = {};
  if (index.projects && typeof index.projects === "object" && !Array.isArray(index.projects)) {
    for (const [key, value] of Object.entries(index.projects)) {
      if (value && typeof value === "object" && !Array.isArray(value)) projects[key] = { ...value };
    }
  }
  return {
    projects,
    autoOnStart: index.autoOnStart !== false,
    weekly: index.weekly !== false,
  };
}

function writeIndexConfig(patch) {
  const raw = readRawSettings();
  const current = raw.index && typeof raw.index === "object" && !Array.isArray(raw.index) ? raw.index : {};
  raw.index = { ...current, ...patch };
  raw.$schema = SCHEMA;
  writeJson(SETTINGS_FILE, raw);
}

function normalizeIndexPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    return resolve(text);
  } catch {
    return text;
  }
}

function sameIndexPath(a, b) {
  if (!a || !b) return false;
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function indexProjectKey(projects, path) {
  const wanted = normalizeIndexPath(path);
  if (!wanted) return null;
  for (const key of Object.keys(projects)) {
    if (sameIndexPath(key, wanted)) return key;
  }
  return null;
}

// Флаг «индексировать» живёт в параметрах проекта (.dsh/1c-project.json),
// рядом с базой и платформой: файл едет вместе с проектом.
function projectIndexFlag(path) {
  try {
    const data = readJson(join(path, ".dsh", "1c-project.json"));
    return data && typeof data.rlmIndex === "boolean" ? data.rlmIndex : null;
  } catch {
    return null;
  }
}

function indexRoot(rt) {
  const env = { ...process.env, ...effectiveConfig(rt).config.env };
  if (env.RLM_INDEX_DIR && env.RLM_INDEX_DIR.trim()) return env.RLM_INDEX_DIR.trim();
  if (env.RLM_CONFIG_FILE) return join(dirname(env.RLM_CONFIG_FILE), "index");
  return join(homedir(), ".cache", "rlm-tools-bsl");
}

function parseIndexInfo(text) {
  const pick = (re) => {
    const match = String(text).match(re);
    return match ? match[1].trim() : null;
  };
  const num = (re) => {
    const value = pick(re);
    return value ? Number(String(value).replace(/[^\d]/g, "")) || null : null;
  };
  return {
    dbPath: pick(/^Index:[ \t]*(.+)$/m),
    schema: pick(/^[ \t]+Index:[ \t]*(v\d+)[ \t]*$/m),
    statusText: pick(/^[ \t]*Status:[ \t]*(.+)$/m),
    config: pick(/^[ \t]*Config:[ \t]*(.+)$/m),
    format: pick(/^[ \t]*Format:[ \t]*(.+)$/m),
    modules: num(/^[ \t]*Modules:[ \t]*([\d \t]+)$/m),
    methods: num(/^[ \t]*Methods:[ \t]*([\d \t]+)$/m),
    calls: num(/^[ \t]*Calls:[ \t]*([\d \t]+)$/m),
    size: pick(/^[ \t]*DB size:[ \t]*(.+)$/m),
    built: pick(/^[ \t]*Built:[ \t]*(.+)$/m),
  };
}

function normalizeIndexStatus(statusText) {
  if (!statusText) return "unknown";
  if (/^fresh\b/i.test(statusText)) return "fresh";
  if (/^missing\b/i.test(statusText)) return "missing";
  if (/stale/i.test(statusText) && /content/i.test(statusText)) return "stale_content";
  if (/stale/i.test(statusText) && /structure/i.test(statusText)) return "stale_structure";
  if (/stale/i.test(statusText) && /age/i.test(statusText)) return "stale_age";
  return "unknown";
}

function runIndexInfo(cli, key, env) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cli, ["index", "info", key], {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // уже завершился
      }
    }, INDEX_INFO_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, text: String(error?.message || error) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, text: stdout + stderr });
    });
  });
}

async function indexInfo(rt, path, fresh = false) {
  const key = normalizeIndexPath(path);
  const cacheKey = key.toLowerCase();
  const cached = rt.index.infoCache.get(cacheKey);
  if (!fresh && cached && Date.now() - cached.at < INDEX_INFO_TTL_MS) return cached.value;
  const cli = detectIndexCommand();
  if (!cli) {
    const value = { ok: false, status: "unavailable", error: "rlm-bsl-index не найден: установите rlm-tools-bsl" };
    rt.index.infoCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  const run = await runIndexInfo(cli, key, { ...process.env, ...effectiveConfig(rt).config.env });
  const text = run.text;
  const parsed = parseIndexInfo(text);
  let value;
  if (run.code === 0 && parsed.statusText) {
    value = { ok: true, ...parsed, status: normalizeIndexStatus(parsed.statusText) };
  } else if (/not found|не найден|missing|нет индекса/i.test(text)) {
    value = { ok: true, status: "missing", statusText: "missing", error: text.trim().split("\n").slice(-3).join(" ") };
  } else {
    value = {
      ok: false,
      status: "error",
      error: text.trim().split("\n").slice(-5).join(" ") || "index info завершился с кодом " + run.code,
    };
  }
  rt.index.infoCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function appendIndexLog(text) {
  try {
    writeFileSync(INDEX_LOG, text, { encoding: "utf8", flag: "a" });
  } catch {
    // журнал недоступен — работа важнее
  }
}

function indexJobSnapshot(rt) {
  const job = rt.index.job;
  if (!job) return null;
  return {
    state: job.state,
    action: job.action,
    path: job.path,
    startedAt: job.startedAt,
    elapsedMs: job.startedMs ? Date.now() - job.startedMs : 0,
    code: job.code,
    error: job.error,
    auto: job.auto === true,
    partial: job.partial === true,
    lines: job.lines.slice(-40),
  };
}

function recordIndexResult(target, job) {
  const config = readIndexConfig();
  const key = indexProjectKey(config.projects, target);
  const entry = key ? config.projects[key] : { enabled: true };
  if (!key && job.state !== "done") return;
  entry.lastAttemptAt = new Date().toISOString();
  entry.lastAction = job.action;
  entry.partial = job.partial === true;
  if (job.state === "done") {
    entry.lastIndexAt = new Date().toISOString();
    entry.lastError = null;
    if (job.action === "build") entry.lastBuildAt = entry.lastIndexAt;
  } else if (job.state === "failed") {
    entry.lastError = job.error || "не удалось";
  }
  config.projects[key || target] = entry;
  writeIndexConfig({ projects: config.projects });
}

function startIndexJob(rt, path, action, options = {}) {
  const target = normalizeIndexPath(path);
  if (!target) throw Object.assign(new Error("не указан путь проекта"), { statusCode: 400 });
  if (!existsSync(target)) throw Object.assign(new Error("папка проекта не найдена: " + target), { statusCode: 400 });
  if (rt.index.job && rt.index.job.state === "running") {
    throw Object.assign(new Error("уже идёт " + rt.index.job.action + " индекса: " + rt.index.job.path), { statusCode: 409 });
  }
  const cli = detectIndexCommand();
  if (!cli) throw Object.assign(new Error("rlm-bsl-index не найден: установите rlm-tools-bsl"), { statusCode: 400 });
  const job = {
    id: ++rt.index.jobSeq,
    path: target,
    action: action === "update" ? "update" : "build",
    state: "running",
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    code: null,
    error: null,
    lines: [],
    auto: options.auto === true,
    pid: null,
    promise: null,
    resolve: null,
  };
  job.promise = new Promise((done) => {
    job.resolve = done;
  });
  mkdirSync(dirname(INDEX_LOG), { recursive: true });
  try {
    if (statSync(INDEX_LOG).size > LOG_ROTATE_BYTES) renameSync(INDEX_LOG, INDEX_LOG + ".1");
  } catch {
    // журнала ещё нет
  }
  appendIndexLog(`\n===== ${new Date().toISOString()} index ${job.action} ${target}\n`);
  const cliEnv = {
    ...process.env,
    ...effectiveConfig(rt).config.env,
    // CLI печатает ответы в кодировке консоли: без этого русский текст в журнале превращается в мусор.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  const collect = (chunk) => {
    const text = chunk.toString("utf8");
    appendIndexLog(text);
    const lines = text.split("\n").filter(Boolean);
    job.lines.push(...lines);
    if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
  };
  const finish = (state, code, error) => {
    if (job.state !== "running") return;
    job.state = state;
    job.code = code ?? null;
    if (error) job.error = error;
    job.finishedAt = new Date().toISOString();
    rt.index.infoCache.delete(target.toLowerCase());
    try {
      recordIndexResult(target, job);
    } catch {
      // запись настроек не должна скрывать результат сборки
    }
    job.resolve(indexJobSnapshot(rt));
  };
  // Источник, который CLI не считает поддерживаемым (выгрузка конфигурации в файлы против EDT),
  // раньше упирался в интерактивный вопрос «продолжить? [y/N]»: stdin закрыт, вопрос превращался
  // в ошибку, и индекс не собирался никогда. Повторяем один раз с явным флагом и помечаем такой
  // индекс неполным — это честнее, чем молча ждать полного.
  const launch = (extraArgs, retry) => {
    if (extraArgs.length > 0) {
      appendIndexLog("\n" + "формат источника не cf/EDT: повтор с " + extraArgs.join(" ") + " — индекс будет неполным\n");
    }
    const child = spawn(cli, ["index", job.action, ...extraArgs, target], {
      cwd: DIR,
      env: cliEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid ?? null;
    rt.index.job = job;
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      killTree(job.pid);
      finish("failed", null, "таймаут: " + Math.round(INDEX_JOB_TIMEOUT_MS / 60000) + " мин");
    }, INDEX_JOB_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      finish("failed", -1, error?.message || String(error));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish("done", 0, null);
        return;
      }
      if (!retry && UNSUPPORTED_FORMAT.test(job.lines.slice(-40).join("\n"))) {
        job.partial = true;
        launch(["--allow-unsupported-format"], true);
        return;
      }
      finish("failed", code, "index завершился с кодом " + code);
    });
  };
  launch([], false);
  return job;
}

function cancelIndexJob(rt) {
  const job = rt.index.job;
  if (!job || job.state !== "running") return indexJobSnapshot(rt);
  if (job.pid) killTree(job.pid);
  job.state = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.error = job.error || "отменено";
  rt.index.infoCache.delete(job.path.toLowerCase());
  try {
    recordIndexResult(job.path, job);
  } catch {
    // см. выше
  }
  job.resolve?.(indexJobSnapshot(rt));
  return indexJobSnapshot(rt);
}

// Проекты, для которых сборка уже запускалась открытием карточки в этой сессии.
// Нужен, чтобы GET /index/state не плодил прогоны при каждом перечитывании.
const indexAutoOpened = new Set();

async function indexState(rt, rawPath, options = {}) {
  const config = readIndexConfig();
  const path = normalizeIndexPath(rawPath);
  const key = path ? indexProjectKey(config.projects, path) : null;
  const entry = key ? config.projects[key] : path ? { enabled: false } : null;
  const fileFlag = path ? projectIndexFlag(path) : null;
  const bin = detectIndexCommand();
  const enabled = fileFlag !== null ? fileFlag : entry ? entry.enabled !== false : false;
  const index = path ? await indexInfo(rt, path) : null;
  // Открытие проекта — обещанный в подсказке триггер сборки, которого не было: авто-проход
  // знает только проекты, попавшие в settings после первого прогона, поэтому новый проект с
  // включённым флагом навсегда оставался «индекса нет» без единой попытки и без ошибки.
  // Запускаем только по явному признаку открытия карточки: обычное чтение состояния не должно
  // стартовать многочасовую сборку.
  let autoStarted = false;
  if (
    options.open === true &&
    path &&
    enabled &&
    bin &&
    index &&
    index.ok &&
    index.status === "missing" &&
    !(rt.index.job && rt.index.job.state === "running") &&
    !indexAutoOpened.has(path.toLowerCase())
  ) {
    indexAutoOpened.add(path.toLowerCase());
    try {
      const job = startIndexJob(rt, path, "build", { auto: true });
      job.promise
        .then(() => {
          // Неудача не должна закрывать проект до перезапуска: следующий раз соберём снова.
          if (job.state !== "done") indexAutoOpened.delete(path.toLowerCase());
        })
        .catch((error) => {
          indexAutoOpened.delete(path.toLowerCase());
          logInfo(rt, "сборка индекса при открытии проекта: " + (error?.message || String(error)));
        });
      autoStarted = true;
    }
    catch (error) {
      indexAutoOpened.delete(path.toLowerCase());
      logInfo(rt, "сборка индекса при открытии проекта: " + (error?.message || String(error)));
    }
  }
  return {
    ok: true,
    bin,
    root: indexRoot(rt),
    // Полный журнал прогонов; карточка показывает путь, чтобы ошибку можно было прочитать.
    logFile: INDEX_LOG,
    policy: { autoOnStart: config.autoOnStart, weekly: config.weekly },
    path,
    enabled,
    autoStarted,
    project: entry
      ? {
          lastIndexAt: entry.lastIndexAt ?? null,
          lastAction: entry.lastAction ?? null,
          lastError: entry.lastError ?? null,
          lastAttemptAt: entry.lastAttemptAt ?? null,
        }
      : null,
    index,
    job: rt.index.job ? indexJobSnapshot(rt) : null,
  };
}

async function autoIndexPass(rt, reason) {
  const config = readIndexConfig();
  if (reason === "start" && !config.autoOnStart) return;
  const entries = Object.entries(config.projects).filter(([, entry]) => entry && typeof entry === "object");
  if (!entries.length) return;
  if (rt.index.job && rt.index.job.state === "running") return;
  const now = Date.now();
  for (const [path, entry] of entries) {
    const flag = projectIndexFlag(path);
    if (flag === false) continue;
    if (flag === null && entry.enabled === false) continue;
    if (!existsSync(path)) continue;
    const last = entry.lastIndexAt ? Date.parse(entry.lastIndexAt) : 0;
    if (reason === "tick" && last && now - last < INDEX_WEEK_MS) continue;
    let info;
    try {
      info = await indexInfo(rt, path, true);
    } catch {
      continue;
    }
    if (!info || (!info.ok && info.status !== "missing")) continue;
    const missing = info.status === "missing";
    if (missing && reason === "tick") continue;
    try {
      const job = startIndexJob(rt, path, missing ? "build" : "update", { auto: true });
      await job.promise;
    } catch (error) {
      logInfo(rt, "автоиндекс: " + (error?.message || String(error)));
    }
  }
}

// ── плагин ─────────────────────────────────────────────────────────────────

export function applyRlm(ctx, config = {}) {
  const rt = createRuntime(ctx, config);

  const dispose = () => {
    if (rt.index.autoTimer) {
      clearInterval(rt.index.autoTimer);
      rt.index.autoTimer = null;
    }
    if (rt.index.job && rt.index.job.state === "running") cancelIndexJob(rt);
    return stopServer(rt);
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => dispose());
  } else if (typeof ctx.on === "function") {
    ctx.on("dispose", () => dispose());
  }

  // Аварийный путь: синхронное убийство при обычном завершении процесса DSH.
  process.once("exit", () => {
    const known = rt.childPid ?? rt.adopted?.pid ?? null;
    if (known) killTree(known);
    if (rt.index.job?.pid && rt.index.job.state === "running") killTree(rt.index.job.pid);
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/state",
    handler: (_req, res) => {
      try {
        json(res, 200, snapshot(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/log",
    handler: (req, res) => {
      try {
        const tail = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("tail")) || 200;
        json(res, 200, { ok: true, file: LOG_FILE, lines: tailLines(LOG_FILE, Math.min(Math.max(tail, 1), 500)) });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/start",
    handler: async (_req, res) => {
      try {
        json(res, 200, await startServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/stop",
    handler: async (_req, res) => {
      try {
        json(res, 200, await stopServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/restart",
    handler: async (_req, res) => {
      try {
        json(res, 200, await restartServer(rt));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/save",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const before = effectiveConfig(rt).config.port;
        saveSettings(rt, body?.settings ?? {});
        const after = effectiveConfig(rt).config.port;
        json(res, 200, { ...snapshot(rt), needsRestart: before !== after && Boolean(rt.child || rt.adopted) });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/index/state",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        // `open=1` — карточка проекта открылась: это триггер сборки, которого раньше не было.
        json(res, 200, await indexState(rt, url.searchParams.get("path"), { open: url.searchParams.get("open") === "1" }));
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/index/config",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const path = normalizeIndexPath(body?.path);
        if (!path) throw Object.assign(new Error("не указан путь проекта"), { statusCode: 400 });
        const config = readIndexConfig();
        if (body.enabled !== undefined) {
          const key = indexProjectKey(config.projects, path);
          const entry = key ? config.projects[key] : {};
          entry.enabled = body.enabled !== false;
          config.projects[key || path] = entry;
        }
        const patch = { projects: config.projects };
        if (body.autoOnStart !== undefined) patch.autoOnStart = body.autoOnStart !== false;
        if (body.weekly !== undefined) patch.weekly = body.weekly !== false;
        writeIndexConfig(patch);
        json(res, 200, await indexState(rt, path, { open: true }));
      } catch (error) {
        json(res, error?.statusCode || 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/index/job",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        startIndexJob(rt, body?.path, body?.action);
        json(res, 202, { ok: true, job: indexJobSnapshot(rt) });
      } catch (error) {
        json(res, error?.statusCode || 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/index/cancel",
    handler: async (_req, res) => {
      try {
        json(res, 200, { ok: true, job: cancelIndexJob(rt) });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Тесты и диагностика грузят плагин без движка: autostart отключается флагом.
  if (config.autoStart === false) return;

  startServer(rt)
    .then(() => {
      // Первый проход после готовности сервера: даём python-процессу подняться.
      const kick = setTimeout(() => {
        autoIndexPass(rt, "start").catch((error) => logInfo(rt, "автоиндекс: " + (error?.message || String(error))));
      }, 8000);
      kick.unref?.();
      rt.index.autoTimer = setInterval(() => {
        autoIndexPass(rt, "tick").catch((error) => logInfo(rt, "автоиндекс: " + (error?.message || String(error))));
      }, 60 * 60 * 1000);
      rt.index.autoTimer.unref?.();
    })
    .catch((error) => {
      rt.lastError = "автозапуск не удался: " + (error?.message || String(error));
    });
}
