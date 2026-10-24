// Раскладки хранилища менеджера MCP: в какой файл плагин пишет запись сервера.
// Установленный rlm-tools-bsl не нужен: на порту сценария живёт заглушка (режим
// `fake`), плагин подхватывает её как внешний сервер и прописывает себя тем же
// путём, что и на живой машине. Каждый сценарий — отдельный процесс: DSH_HOME
// читается модулем при загрузке, а при выходе плагин гасит подхваченный процесс,
// поэтому заглушка должна быть не в нём самом, а рядом.
//
// Запуск: node test/rlm-mcp-store.smoke.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const MANAGER_PACKAGE = "@wingsky-1/dsh-mcp-manager";
const PORT_BASE = 9337;

const storePath = (home) => join(home, MANAGER_PACKAGE, "mcp.json");
const legacyPath = (home) => join(home, "dsh-mcp.json");
const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));
const namesIn = (file) =>
  existsSync(file) ? (readJson(file).servers || []).map((server) => server.name ?? server.serverName) : [];

function check(name, ok, details) {
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (details ? "  [" + details + "]" : ""));
  return Boolean(ok);
}

const storeDocument = (name, url) => ({
  version: 1,
  servers: [{ name, transport: "streamable-http", url, enabled: true }]
});

function writeManagerPackage(home, version) {
  const dir = join(home, "profiles", "node_modules", MANAGER_PACKAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: MANAGER_PACKAGE, version }));
}

function prepare(home, scenario) {
  if (scenario === "current-wins") {
    // Менеджер 0.2.5+ уже держит список у себя, а файл-предшественник остался:
    // именно в него писали плагины прошлых выпусков.
    mkdirSync(dirname(storePath(home)), { recursive: true });
    writeFileSync(storePath(home), JSON.stringify(storeDocument("чужой", "http://127.0.0.1:1/mcp"), null, 2));
    writeFileSync(
      legacyPath(home),
      JSON.stringify({ version: 1, servers: [{ name: "остаток", transport: "stdio", command: "x" }] }, null, 2)
    );
    return;
  }
  if (scenario === "legacy-file") {
    // Менеджера в профилях не видно, но его файл-предшественник на диске: список
    // уже есть, и читает его менеджер до 0.2.5 (иначе файл перенесёт актуальный).
    writeFileSync(legacyPath(home), JSON.stringify(storeDocument("чужой", "http://127.0.0.1:1/mcp"), null, 2));
    return;
  }
  // Менеджер установлен, своей папки ещё не завёл: раскладку выдаёт версия пакета.
  writeManagerPackage(home, scenario === "old-manager" ? "0.2.4" : "0.2.7");
}

function verify(home, scenario, url) {
  const current = namesIn(storePath(home));
  const legacy = namesIn(legacyPath(home));
  const ok = [];
  if (scenario === "current-wins") {
    ok.push(check("менеджер 0.2.5+ получает запись в свой файл", current.includes("rlm"), current.join(", ")));
    ok.push(check("посторонняя запись сохранена", current.includes("чужой")));
    ok.push(
      check(
        "URL сервера записан",
        existsSync(storePath(home)) &&
          readJson(storePath(home)).servers.some((server) => server.name === "rlm" && server.url === url)
      )
    );
    ok.push(check("файл-предшественник не тронут", legacy.join(",") === "остаток", legacy.join(",")));
    return ok.every(Boolean);
  }
  if (scenario === "legacy-file" || scenario === "old-manager") {
    const why = scenario === "legacy-file" ? "файл-предшественник на диске" : "менеджер 0.2.4";
    ok.push(check(`${why}: запись уходит в файл, который он читает`, legacy.includes("rlm"), legacy.join(", ")));
    if (scenario === "legacy-file") ok.push(check("посторонняя запись сохранена", legacy.includes("чужой")));
    ok.push(check("файл новой раскладки не создаётся", !existsSync(storePath(home))));
    return ok.every(Boolean);
  }
  ok.push(check("менеджер 0.2.7 без своей папки: пишем в новую раскладку", current.includes("rlm"), current.join(", ")));
  ok.push(check("старый файл не создаётся", !existsSync(legacyPath(home))));
  return ok.every(Boolean);
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

async function child(home, scenario, port) {
  const routes = [];
  const ctx = {
    webServer: { register: (spec) => routes.push(spec) },
    effect: () => {},
    on: () => {},
    logger: { info: () => {} }
  };
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

  const plugin = await import(new URL("../lib/rlm-runner.js", import.meta.url).href);
  plugin.applyRlm(ctx, { port, mcpAutoRegister: true });

  const deadline = Date.now() + 20000;
  let state = null;
  while (Date.now() < deadline) {
    state = await fetch(base + "/rlm/state")
      .then((response) => response.json())
      .catch(() => null);
    if (state?.mcp?.registration?.length) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  const adopted = check(
    "сервер подхвачен как внешний",
    state?.server?.adopted === true,
    JSON.stringify(state?.server?.lastError ?? null)
  );
  const reported = check(
    "прописка отчиталась",
    (state?.mcp?.registration || []).some((item) => item.action),
    JSON.stringify(state?.mcp?.registration ?? null).slice(0, 130)
  );
  const stored = verify(home, scenario, `http://127.0.0.1:${port}/mcp`);

  httpServer.close();
  return adopted && reported && stored;
}

const [mode, arg] = process.argv.slice(2);

if (mode === "fake") {
  // Живёт до taskkill от плагина (он гасит подхваченный процесс при выходе).
  const server = await fakeServer(Number(arg));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (mode === "child") {
  process.env.DSH_HOME = process.env.DSH_STORE_HOME;
  const passed = await child(process.env.DSH_STORE_HOME, arg, Number(process.env.DSH_STORE_PORT));
  process.exit(passed ? 0 : 1);
} else {
  const scenarios = ["current-wins", "legacy-file", "fresh", "old-manager"];
  let failed = 0;
  for (const [index, name] of scenarios.entries()) {
    const port = PORT_BASE + index;
    const home = mkdtempSync(join(tmpdir(), `dsh-rlm-store-${name}-`));
    prepare(home, name);
    const fake = spawn(process.execPath, [SELF, "fake", String(port)], { stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 600));
    console.log(`\n── ${name}`);
    const run = spawnSync(process.execPath, [SELF, "child", name], {
      env: { ...process.env, DSH_STORE_HOME: home, DSH_STORE_PORT: String(port) },
      stdio: "inherit"
    });
    if (run.status !== 0) {
      failed += 1;
      console.log(`   выход сценария: status=${run.status} signal=${run.signal} error=${run.error ?? ""}`);
    }
    try {
      fake.kill();
    } catch {
      // заглушку уже погасил плагин
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} сценариев пройдено`);
  process.exit(failed ? 1 : 0);
}
