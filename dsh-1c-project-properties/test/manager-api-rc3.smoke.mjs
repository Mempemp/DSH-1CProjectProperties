// Проверка работы с MCP-менеджером новой линии (0.2.2-rc.3): регистрация через
// register(name, entry), снятие возвращаемым disposer'ом, состояние из list().
//
// Запуск: node test/manager-api-rc3.smoke.mjs
//
// Поддельный менеджер объявляет ТОЛЬКО новый API: registerServer, unregisterServer,
// getStatus и reconnect отсутствуют — именно их отсутствие ломало карточку
// («service.registerServer is not a function»). Плагин обязан работать через
// register(), снимать сервер disposer'ом и не падать, когда имя уже занято.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-manager-api-test-" + process.pid);
mkdirSync(work, { recursive: true });

const fakeServer = join(work, "fake-naparnik.mjs");
writeFileSync(
  fakeServer,
  `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    return reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
  }
  if (msg.method === "tools/call") {
    return reply(msg.id, { content: [{ type: "text", text: "эхо" }] });
  }
  if (msg.id !== undefined) reply(msg.id, {});
});
`,
  "utf8",
);

process.env.DSH_HOME = join(work, "home");
const fakeBinary = join(work, "bsl-analyzer-app.exe");
writeFileSync(fakeBinary, "stub", "utf8");
process.env.DSH_BSL_CHECKER_BIN = fakeBinary;
process.env.DSH_NAPARMIK_COMMAND = process.execPath;
process.env.DSH_NAPARMIK_ARGS = JSON.stringify([fakeServer]);

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

const routes = new Map();
const registrations = new Map();
const managerCalls = [];
// Второй сценарий: имя занято — менеджер бросает ту же ошибку, что и в rc.3.
let rejectName = "";

const fakeManager = {
  register(name, entry) {
    managerCalls.push({ method: "register", name, entry });
    if (rejectName && name === rejectName) {
      throw new Error(`mcp-manager: server "${name}" is already configured or registered`);
    }
    let alive = true;
    registrations.set(name, entry);
    return () => {
      if (!alive) return;
      alive = false;
      registrations.delete(name);
      managerCalls.push({ method: "dispose", name });
    };
  },
  list() {
    return [...registrations.entries()].map(([name, entry]) => ({
      name,
      status: "connected",
      transport: entry.transport,
      enabled: true,
      tools: [],
    }));
  },
  async restart(name) {
    managerCalls.push({ method: "restart", name });
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

function request(body, method) {
  const payload = Buffer.from(body === undefined ? "" : JSON.stringify(body), "utf8");
  const stream = Readable.from([payload]);
  stream.url = "";
  stream.method = method || "GET";
  return stream;
}

function callRoute(path, body, method) {
  const handler = routes.get(path);
  if (!handler) throw new Error("маршрут не зарегистрирован: " + path);
  const res = fakeResponse();
  return Promise.resolve(handler(request(body, method), res)).then(() => ({
    code: res.captured.code,
    json: JSON.parse(res.captured.body || "{}"),
  }));
}

const settingsFile = join(process.env.DSH_HOME, "1c-project-properties", "settings.json");
const readSettings = () => (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {});
const calls = (method) => managerCalls.filter((call) => call.method === method);
const lastEntry = () => calls("register").filter((call) => call.name === "1c-naparnik").pop()?.entry;

mkdirSync(process.env.DSH_HOME, { recursive: true });
const { apply } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);

const ctx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  workspaceRegistry: {},
  on: () => {},
  get: (name) => (name === "mcpManager" ? fakeManager : undefined),
  inject: (deps, callback) => callback(ctx),
};

apply(ctx);
const ROUTE = "/1cprops/bsl-checks/naparnik";

console.log("до токена");
await new Promise((done) => setTimeout(done, 100));
const idle = await callRoute(ROUTE);
check("сервер не подключён", idle.json.registered === false);
check("регистрации не было", calls("register").filter((call) => call.name === "1c-naparnik").length === 0);
check("менеджер не считает сервер своим", idle.json.managerAvailable === true);

console.log("регистрация через register()");
const saved = await callRoute(ROUTE, { token: "token-1234-abcd" }, "POST");
check("сохранение прошло", saved.code === 200 && saved.json.registered === true, JSON.stringify(saved.json));
const entry = lastEntry() || {};
check("менеджер получил имя первым аргументом", calls("register").some((call) => call.name === "1c-naparnik"));
check("в записи нет имени", entry.name === undefined, JSON.stringify(Object.keys(entry)));
check("транспорт stdio", entry.transport === "stdio", String(entry.transport));
check("таймаут под две минуты", entry.toolCallTimeoutMs === 180_000, String(entry.toolCallTimeoutMs));
check("инструмент передан", entry.toolDefinitions?.[0]?.name === "its_help", JSON.stringify(entry.toolDefinitions?.map((item) => item.name)));
check("ошибки регистрации нет", String(saved.json.error || "") === "", String(saved.json.error));

console.log("смена токена");
await callRoute(ROUTE, { token: "token-9999-ffff" }, "POST");
check("старая регистрация снята disposer'ом", calls("dispose").some((call) => call.name === "1c-naparnik"));
check("новая регистрация есть", calls("register").filter((call) => call.name === "1c-naparnik").length === 2);
check("токен записан", readSettings().naparnikToken === "token-9999-ffff");

console.log("имя занято в менеджере");
rejectName = "1c-naparnik";
await callRoute(ROUTE, { token: "token-0000-0000" }, "POST");
const busy = await callRoute(ROUTE);
check("плагин не падает", busy.code === 200, String(busy.code));
check("сервер не считается подключённым", busy.json.registered === false);
check("причина названа", String(busy.json.error).includes("вручную"), String(busy.json.error));
rejectName = "";

console.log("снятие токена");
const cleared = await callRoute(ROUTE, { token: "" }, "POST");
check("токен стёрт", readSettings().naparnikToken === "");
check("сервер снят", cleared.json.registered === false);
check(
  "снятие через disposer, а не unregisterServer",
  calls("dispose").length >= 2 && calls("register").every((call) => call.entry),
);

// Windows держит каталог, пока живы открытые хендлы (сервер проверок слушает порт).
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  // временный каталог уберёт система
}
if (failures) {
  console.log("\nпровалено проверок: " + failures);
  process.exit(1);
}
console.log("\nвсе проверки пройдены");
process.exit(0);
