// Проверка 1С:Напарника: сохранение токена, регистрация обёртки с одним
// инструментом (toolDefinitions), работа клиента с процессом и снятие с учёта.
//
// Запуск: node test/naparnik-host.smoke.mjs
//
// Поднимает apply() на поддельном ctx (webServer + поддельный mcpManager) в
// изолированном $DSH_HOME. Вместо движка bsl-analyzer запускается поддельный
// MCP-сервер на node: тест не зависит от скачанных 76 МБ, не ходит в сеть и
// проверяет протокол, а не чужой бинарь.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-naparnik-host-test-" + process.pid);
mkdirSync(work, { recursive: true });

const spawnLog = join(work, "spawn.log").replace(/\\/g, "/");
const fakeServer = join(work, "fake-naparnik.mjs");
writeFileSync(
  fakeServer,
  `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");
const rl = createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    return reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-naparnik", version: "0" } });
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (String(args.question || "") === "boom") {
      return reply(msg.id, { content: [{ type: "text", text: "нет ответа" }], isError: true });
    }
    if (String(args.question || "").indexOf("плоский") === 0) {
      const blob = JSON.stringify({ durationMs: 5, content: "#std755 текст стандарта" });
      return reply(msg.id, { content: [{ type: "text", text: "Пролог\\n" + blob + "\\nэпилог" }] });
    }
    if (name !== "its_help") {
      return reply(msg.id, { content: [{ type: "text", text: "чужой инструмент" }], isError: true });
    }
    const budget = args.max_output_tokens === undefined ? "" : " / " + args.max_output_tokens;
    return reply(msg.id, { content: [{ type: "text", text: "эхо: " + args.question + budget }] });
  }
  if (msg.id !== undefined) reply(msg.id, {});
});
`,
  "utf8",
);

process.env.DSH_HOME = join(work, "home");
// Движок «есть»: путь проверяется на существование.
const fakeBinary = join(work, "bsl-analyzer-app.exe");
writeFileSync(fakeBinary, "stub", "utf8");
process.env.DSH_BSL_CHECKER_BIN = fakeBinary;
// Запускаем поддельный сервер вместо движка: аргументы те же, команда другая.
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
const managerCalls = [];
const fakeManager = {
  async registerServer(server) {
    managerCalls.push({ method: "registerServer", server });
    return { name: server.name, existing: false };
  },
  async unregisterServer(name) {
    managerCalls.push({ method: "unregisterServer", name });
  },
  getStatus: (name) => ({ name, status: "connected", transport: "stdio", tools: [], enabled: true }),
  async reconnect() {},
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
const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length : 0);
const naparnikCalls = () =>
  managerCalls.filter((call) => call.name === "1c-naparnik" || call.server?.name === "1c-naparnik");
const lastRegistered = () => naparnikCalls().filter((call) => call.method === "registerServer").pop()?.server;
const tool = () => lastRegistered()?.toolDefinitions?.[0];

mkdirSync(process.env.DSH_HOME, { recursive: true });
const { apply } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);
const { flattenItsAnswer } = await import(pathToFileURL(resolve(here, "..", "lib", "naparnik.js")).href);

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
check("роут Напарника зарегистрирован", routes.has(ROUTE));
await new Promise((done) => setTimeout(done, 100));
check("Напарник не регистрировался", naparnikCalls().length === 0, JSON.stringify(naparnikCalls()));
check("процесс не запускался", spawns() === 0, String(spawns()));

const idle = await callRoute(ROUTE);
check("токена нет", idle.json.tokenSet === false);
check("сервер не подключён", idle.json.registered === false);
check("причина названа", String(idle.json.error).includes("токен"), idle.json.error);
check("движок виден статусу", idle.json.engine?.downloaded === true);

console.log("сохранение токена");
const saved = await callRoute(ROUTE, { token: "  token-1234-abcd  " }, "POST");
check("сохранение прошло", saved.code === 200 && saved.json.registered === true, JSON.stringify(saved.json));
check("токен в общих настройках", readSettings().naparnikToken === "token-1234-abcd");
check("процесс поднят", saved.json.runtime?.running === true, JSON.stringify(saved.json.runtime));
check("регистрация одна", naparnikCalls().filter((call) => call.method === "registerServer").length === 1);

const server = lastRegistered() || {};
check("имя сервера", server.name === "1c-naparnik", server.name);
check("транспорт stdio", server.transport === "stdio", server.transport);
check("таймаут вызова под две минуты", server.toolCallTimeoutMs === 180_000, String(server.toolCallTimeoutMs));
check(
  "инструмент один",
  server.toolDefinitions?.length === 1,
  JSON.stringify(server.toolDefinitions?.map((item) => item.name)),
);
check("инструмент — its_help", tool()?.name === "its_help", tool()?.name);
check("схема требует question", JSON.stringify(tool()?.parameters?.required) === JSON.stringify(["question"]));
check("execute — функция", typeof tool()?.execute === "function");

console.log("вызов инструмента");
const answer = await tool().execute({ question: "как принято делать запрос в цикле" }, {});
check("ответ вернулся", String(answer?.text || "").startsWith("эхо:"), JSON.stringify(answer));
check("бюджет по умолчанию 6000", String(answer?.text || "").includes("/ 6000"), answer?.text);
check("в ответе вопрос", String(answer?.text || "").includes("запрос в цикле"));
const rendered = tool().output.render({}, answer);
check(
  "рендер отдаёт текст",
  rendered?.[0]?.type === "text" && rendered[0].text.startsWith("эхо:"),
  JSON.stringify(rendered),
);

const flat = await tool().execute({ question: "плоский ответ с вставкой поиска" }, {});
check(
  "вставка поиска развёрнута в текст",
  !String(flat?.text || "").includes('"durationMs"') && String(flat?.text || "").includes("#std755"),
  String(flat?.text),
);
check("проза вокруг вставки цела", String(flat?.text || "").includes("Пролог") && String(flat?.text || "").includes("эпилог"), String(flat?.text));

const second = await tool().execute({ question: "второй вопрос", max_output_tokens: 900 }, {});
check("свой бюджет доходит", String(second?.text || "").includes("/ 900"), second?.text);
check("процесс переиспользован", spawns() === 1, String(spawns()));

let failed = null;
try {
  await tool().execute({ question: "boom" }, {});
} catch (error) {
  failed = error;
}
check("ошибка сервера — исключение", String(failed?.message || "").includes("нет ответа"), String(failed?.message || ""));
let empty = null;
try {
  await tool().execute({ question: "   " }, {});
} catch (error) {
  empty = error;
}
check(
  "пустой вопрос не уходит в сервер",
  String(empty?.message || "").includes("question обязателен"),
  String(empty?.message || ""),
);

console.log("смена токена");
await callRoute(ROUTE, { token: "token-9999-ffff" }, "POST");
check("новый токен в настройках", readSettings().naparnikToken === "token-9999-ffff");
check("процесс перезапущен", spawns() === 2, String(spawns()));
check("старая регистрация снята", naparnikCalls().some((call) => call.method === "unregisterServer"));
const fresh = await tool().execute({ question: "после смены" }, {});
check("новый процесс отвечает", String(fresh?.text || "").includes("после смены"), fresh?.text);
const status = await callRoute(ROUTE);
check("хвост токена виден", status.json.tokenTail === "ffff", status.json.tokenTail);
check("сам токен не отдаётся", JSON.stringify(status.json).indexOf("token-9999-ffff") < 0);

console.log("снятие токена");
const cleared = await callRoute(ROUTE, { token: "" }, "POST");
check("токен стёрт", readSettings().naparnikToken === "");
check("сервер снят с учёта", cleared.json.registered === false);
check("процесс остановлен", cleared.json.runtime?.running === false, JSON.stringify(cleared.json.runtime));

console.log("движка нет");
// Кеш движка на машине может быть настоящим: уводим и его, и явный путь.
rmSync(fakeBinary, { force: true });
process.env.DSH_BSL_CHECKER_BIN = join(work, "missing.exe");
process.env.DSH_BSL_CHECKER_DIR = join(work, "empty-cache");
mkdirSync(process.env.DSH_BSL_CHECKER_DIR, { recursive: true });
const noEngine = await callRoute(ROUTE, { token: "token-again" }, "POST");
check("без движка не подключается", noEngine.json.registered === false);
check("причина — движок", String(noEngine.json.error).includes("движок"), noEngine.json.error);

console.log("разбор ответа ИТС");
{
  const raw = [
    "Найдено 1 результатов:",
    "========",
    "Расположение документа 'Длительные операции на клиенте' (**id:its-v8std-755-hdoc**):",
    " Базы данных ИТС (пособия, руководства, документации решений)/ (id:root)",
    "  └── Самые полезные руководства и пособия по разработке на 1С/ (id:superior)",
    "   └── Система стандартов и методик разработки конфигураций для платформы 1С:Предприятие 8/ (id:v8std)",
    "    └── Разработка пользовательских интерфейсов/ (id:its-v8std-3-hdir)",
    "========",
    "Структура всего документа 'Длительные операции на клиенте' (**id:its-v8std-755-hdoc**):",
    "└── Длительные операции на клиенте (id:its-v8std-755-hdoc/длительные-операции-на-клиенте)",
    "========",
    "# Длительные операции на клиенте",
    "\\#std755",
    "Текст стандарта.",
  ].join("\n");
  const flat = flattenItsAnswer(raw);
  check(
    "служебные блоки свёрнуты",
    !flat.includes("Расположение документа") && !flat.includes("Структура всего документа"),
    flat.slice(0, 200),
  );
  check("строка источника с id", flat.includes("Источник:") && flat.includes("its-v8std-755-hdoc"), flat.slice(0, 300));
  check("общие уровни ИТС выброшены", !flat.includes("id:root") && !flat.includes("Самые полезные руководства"));
  check("остался последний раздел пути", flat.includes("Разработка пользовательских интерфейсов"));
  check("текст стандарта на месте", flat.includes("std755") && flat.includes("Текст стандарта."));
  check("посторонний текст не тронут", flattenItsAnswer("Просто текст без вставок.") === "Просто текст без вставок.");
}

// Windows держит каталог, пока живы открытые хендлы (bsl-checks слушает порт):
// уборка не должна превращать зелёный прогон в красный.
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
// Сервер проверок слушает порт и держит цикл событий — выходим явно.
process.exit(0);
