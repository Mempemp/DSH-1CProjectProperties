// Синхронизация записи в менеджере MCP. Окно загрузки менеджера закрывается раньше, чем
// наш сервер начинает отвечать: он оставляет запись «не подключена» и сам её не пересчитывает.
// После готовности плагин должен попросить менеджер о пересмонтировании — но не рвать уже
// живое соединение. Мок ctx отдаёт сервис mcpManager через get().
//
// Сценарии: холодный запуск с застрявшим вердиктом (настоящий rlm-tools-bsl),
// подхват внешнего сервера с вердиктом connected, отсутствие сервиса.
//
// Запуск: node test/rlm-manager-sync.smoke.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PORT_BASE = 9341;

function check(name, ok, details) {
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (details ? "  [" + details + "]" : ""));
  return Boolean(ok);
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

/** Мок ctx с сервисом менеджера: getStatus отдаёт заданный вердикт, reconnect пишет вызов. */
function makeCtx(scenario, calls, refs) {
  const routes = [];
  const ctx = {
    webServer: { register: (spec) => routes.push(spec) },
    effect: () => {},
    on: () => {},
    logger: { info: (message) => console.log("  host: " + message) },
  };
  if (scenario === "cold-stale" || scenario === "adopted-connected") {
    const status = scenario === "cold-stale" ? "failed" : "connected";
    ctx.get = (name) =>
      name === "mcpManager"
        ? {
            getStatus: () => ({ name: "rlm", status }),
            // Свежее состояние читаем сами в момент вызова: пересмонтирование обязано
            // идти только после того, как сервер начал отвечать.
            reconnect: async (serverName) => {
              const fresh = refs.base
                ? await fetch(refs.base + "/rlm/state").then((response) => response.json()).catch(() => null)
                : null;
              calls.push({ serverName, versionAtCall: fresh?.server?.version ?? null });
            },
          }
        : undefined;
  }
  return { ctx, routes };
}

/** Заглушка MCP-сервера: /health и initialize с именем, которое ждёт плагин. */
function fakeServer(port) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"rlm-tools-bsl","version":"1.42.0"}}}\n\n';
    res.writeHead(200, { "content-type": "text/event-stream" }).end(body);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

async function child(scenario, port) {
  const calls = [];
  const refs = { base: null };
  const { ctx, routes } = makeCtx(scenario, calls, refs);
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = routes.find((item) => item.kind === "exact" && item.path === url.pathname);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    await route.handler(req, res);
  });
  await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + httpServer.address().port;
  refs.base = base;

  const config = { port, mcpAutoRegister: true };
  if (scenario === "cold-stale") {
    const command = binPath();
    if (!command) {
      console.log("SKIP — rlm-tools-bsl не найден (uv tool install rlm-tools-bsl)");
      httpServer.close();
      return true;
    }
    config.command = command;
  }

  const plugin = await import(new URL("../lib/rlm-runner.js", import.meta.url).href);
  plugin.applyRlm(ctx, config);

  const deadline = Date.now() + 45000;
  let state = null;
  while (Date.now() < deadline) {
    state = await fetch(base + "/rlm/state")
      .then((response) => response.json())
      .catch(() => null);
    if (state?.server?.version && (calls.length || scenario !== "cold-stale")) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  // Дать пересмонтированию записаться, если оно вот-вот случится.
  await new Promise((done) => setTimeout(done, 800));

  const ok = [];
  ok.push(check("сервер запущен", Boolean(state?.server?.version), JSON.stringify(state?.server?.lastError ?? null)));
  if (scenario === "cold-stale") {
    ok.push(check("застрявший вердикт: запись пересмонтирована", calls.length === 1, JSON.stringify(calls)));
    ok.push(check("пересмонтирование после готовности сервера", Boolean(calls[0]?.versionAtCall), JSON.stringify(calls)));
  } else if (scenario === "adopted-connected") {
    ok.push(check("вердикт connected: соединение не рвём", calls.length === 0, JSON.stringify(calls)));
    ok.push(check("сервер подхвачен как внешний", state?.server?.adopted === true, JSON.stringify(state?.server?.lastError ?? null)));
  } else {
    ok.push(check("без сервиса менеджера: вызовов нет", calls.length === 0));
    ok.push(check("сервер подхвачен как внешний", state?.server?.adopted === true, JSON.stringify(state?.server?.lastError ?? null)));
  }

  httpServer.close();
  return ok.every(Boolean);
}

const [mode, arg] = process.argv.slice(2);

if (mode === "fake") {
  const server = await fakeServer(Number(arg));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (mode === "child") {
  process.env.DSH_HOME = process.env.DSH_SYNC_HOME;
  const passed = await child(arg, Number(process.env.DSH_SYNC_PORT));
  process.exit(passed ? 0 : 1);
} else {
  const scenarios = ["cold-stale", "adopted-connected", "no-service"];
  let failed = 0;
  for (const [index, name] of scenarios.entries()) {
    const port = PORT_BASE + index;
    const home = mkdtempSync(join(tmpdir(), `dsh-rlm-sync-${name}-`));
    let fake = null;
    if (name !== "cold-stale") {
      fake = spawn(process.execPath, [SELF, "fake", String(port)], { stdio: "ignore" });
      await new Promise((done) => setTimeout(done, 600));
    }
    console.log(`\n── ${name}`);
    const run = spawnSync(process.execPath, [SELF, "child", name], {
      env: { ...process.env, DSH_SYNC_HOME: home, DSH_SYNC_PORT: String(port) },
      stdio: "inherit",
    });
    if (run.status !== 0) {
      failed += 1;
      console.log(`   выход сценария: status=${run.status} signal=${run.signal} error=${run.error ?? ""}`);
    }
    try {
      fake?.kill();
    } catch {
      // заглушку уже погасил плагин
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} сценариев пройдено`);
  process.exit(failed ? 1 : 0);
}
