// Проверка визарда добавления проекта: хост-маршруты /detect и /mcp-servers,
// перехват создания воркспейса и первый шаг окна.
//
// Запуск: node test/wizard.smoke.mjs
//
// Хост-половина поднимается на поддельном ctx в изолированном $DSH_HOME, как в
// platform-context-host.smoke.mjs. Клиентская половина проверяется без браузера:
// блок визарда вырезается из lib/client.js по маркерам и исполняется с подставными
// React-хуками и строительными блоками плагина.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-wizard-test-" + process.pid);
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

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

// ── фикстуры ────────────────────────────────────────────────────────────────
const emptyDir = join(work, "projects", "empty");
mkdirSync(emptyDir, { recursive: true });
write(join(emptyDir, "README.md"), "# обычный проект\n");

const dumpDir = join(work, "projects", "dump1c");
write(join(dumpDir, "Configuration.xml"), "<Config/>");
write(join(dumpDir, "ConfigDumpInfo.xml"), "<ConfigDumpInfo/>");
write(join(dumpDir, "CommonModules", "ОбщийМодуль", "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n");

const configuredDir = join(work, "projects", "configured");
write(join(configuredDir, ".dsh", "1c-project.json"), JSON.stringify({ infobasePath: 'Srvr="s";Ref="b";', user: "Админ" }));
write(join(configuredDir, "Configuration.xml"), "<Config/>");
mkdirSync(join(configuredDir, ".dsh", "rules-1c"), { recursive: true });

// ── хост-половина ───────────────────────────────────────────────────────────
const routes = new Map();
const disposers = [];

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

function fakeRequest(url, body) {
  const payload = Buffer.from(body === undefined ? "" : JSON.stringify(body), "utf8");
  const stream = Readable.from([payload]);
  stream.url = url;
  return stream;
}

async function callRoute(path, url, body) {
  const handler = routes.get(path);
  if (!handler) throw new Error("маршрут не зарегистрирован: " + path);
  const res = fakeResponse();
  // Часть маршрутов отвечает из асинхронной ветки, не возвращая промис наружу:
  // ждём сам ответ, а не только возврат обработчика.
  await handler(fakeRequest(url || path, body), res);
  const deadline = Date.now() + 5000;
  while (!res.captured.body && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  return {
    code: res.captured.code,
    json: JSON.parse(res.captured.body || "{}"),
  };
}

const mcpStore = join(process.env.DSH_HOME, "@wingsky-1", "dsh-mcp-manager", "mcp.json");
write(
  mcpStore,
  JSON.stringify({
    version: 1,
    servers: [
      { name: "v8std", transport: "streamable-http", url: "https://ai.v8std.ru/mcp", enabled: true },
      { name: "rlm", transport: "streamable-http", url: "http://127.0.0.1:9330/mcp", enabled: false },
    ],
  }),
);

const { apply, buildDesignerArgs, buildComConnectionString, pickPowerShell } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);

const hostCtx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  workspaceRegistry: { list: () => [] },
  on: (event, handler) => {
    if (event === "dispose") disposers.push(handler);
  },
  get: () => undefined,
  inject: (_deps, callback) => callback(hostCtx),
};

apply(hostCtx);

console.log("хост: маршруты");
check("маршрут определения проекта зарегистрирован", routes.has("/1cprops/detect"));
check("маршрут списка MCP зарегистрирован", routes.has("/1cprops/mcp-servers"));
check("маршрут проверки подключения зарегистрирован", routes.has("/1cprops/check-connection"));
check("маршрута с Конфигуратором для проверки нет", !routes.has("/1cprops/check-start"));
check("прежний маршрут состояния на месте", routes.has("/1cprops/state"));

console.log("хост: определение проекта");
const empty = await callRoute("/1cprops/detect", "/1cprops/detect?path=" + encodeURIComponent(emptyDir));
check("обычная папка не считается проектом 1С", empty.code === 200 && empty.json.is1c === false, JSON.stringify(empty.json.markers));
check("признаков не найдено", Array.isArray(empty.json.markers) && empty.json.markers.length === 0);
check("файла параметров нет", empty.json.hasParams === false);

const dump = await callRoute("/1cprops/detect", "/1cprops/detect?path=" + encodeURIComponent(dumpDir));
check("выгрузка конфигурации распознана", dump.json.is1c === true);
check("признак выгрузки назван", (dump.json.markers || []).some((m) => m.includes("выгрузка конфигурации")), JSON.stringify(dump.json.markers));
check("исходники модулей найдены во вложенной папке", (dump.json.markers || []).some((m) => m.includes("исходные тексты")), JSON.stringify(dump.json.markers));
check("папка помечена как содержащая выгрузку", dump.json.hasDump === true);

const configured = await callRoute("/1cprops/detect", "/1cprops/detect?path=" + encodeURIComponent(configuredDir));
check("настроенный проект помечен файлом параметров", configured.json.hasParams === true);
check("параметры вернулись целиком", configured.json.params?.infobasePath === 'Srvr="s";Ref="b";', JSON.stringify(configured.json.params));
check("развёрнутые правила видны", configured.json.hasRules === true);

const relative = await callRoute("/1cprops/detect", "/1cprops/detect?path=relative/path");
check("относительный путь отклонён", relative.code === 400 && relative.json.ok === false);
const missing = await callRoute("/1cprops/detect", "/1cprops/detect?path=" + encodeURIComponent(join(work, "nope")));
check("несуществующая папка отклонена", missing.code === 400 && String(missing.json.error).includes("не найдена"));
const noParam = await callRoute("/1cprops/detect", "/1cprops/detect");
check("без параметра path — отказ", noParam.code === 400);

console.log("хост: серверы MCP");
const mcp = await callRoute("/1cprops/mcp-servers");
check("список доступен", mcp.code === 200 && mcp.json.available === true);
check("оба сервера в списке", (mcp.json.servers || []).length === 2, JSON.stringify(mcp.json.servers));
check("включённый сервер назван включённым", mcp.json.servers?.find((s) => s.name === "v8std")?.enabled === true);
check("выключенный сервер назван выключенным", mcp.json.servers?.find((s) => s.name === "rlm")?.enabled === false);
renameSync(mcpStore, mcpStore + ".hidden");
const noStore = await callRoute("/1cprops/mcp-servers");
check("без файла менеджера — пустой ответ, а не ошибка", noStore.code === 200 && noStore.json.available === false && (noStore.json.servers || []).length === 0);
renameSync(mcpStore + ".hidden", mcpStore);

console.log("хост: быстрая проверка пути");
// каталог с файлом базы
const fileBase = join(work, "projects", "filebase");
mkdirSync(fileBase, { recursive: true });
write(join(fileBase, "1Cv8.1CD"), "db");
const emptyBase = join(work, "projects", "emptybase");
mkdirSync(emptyBase, { recursive: true });
const foundPlatform = process.env.ProgramFiles ? join(process.env.ProgramFiles, "1cv8") : "";

const fastBase = await callRoute("/1cprops/path-check", "/1cprops/path-check", {
  path: dumpDir,
  params: { infobasePath: fileBase, platformPath: foundPlatform || join(work, "нет-платформы") },
});
check("быстрая проверка отвечает", fastBase.code === 200 && Array.isArray(fastBase.json.checks));
check("проверка называет два пункта: платформа и база", fastBase.json.checks?.length === 2, JSON.stringify(fastBase.json.checks));
check("каталог с 1Cv8.1CD принят", fastBase.json.checks?.[1]?.ok === true, JSON.stringify(fastBase.json.checks?.[1]));

const fastEmpty = await callRoute("/1cprops/path-check", "/1cprops/path-check", {
  path: dumpDir,
  params: { infobasePath: emptyBase, platformPath: join(work, "нет-платформы") },
});
check("пустая папка не выдаётся за базу", fastEmpty.json.checks?.[1]?.ok === false, JSON.stringify(fastEmpty.json.checks?.[1]));
check("отсутствие платформы названо", fastEmpty.json.checks?.[0]?.ok === false);
check("итог по проверке отрицательный", fastEmpty.json.okAll === false);

const fastServer = await callRoute("/1cprops/path-check", "/1cprops/path-check", {
  path: dumpDir,
  params: { infobasePath: 'Srvr="127.0.0.1:15999";Ref="buh";', platformPath: join(work, "нет-платформы") },
});
check("недоступный сервер назван", fastServer.json.checks?.[1]?.ok === false && String(fastServer.json.checks?.[1]?.detail).includes("не отвечает"), JSON.stringify(fastServer.json.checks?.[1]));

console.log("хост: проверка подключения");
const comFile = buildComConnectionString({ arg: "/FC:/Bases/Buh" }, { user: "Админ", password: "секрет" });
check(
  "файловая база превращается в File= с логином и паролем",
  comFile.value === 'File="C:/Bases/Buh";Usr="Админ";Pwd="секрет";',
  String(comFile.value),
);
const comServer = buildComConnectionString({ arg: "/Ssrv-1c\\erp" }, {});
check(
  "серверная база превращается в Srvr= и Ref=",
  comServer.value === 'Srvr="srv-1c";Ref="erp";',
  String(comServer.value),
);
check(
  "путь к базе без режима не принимается",
  Boolean(buildComConnectionString({ arg: "/Xчто-то" }, {}).error),
);
check(
  "ошибка базы переносится в строку соединения",
  Boolean(buildComConnectionString({ error: "не задан путь к базе" }, {}).error),
);

const shell64 = pickPowerShell("C:/Program Files/1cv8/8.3.27.2130/bin/1cv8.exe");
check("для 64-битной платформы берётся обычный PowerShell", shell64.exe === "powershell.exe" && shell64.bitness === 64);
const shell32 = pickPowerShell("C:/Program Files (x86)/1cv8/8.3.27.2130/bin/1cv8.exe");
check(
  "для 32-битной платформы берётся PowerShell из SysWOW64 (если он есть)",
  shell32.bitness === (shell32.exe === "powershell.exe" ? 64 : 32),
  shell32.exe,
);

const noPlatform = await callRoute("/1cprops/check-connection", "/1cprops/check-connection", { path: configuredDir });
check("без пути к платформе проверка объясняет отказ", noPlatform.code === 400 && String(noPlatform.json.error).includes("платформе"), JSON.stringify(noPlatform.json));

const overridePlatform = await callRoute("/1cprops/check-connection", "/1cprops/check-connection", {
  path: configuredDir,
  params: { platformPath: join(work, "нет-такой-платформы", "1cv8.exe") },
});
check(
  "платформа из запроса проверяется раньше файла проекта",
  overridePlatform.code === 400 && String(overridePlatform.json.error).includes("не найден"),
  JSON.stringify(overridePlatform.json),
);

// Живая проверка внешним соединением — только когда задана настоящая база:
// юнит-тест не должен стучаться в 1С на каждой сборке.
if (process.env.P1C_TEST_BASE && process.env.P1C_TEST_PLATFORM) {
  const real = await callRoute("/1cprops/check-connection", "/1cprops/check-connection", {
    path: dumpDir,
    params: { infobasePath: process.env.P1C_TEST_BASE, platformPath: process.env.P1C_TEST_PLATFORM },
  });
  check("живая база открывается внешним соединением", real.json.ok === true, JSON.stringify(real.json));
  check("проверка укладывается в 15 секунд", real.json.elapsedMs < 15000, String(real.json.elapsedMs));
  const wrong = await callRoute("/1cprops/check-connection", "/1cprops/check-connection", {
    path: dumpDir,
    params: { infobasePath: process.env.P1C_TEST_BASE, platformPath: process.env.P1C_TEST_PLATFORM, user: "нет-такого-пользователя" },
  });
  check("неверный логин назван словами платформы", wrong.json.ok === false && /парол/i.test(wrong.json.error), JSON.stringify(wrong.json));
}

// ── клиентская половина ─────────────────────────────────────────────────────
const clientSource = readFileSync(resolve(here, "..", "lib", "client.js"), "utf8").replace(/\r\n/g, "\n");
const start = clientSource.indexOf("    // ── визард добавления проекта ");
const end = clientSource.indexOf("    /** Модальное окно параметров одного проекта. */");
check("блок визарда найден в client.js", start > 0 && end > start, start + " / " + end);
const block = clientSource.slice(start, end);

const cssStart = clientSource.indexOf("const CSS = `");
const cssEnd = clientSource.indexOf("\n`;", cssStart);
const cssText = clientSource.slice(cssStart, cssEnd);

const stub = (name) => (props) => ({ __c: name, props: props || {} });
// Ответы хоста подставляются через изменяемый объект: фабрика забирает request
// один раз, поэтому переприсваивать deps.request после сборки бесполезно.
const wire = { detect: { ok: true, is1c: true, markers: ["исходные тексты .bsl"], hasParams: false, params: {} } };
const deps = {
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  jsx: (type, props) => ({ type: typeof type === "function" ? (type.name || "fn") : type, props }),
  jsxs: (type, props) => ({ type: typeof type === "function" ? (type.name || "fn") : type, props }),
  portal: (node) => node,
  cx: (...parts) => parts.filter(Boolean).join(" "),
  request: async (path) => {
    if (path.startsWith("/detect")) return wire.detect;
    if (path === "/state") {
      return {
        paramsRel: ".dsh/1c-project.json",
        common: { platformPath: "" },
        platforms: [],
        infobases: [],
        rulesPayload: { ok: true, root: "" },
      };
    }
    if (path === "/mcp-servers") return { ok: true, available: false, servers: [] };
    return {};
  },
  injectStyles: () => {},
  Card: stub("Card"),
  Field: stub("Field"),
  Check: stub("Check"),
  Btn: stub("Btn"),
  Dot: stub("Dot"),
  JobBox: stub("JobBox"),
  CloseIcon: stub("CloseIcon"),
  Summary: stub("Summary"),
  EMPTY_FORM: { infobasePath: "", user: "", password: "", platformPath: "", unlockCode: "", dumpDir: "" },
  EMPTY_RUN: { format: "Hierarchical", update: false, cleanLocks: false },
  EMPTY_RULES_OPTIONS: { includePassword: false, useEdt: false },
  RESULT_LABEL: { written: "записано файлов", unchanged: "без изменений", preserved: "сохранено ваших", removed: "удалено" },
  RULES_REPO: "https://github.com/comol/ai_rules_1c",
};

const factory = new Function(
  "deps",
  "const { useState, useEffect, useCallback, jsx, jsxs, portal, cx, request, injectStyles, Card, Field, Check, Btn, Dot, JobBox, CloseIcon, Summary, EMPTY_FORM, EMPTY_RUN, EMPTY_RULES_OPTIONS, RESULT_LABEL, RULES_REPO } = deps;\n" +
    "const WIZARD_STEPS_LOCAL = 0;\n" +
    block +
    "\nreturn { installCreateHook, Wizard, WizardHost, openWizard, closeWizard, snapshot: () => wizardRequest, notifyWizard };",
);

const client = factory(deps);

console.log("клиент: перехват создания проекта");
class FakeWorkspaces {
  constructor() {
    this.calls = 0;
  }
  async create(input) {
    this.calls += 1;
    return { workspaceId: "w1", path: input.path, title: "Проект" };
  }
}

function makeCtx(service) {
  const captured = { disposers: [], injected: [] };
  const ctx = {
    workspaces: service,
    inject: (names, callback) => {
      captured.injected.push(names);
      callback(ctx);
    },
    effect: (factoryFn) => {
      captured.disposers.push(factoryFn());
    },
  };
  return { ctx, captured };
}

const protoCreate = FakeWorkspaces.prototype.create;
const service = new FakeWorkspaces();
const { ctx, captured } = makeCtx(service);
client.installCreateHook(ctx);
check("запрошена служба workspaces", captured.injected.some((names) => names.includes("workspaces")));
check("метод создания подменён", service.create !== protoCreate);
check("подмена помечена, чтобы не вставать дважды", service.create.__dsh1cProjectWizard === true);

const created = await service.create({ path: join(work, "projects", "new") });
await new Promise((done) => setTimeout(done, 10));
check("воркспейс создаётся обычным путём", created.path.endsWith("new"));
check("визард открылся после создания", client.snapshot() !== null && client.snapshot().path === created.path);
client.closeWizard();
check("визард закрывается", client.snapshot() === null);

wire.detect = { ok: true, is1c: false, markers: [], hasParams: true, params: {} };
await service.create({ path: join(work, "projects", "configured") });
await new Promise((done) => setTimeout(done, 10));
check("настроенный проект визард не открывает", client.snapshot() === null);

const before = service.calls;
client.installCreateHook(ctx);
await service.create({ path: join(work, "projects", "again") });
check("повторная установка не ставит вторую обёртку", service.calls === before + 1);

for (const dispose of captured.disposers) dispose();
check("после выгрузки плагина метод вернулся", service.create === protoCreate);

console.log("клиент: окно визарда");
const hookValues = [
  null, // state
  0, // step
  { ok: true, is1c: true, markers: ["выгрузка конфигурации: Configuration.xml"], hasParams: false, params: {} }, // detect
  true, // is1c
  { ...deps.EMPTY_FORM }, // form
  false, // showPassword
  { ...deps.EMPTY_RULES_OPTIONS }, // rulesOptions
  null, // rulesResult
  { ...deps.EMPTY_RUN }, // runOptions
  null, // job
  false, // busy
  null, // status
  false, // baseSaved
  null, // mcp
  null, // pathCheck
  null, // connection
  false, // checking
  JSON.stringify(deps.EMPTY_FORM), // lastSaved
];
let hookIndex = 0;
deps.useState = () => {
  const value = hookValues[hookIndex];
  hookIndex += 1;
  return [value, () => {}];
};
const renderClient = factory(deps);
const tree = renderClient.Wizard({ request: { path: "D:/проекты/Бухгалтерия", title: "Бухгалтерия", openedAt: 1 }, onClose: () => {} });
const text = JSON.stringify(tree);
hookIndex = 0;
check("вопрос про 1С задан", text.includes("Это проект 1С?"));
check("оба варианта ответа на месте", text.includes("Да, это проект 1С") && text.includes("Нет, обычный проект"));
check("полоса шагов называет этапы", text.includes("База и платформа") && text.includes("Навыки") && text.includes("Готово"));
check("текущий шаг помечен", text.includes("is-current"));
check("путь проекта показан", text.includes("D:/проекты/Бухгалтерия"));
check("подсказка называет найденный признак", text.includes("Configuration.xml"));
check("поле базы на первом шаге не показано", !text.includes("Путь к базе"));

// Шаг «База 1С»: поля подключения, кнопка проверки и подсказка про платформу.
const stepTwoHooks = hookValues.slice();
stepTwoHooks[1] = 1; // step
let hookIndex2 = 0;
deps.useState = () => {
  const value = stepTwoHooks[hookIndex2];
  hookIndex2 += 1;
  return [value, () => {}];
};
const renderBase = factory(deps).Wizard({
  request: { path: "D:/проекты/Бухгалтерия", title: "Бухгалтерия", openedAt: 2 },
  onClose: () => {},
});
const baseText = JSON.stringify(renderBase);
check("на шаге базы есть поле пути к базе", baseText.includes("Путь к базе"));
check("кнопка проверки подключения на месте", baseText.includes("Проверить подключение"));
check("на шаге базы полоса помечает второй этап", baseText.includes("is-current"));
check("подсказка объясняет пустое значение платформы", baseText.includes("Общее значение не задано"));
check(
  "код доступа и платформа спрятаны в «Дополнительно»",
  baseText.includes("Дополнительно: код доступа и платформа") && baseText.includes("p1c-details"),
);
check(
  "кнопка проверки — основная, а не призрачная",
  /"variant":"primary"[^}]*Проверить подключение/.test(baseText) || /Проверить подключение[\s\S]{0,200}"variant":"primary"/.test(baseText),
);
check(
  "статус проверки — одна горизонтальная строка без путей",
  clientSource.includes("p1c-check-line--status") && !/checkText[\s\S]{0,600}item\.detail/.test(clientSource),
);
check("короткая причина отказа без пути", clientSource.includes("function shortPathError"));
check(
  "окно визарда одной высоты на всех шагах",
  /\.p1c-dialog__body--wizard \{ height: 470px/.test(cssText),
  (cssText.match(/\.p1c-dialog__body--wizard \{[^}]*\}/) || [""])[0],
);

console.log("клиент: классы оформления");
const classLiterals = [...new Set((block.match(/p1c-[a-z0-9_-]+/g) || []))].filter((name) => !name.startsWith("p1c-wizard"));
const orphan = classLiterals.filter((name) => !cssText.includes("." + name));
check("у всех классов визарда есть правило в стилях", orphan.length === 0, orphan.join(", "));

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nвсе проверки пройдены" : "\nпровалено проверок: " + failures);
process.exit(failures === 0 ? 0 : 1);
