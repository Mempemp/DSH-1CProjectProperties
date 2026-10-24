// E2E хост-половины без DSH: мок ctx (webServer.register записывается) + реальный http-сервер,
// поверх — настоящий rlm-tools-bsl. Проверяет автозапуск, подхват внешнего процесса,
// перезапуск, остановку и роуты. Настройки и логи пишутся в отдельный DSH_HOME во временном каталоге.
//
// Запуск: node test/rlm-http.smoke.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PORT = 9331;
const DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-rlm-test-"));
process.env.DSH_HOME = DSH_HOME;

const checks = [];
function check(name, ok, details) {
  checks.push({ name, ok: Boolean(ok) });
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (details ? "  [" + details + "]" : ""));
}

function binPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(probe, ["rlm-tools-bsl"], { encoding: "utf8", windowsHide: true });
  if (found.status === 0) {
    const first = String(found.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  const portable = join(homedir(), ".local", "bin", process.platform === "win32" ? "rlm-tools-bsl.exe" : "rlm-tools-bsl");
  return existsSync(portable) ? portable : null;
}

async function reachable(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

const command = binPath();
if (!command) {
  console.log("SKIP — rlm-tools-bsl не найден (uv tool install rlm-tools-bsl)");
  process.exit(2);
}

// ── мок DSH-контекста ──────────────────────────────────────────────────────

const routes = [];
const disposers = [];
const ctx = {
  webServer: { register: (spec) => routes.push(spec) },
  effect: (factory) => {
    const dispose = factory();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  on: () => {},
  logger: { info: (message) => console.log("  host: " + message) },
};

const plugin = await import(new URL("../lib/rlm-runner.js", import.meta.url).href);
plugin.applyRlm(ctx, { port: PORT, command });

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = routes.find((item) => item.kind === "exact" && item.path === url.pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false,"error":"no route"}');
    return;
  }
  await route.handler(req, res);
});
await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + httpServer.address().port;

async function api(path, init) {
  const response = await fetch(base + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function waitState(predicate, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await api("/rlm/state")).data;
    if (last && predicate(last)) return last;
    await new Promise((done) => setTimeout(done, 500));
  }
  return last;
}

let exitCode = 0;
try {
  // ── 1. автозапуск при apply ──────────────────────────────────────────────
  // running появляется сразу после спавна; version — когда сервер ответил на initialize.
  const started = await waitState((state) => state.server.running && state.server.version);
  check("сервер стартует сам при загрузке плагина (apply)", started?.server?.running === true && started.server.managed === true, JSON.stringify(started?.server?.lastError ?? null));
  check("pid получен", Number.isInteger(started?.server?.pid) && started.server.pid > 0, String(started?.server?.pid));
  check("версия прочитана из MCP initialize", /^\d+\.\d+/.test(String(started?.server?.version)), String(started?.server?.version));
  check("health сервера отвечает", await reachable(`http://127.0.0.1:${PORT}/health`));
  check("команда определена", started?.config?.command === command, String(started?.config?.command));
  check("порт из строки плагина", started?.config?.port === PORT);
  check("сниппет MCP содержит URL", started?.mcp?.snippet?.includes(`http://127.0.0.1:${PORT}/mcp`));

  // ── 2. повторный start идемпотентен ──────────────────────────────────────
  const again = await api("/rlm/start", { method: "POST" });
  check("повторный start не поднимает второй процесс", again.data?.server?.managed === true && again.data.server.pid === started.server.pid);

  // ── 3. лог и настройки ───────────────────────────────────────────────────
  const log = await api("/rlm/log?tail=50");
  check("GET /rlm/log отдаёт строки", log.status === 200 && Array.isArray(log.data.lines) && log.data.lines.length > 0, "строк: " + (log.data?.lines?.length ?? 0));
  check("в логе есть заголовок запуска", (log.data.lines || []).some((line) => line.includes("запуск:")));

  const saved = await api("/rlm/save", { method: "POST", body: JSON.stringify({ settings: { port: PORT } }) });
  check("POST /rlm/save сохраняет без перезапуска", saved.status === 200 && saved.data.needsRestart === false);
  const settingsFile = join(DSH_HOME, "rlm-tools-bsl", "settings.json");
  check("settings.json записан", existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf-8")).port === PORT, settingsFile);

  const badSave = await api("/rlm/save", { method: "POST", body: JSON.stringify({ settings: { port: "не-число" } }) });
  check("save с плохим портом отклоняется", badSave.status === 400);

  // ── 4. перезапуск ────────────────────────────────────────────────────────
  const restarted = await api("/rlm/restart", { method: "POST" });
  check("POST /rlm/restart поднимает сервер заново", restarted.data?.server?.running === true);
  check("pid после перезапуска другой", restarted.data.server.pid !== started.server.pid, `${started.server.pid} → ${restarted.data.server.pid}`);

  // ── 5. остановка ─────────────────────────────────────────────────────────
  const stopped = await api("/rlm/stop", { method: "POST" });
  check("POST /rlm/stop гасит сервер", stopped.data?.server?.running === false && stopped.data.server.lastError === null);
  check("порт освобождён", !(await reachable(`http://127.0.0.1:${PORT}/health`)));

  // ── 6. подхват внешнего процесса и takeover ──────────────────────────────
  const external = spawn(command, ["--transport", "streamable-http", "--host", "127.0.0.1", "--port", String(PORT)], {
    stdio: "ignore",
    windowsHide: true,
    detached: false,
  });
  const ready = Date.now() + 20000;
  while (Date.now() < ready && !(await reachable(`http://127.0.0.1:${PORT}/health`))) {
    await new Promise((done) => setTimeout(done, 400));
  }
  check("внешний процесс поднялся (подготовка сценария)", await reachable(`http://127.0.0.1:${PORT}/health`));

  const adopted = await api("/rlm/start", { method: "POST" });
  check("start подхватывает внешний процесс", adopted.data?.server?.adopted === true && adopted.data.server.managed === false);
  check("версия внешнего процесса прочитана", /^\d+\.\d+/.test(String(adopted.data.server.version)));

  const takenOver = await api("/rlm/stop", { method: "POST" });
  check("stop гасит и подхваченный процесс (takeover)", takenOver.data?.server?.running === false);
  check("порт внешнего процесса освобождён", !(await reachable(`http://127.0.0.1:${PORT}/health`)));
  try {
    external.kill();
  } catch {
    // уже убит через taskkill
  }

  // ── 7. остановка DSH гасит управляемый процесс ───────────────────────────
  const beforeDispose = await api("/rlm/start", { method: "POST" });
  check("сервер поднят для проверки dispose", beforeDispose.data?.server?.running === true && beforeDispose.data.server.managed === true);
  for (const dispose of disposers) await dispose();
  check("dispose гасит управляемый процесс", !(await reachable(`http://127.0.0.1:${PORT}/health`)));

  // ── 8. недоступная команда: ошибка без ожидания таймаута ─────────────────
  const routes2 = [];
  const ctx2 = {
    webServer: { register: (spec) => routes2.push(spec) },
    effect: () => {},
    on: () => {},
    logger: { info: () => {} },
  };
  const t0 = Date.now();
  plugin.applyRlm(ctx2, { port: PORT + 1, command: "C:\\нет\\такого\\rlm-tools-bsl.exe" });
  const server2 = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = routes2.find((item) => item.kind === "exact" && item.path === url.pathname);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    await route.handler(req, res);
  });
  await new Promise((done) => server2.listen(0, "127.0.0.1", done));
  const base2 = "http://127.0.0.1:" + server2.address().port;
  let failedState = null;
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    failedState = await fetch(base2 + "/rlm/state").then((r) => r.json()).catch(() => null);
    if (failedState && !failedState.server.running && failedState.server.lastError) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  check("недоступная команда: ошибка видна без ожидания таймаута", Date.now() - t0 < 15000, ((Date.now() - t0) / 1000).toFixed(1) + " с");
  check("текст ошибки объясняет причину", /не удалось запустить|завершился сам/.test(String(failedState?.server?.lastError)), String(failedState?.server?.lastError).slice(0, 90));
  await new Promise((done) => server2.close(done));

  // ── 9. автопрописка в менеджеры MCP ─────────────────────────────────────
  // Менеджер 0.2.5+ читает список в своей папке; файл в корне $DSH_HOME остался
  // от версий до 0.2.5 и в панели не виден — в него писать нельзя.
  const managerStore = join(DSH_HOME, "@wingsky-1", "dsh-mcp-manager", "mcp.json");
  const legacyStore = join(DSH_HOME, "dsh-mcp.json");
  mkdirSync(dirname(managerStore), { recursive: true });
  writeFileSync(managerStore, JSON.stringify({ version: 1, servers: [{ name: "чужой", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", enabled: true }] }, null, 2));
  writeFileSync(legacyStore, JSON.stringify({ version: 1, servers: [{ name: "остаток", transport: "stdio", command: "x" }] }, null, 2));

  const startedForMcp = await api("/rlm/start", { method: "POST" });
  const current = JSON.parse(readFileSync(managerStore, "utf-8"));
  check("rlm добавлен в хранилище менеджера 0.2.5+ (name)", current.servers.some((s) => s.name === "rlm" && s.url === `http://127.0.0.1:${PORT}/mcp`));
  check("посторонняя запись сохранена", current.servers.some((s) => s.name === "чужой"));
  check("файл-предшественник не тронут", JSON.parse(readFileSync(legacyStore, "utf-8")).servers.every((s) => s.name !== "rlm"));
  check("состояние показывает прописку", (startedForMcp.data?.mcp?.registration || []).some((item) => item.action === "added"));

  const restartedForMcp = await api("/rlm/restart", { method: "POST" });
  const current2 = JSON.parse(readFileSync(managerStore, "utf-8"));
  const ours = (restartedForMcp.data?.mcp?.registration || []).filter((item) => item.manager === "@wingsky-1/dsh-mcp-manager");
  check("повторный запуск не дублирует и не меняет запись", current2.servers.filter((s) => s.name === "rlm").length === 1 && ours.length === 1 && ours[0].action === "unchanged", JSON.stringify(restartedForMcp.data?.mcp?.registration ?? null).slice(0, 160));
} catch (error) {
  console.log("FAIL — исключение в сценарии: " + (error?.stack || error));
  exitCode = 1;
} finally {
  await new Promise((done) => httpServer.close(done));
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      console.log("disposer: " + error);
    }
  }
}

const failed = checks.filter((item) => !item.ok);
console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " проверок пройдено");
if (failed.length) exitCode = 1;
console.log("DSH_HOME теста: " + DSH_HOME);
process.exit(exitCode);
