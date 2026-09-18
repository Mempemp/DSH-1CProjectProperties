// Проверка хост-обвязки платформенного контекста: маршруты, перезапуск по смене
// пути к платформе и отдача сервера в MCP-менеджер.
//
// Запуск: node test/platform-context-host.smoke.mjs
//
// Тест поднимает apply() плагина на поддельном ctx (webServer + поддельный
// mcpManager) в изолированном $DSH_HOME и проходит сценарий первой установки:
// путь к платформе не задан — сервер поднят, но менеджеру не отдан; путь задан
// через POST /1cprops/common — сервер перезапущен с индексом и отдан менеджеру.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-platform-context-host-test-" + process.pid);

// $DSH_HOME читается плагином при импорте — задаём до загрузки модуля.
process.env.DSH_HOME = join(work, "home");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

function findPlatform() {
  const roots = [
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ];
  const found = [];
  for (const root of roots) {
    const base = join(root, "1cv8");
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bin = join(base, entry.name, "bin");
      if (existsSync(join(bin, "1cv8.exe")) && existsSync(join(bin, "shcntx_ru.hbk"))) found.push(bin);
    }
  }
  return found.sort().pop() || "";
}

const routes = new Map();
const disposers = [];
const managerCalls = [];
const fakeManager = {
  async registerServer(server) {
    managerCalls.push({ method: "registerServer", server });
    return { name: server.name, existing: false };
  },
  async unregisterServer(name) {
    managerCalls.push({ method: "unregisterServer", name });
  },
  getStatus: (name) => ({ name, status: "connected", transport: "streamable-http", tools: [], enabled: true }),
  async reconnect(name) {
    managerCalls.push({ method: "reconnect", name });
  },
};

function fakeResponse() {
  const captured = { code: 0, body: "" };
  return {
    captured,
    writeHead(code) {
      captured.code = code;
    },
    end(body) {
      captured.body = body || "";
    },
  };
}

function request(body) {
  // readBody склеивает чанки через Buffer.concat — отдаём Buffer, а не строку.
  const payload = Buffer.from(body === undefined ? "" : JSON.stringify(body), "utf8");
  const stream = Readable.from([payload]);
  stream.url = "";
  return stream;
}

function callRoute(path, body) {
  const handler = routes.get(path);
  if (!handler) throw new Error("маршрут не зарегистрирован: " + path);
  const res = fakeResponse();
  return Promise.resolve(handler(request(body), res)).then(() => ({
    code: res.captured.code,
    json: JSON.parse(res.captured.body || "{}"),
  }));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last?.done) return last;
    await new Promise((done) => setTimeout(done, 500));
  }
  return last;
}

mkdirSync(process.env.DSH_HOME, { recursive: true });
const { apply } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);

const ctx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  workspaceRegistry: {},
  on: (event, handler) => {
    if (event === "dispose") disposers.push(handler);
  },
  get: (name) => (name === "mcpManager" ? fakeManager : undefined),
  inject: (deps, callback) => callback(ctx),
};

apply(ctx);

console.log("первая установка: путь к платформе не задан");
check("роут статуса зарегистрирован", routes.has("/1cprops/platform-context"));
check("роут перезапуска зарегистрирован", routes.has("/1cprops/platform-context-restart"));

const first = await waitFor(
  async () => {
    const status = await callRoute("/1cprops/platform-context");
    return { done: status.json.running === true, status: status.json };
  },
  30_000,
);
check("сервер поднят без пути", first.status?.running === true, first.status?.error);
check("индекс не собран", first.status?.indexLoaded === false);
check("менеджеру сервер не отдан", first.status?.managerRegistered === false);
check("менеджер не получал регистраций", managerCalls.length === 0, JSON.stringify(managerCalls));
check("статус объясняет, чего не хватает", String(first.status?.platformError || "").includes("не задан"));

const platform = findPlatform();
if (!platform) {
  console.log("платформа 1С не найдена — дальше проверяем только смену пути");
} else {
  console.log("путь к платформе задан через общие настройки");
  const saved = await callRoute("/1cprops/common", { platformPath: join(platform, "1cv8.exe") });
  check("общие настройки сохранены", saved.code === 200 && saved.json.common.platformPath.endsWith("1cv8.exe"));

  const ready = await waitFor(
    async () => {
      const status = await callRoute("/1cprops/platform-context");
      return { done: status.json.indexLoaded === true && status.json.managerRegistered === true, status: status.json };
    },
    150_000,
  );
  check("индекс собран после смены пути", ready.status?.indexLoaded === true, ready.status?.error);
  check("сервер отдан MCP-менеджеру", ready.status?.managerRegistered === true);
  check("адрес — streamable-http на loopback", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(ready.status?.url || ""), ready.status?.url);
  const registered = managerCalls.find((call) => call.method === "registerServer");
  check("менеджер получил имя и транспорт", registered?.server?.name === "1c-platform-context" && registered?.server?.transport === "streamable-http", JSON.stringify(registered));
  check("конфиг сервера лежит в $DSH_HOME", String(ready.status?.configFile || "").startsWith(process.env.DSH_HOME), ready.status?.configFile);

  const stateRoute = await callRoute("/1cprops/state");
  check("общий роут состояния несёт статус справки", stateRoute.json.platformContext?.running === true);

  console.log("остановка");
  for (const dispose of disposers) dispose();
  await new Promise((done) => setTimeout(done, 800));
  const stopped = await callRoute("/1cprops/platform-context");
  check("после dispose сервер не живёт", stopped.json.running === false);
  check("менеджер получил снятие с учёта", managerCalls.some((call) => call.method === "unregisterServer"));
}

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nвсе проверки пройдены" : "\nпровалено проверок: " + failures);
process.exit(failures === 0 ? 0 : 1);
