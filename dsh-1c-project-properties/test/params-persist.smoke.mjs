// Параметры проекта переживают сохранение карточки: галочка «Включить анализ
// кода», набор правил и флаг индекса rlm лежат в том же .dsh/1c-project.json, но
// ведут их другие модули. Форма «Параметры проекта» не имеет права их терять или
// менять тип.
//
// Запуск: node test/params-persist.smoke.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-params-persist-test-" + process.pid);
process.env.DSH_HOME = join(work, "home");
process.env.DSH_1CPROPS_NO_RLM = "1";
process.env.DSH_BSL_CHECKER_DIR = join(work, "engine");
process.env.DSH_BSL_CHECKER_NO_DOWNLOAD = "1";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

const project = join(work, "projects", "working");
const paramsFile = join(project, ".dsh", "1c-project.json");
mkdirSync(join(project, ".dsh"), { recursive: true });
const initial = {
  $schema: "dsh-1c-project-properties/v1",
  infobasePath: "",
  user: "Админ",
  password: "",
  platformPath: "",
  unlockCode: "",
  dumpDir: project,
  checksEnabled: true,
  checksPreset: "recommended",
  rlmIndex: true,
};
writeFileSync(paramsFile, JSON.stringify(initial, null, 2) + "\n", "utf8");

const readFile = () => JSON.parse(readFileSync(paramsFile, "utf8"));

// ── хост-половина на поддельном ctx ─────────────────────────────────────────
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
  await handler(fakeRequest(url || path, body), res);
  const deadline = Date.now() + 5000;
  while (!res.captured.body && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  return { code: res.captured.code, json: JSON.parse(res.captured.body || "{}") };
}

const { apply } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);

const hostCtx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  workspaceRegistry: { list: () => [] },
  on: (event, handler) => {
    if (event === "dispose") disposers.push(handler);
  },
  get: () => undefined,
  inject: (_deps, callback) => callback(hostCtx),
};

try {
  apply(hostCtx);

  const form = {
    infobasePath: "",
    user: "Админ",
    password: "",
    platformPath: "",
    unlockCode: "",
    dumpDir: project,
  };

  console.log("сохранение формы не трогает чужие ключи");
  const saved = await callRoute("/1cprops/project-save", null, { path: project, params: form });
  check("маршрут ответил успехом", saved.code === 200 && saved.json.ok === true, JSON.stringify(saved.json).slice(0, 200));
  let file = readFile();
  check("галочка анализа осталась включённой", file.checksEnabled === true, JSON.stringify(file.checksEnabled));
  check("набор правил на месте", file.checksPreset === "recommended", JSON.stringify(file.checksPreset));
  check("флаг индекса rlm не потерян", file.rlmIndex === true, JSON.stringify(file.rlmIndex));
  check("поле формы сохранилось", JSON.stringify(file.user) === JSON.stringify("Админ"), JSON.stringify(file.user));

  console.log("включение анализа, затем сохранение формы");
  const toggled = await callRoute("/1cprops/bsl-checks/toggle", null, { project, enabled: true });
  check("переключатель вернул включённое состояние", toggled.json.enabled === true, JSON.stringify(toggled.json.enabled));
  // Пользователь ставит галочку, закрывает окно кнопкой «Сохранить» — признак
  // анализа обязан пережить эту запись.
  await callRoute("/1cprops/project-save", null, { path: project, params: form });
  file = readFile();
  check("после сохранения карточки анализ всё ещё включён", file.checksEnabled === true, JSON.stringify(file.checksEnabled));
  const stateAfterSave = await callRoute(
    "/1cprops/bsl-checks/state",
    "/1cprops/bsl-checks/state?project=" + encodeURIComponent(project),
  );
  check("окно параметров видит включённый анализ", stateAfterSave.json.enabled === true, JSON.stringify(stateAfterSave.json.enabled));

  console.log("пустая форма и повторное сохранение");
  await callRoute("/1cprops/project-save", null, { path: project, params: {} });
  file = readFile();
  check("без полей в запросе значения из файла сохранились", JSON.stringify(file.user) === JSON.stringify("Админ"), JSON.stringify(file.user));
  check("анализ не выключился", file.checksEnabled === true, JSON.stringify(file.checksEnabled));
  check("набор правил не выключился", file.checksPreset === "recommended", JSON.stringify(file.checksPreset));

  console.log("выключение анализа переключателем");
  const off = await callRoute("/1cprops/bsl-checks/toggle", null, { project, enabled: false });
  file = readFile();
  check("переключатель выключил анализ", off.json.enabled === false && file.checksEnabled === false, JSON.stringify(file.checksEnabled));
  await callRoute("/1cprops/project-save", null, { path: project, params: form });
  file = readFile();
  check("сохранение формы не включает анализ обратно", file.checksEnabled === false, JSON.stringify(file.checksEnabled));

  console.log("другие типы в файле не превращаются в строки");
  writeFileSync(
    paramsFile,
    JSON.stringify({ ...initial, checksEnabled: true, rlmIndexPath: "D:\\Work\\index", extra: { nested: 1 } }, null, 2) + "\n",
    "utf8",
  );
  await callRoute("/1cprops/project-save", null, { path: project, params: form });
  file = readFile();
  check("строка индекса на месте", file.rlmIndexPath === "D:\\Work\\index", JSON.stringify(file.rlmIndexPath));
  check("вложенный объект не потерян", JSON.stringify(file.extra) === JSON.stringify({ nested: 1 }), JSON.stringify(file.extra));
} finally {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // очистка теста: отказ не влияет на результат проверок
    }
  }
  rmSync(work, { recursive: true, force: true });
}

if (failures) {
  console.log("\n" + failures + " проверок упало");
  process.exit(1);
}
console.log("\nвсе проверки прошли");
