import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Хост-часть читает $DSH_HOME при импорте — задаём его до динамического импорта.
const home = mkdtempSync(join(tmpdir(), "rlm-index-test-"));
process.env.DSH_HOME = home;

const { applyRlm } = await import("../lib/rlm-runner.js");

const routes = new Map();
const disposers = [];
const ctx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  logger: { info: () => {} },
  effect: (fn) => {
    disposers.push(fn());
  },
  get: () => null,
};

// Проверка свежести идёт в фоне и не держит ответ: карточка получает «проверяю…» и опрашивает
// состояние. Тест ждёт устойчивого значения.
async function stateSettled(target, attempts = 40) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await request("/rlm/index/state?path=" + encodeURIComponent(target));
    if (!last.body.checking) return last;
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error("состояние индекса так и не проверилось: " + JSON.stringify(last && last.body));
}

function request(url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = url;
    setImmediate(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
    const res = {
      writeHead(code) {
        this.code = code;
      },
      end(text) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ code: this.code, body: parsed });
      },
    };
    const handler = routes.get(url.split("?")[0]);
    if (!handler) return reject(new Error("нет маршрута " + url));
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

try {
  applyRlm(ctx, {
    command: "C:/__no_such_rlm_server__.exe",
    autoInstall: false,
    mcpAutoRegister: false,
    port: 65201,
    env: { RLM_INDEX_DIR: join(home, "indexes") },
  });
  await new Promise((done) => setTimeout(done, 1200));

  const project = mkdtempSync(join(tmpdir(), "rlm-index-project-"));
  // Пустая папка не индексируется вовсе: сборка падает, и автосборка честно повторяет попытку.
  // Для проверки маршрутов нужен хотя бы один модуль.
  mkdirSync(join(project, "CommonModules", "Тест", "Ext"), { recursive: true });
  writeFileSync(join(project, "CommonModules", "Тест", "Ext", "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n");

  const first = await request("/rlm/index/state?path=" + encodeURIComponent(project));
  assert.equal(first.code, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.enabled, false);
  // Первый ответ не ждёт проверку CLI: статус приходит следующим чтением.
  assert.equal(first.body.checking, true, "первое чтение отвечает до проверки свежести");
  const state = await stateSettled(project);
  assert.equal(state.body.checking, false);
  assert.ok(state.body.index, "статус индекса присутствует");
  assert.ok(typeof state.body.index.status === "string");
  assert.ok(!state.body.project || state.body.project.lastIndexAt === null);

  const config = await request("/rlm/index/config", { path: project, enabled: true });
  assert.equal(config.code, 200);
  assert.equal(config.body.enabled, true);
  // Включение флага и есть то ожидание, которое было сломано: «поставил галочку — а индекса нет».
  // Сборка отсутствующего индекса стартует сразу, состояние показывает её как running.
  assert.equal(config.body.autoStarted, true, "включение флага запускает сборку индекса");
  const waitJob = async (target) => {
    let state = "running";
    for (let attempt = 0; attempt < 60 && state === "running"; attempt += 1) {
      await new Promise((done) => setTimeout(done, 500));
      const current = await request("/rlm/index/state?path=" + encodeURIComponent(target));
      state = current.body.job ? current.body.job.state : null;
    }
    return state;
  };
  assert.notEqual(await waitJob(project), "running", "автосборка завершилась");

  const settings = JSON.parse(readFileSync(join(home, "rlm-tools-bsl", "settings.json"), "utf8"));
  assert.equal(settings.index.projects[project].enabled, true);

  const policy = await request("/rlm/index/config", { path: project, autoOnStart: false, weekly: true });
  assert.equal(policy.body.policy.autoOnStart, false);
  assert.equal(policy.body.policy.weekly, true);

  // Флаг чтения из параметров проекта: файл важнее карты в настройках плагина.
  const flagged = mkdtempSync(join(tmpdir(), "rlm-index-flagged-"));
  mkdirSync(join(flagged, ".dsh"), { recursive: true });
  writeFileSync(join(flagged, ".dsh", "1c-project.json"), JSON.stringify({ rlmIndex: true }));
  const flaggedOn = await request("/rlm/index/state?path=" + encodeURIComponent(flagged));
  assert.equal(flaggedOn.body.enabled, true, "флаг из файла проекта включает индекс");
  assert.equal(flaggedOn.body.autoStarted, false, "обычное чтение состояния сборку не запускает");
  writeFileSync(join(flagged, ".dsh", "1c-project.json"), JSON.stringify({ rlmIndex: false }));
  const flaggedOff = await request("/rlm/index/state?path=" + encodeURIComponent(flagged));
  assert.equal(flaggedOff.body.enabled, false, "флаг из файла проекта важнее карты");

  const badJob = await request("/rlm/index/job", { path: join(project, "nope"), action: "build" });
  assert.equal(badJob.code, 400);

  // Таймауты индексации: значения по умолчанию видны в состоянии, сохранение их меняет
  // и не трогает карту проектов.
  const defaults = await request("/rlm/state");
  assert.equal(defaults.body.indexTimeouts.probeMin, 15, "таймаут проверки по умолчанию");
  assert.equal(defaults.body.indexTimeouts.jobMin, 240, "таймаут сборки по умолчанию");
  const savedTimeouts = await request("/rlm/save", {
    settings: { index: { probeTimeoutMin: 40, jobTimeoutMin: 600 } },
  });
  assert.equal(savedTimeouts.body.indexTimeouts.probeMin, 40);
  assert.equal(savedTimeouts.body.indexTimeouts.jobMin, 600);
  const settingsAfterTimeouts = JSON.parse(readFileSync(join(home, "rlm-tools-bsl", "settings.json"), "utf8"));
  assert.equal(settingsAfterTimeouts.index.projects[project].enabled, true, "карта проектов уцелела");
  const stateAfterTimeouts = await request("/rlm/index/state?path=" + encodeURIComponent(project));
  assert.equal(stateAfterTimeouts.body.policy.probeTimeoutMin, 40, "карточка видит действующий таймаут");
  assert.equal(stateAfterTimeouts.body.policy.jobTimeoutMin, 600);

  // Сохранение порта не должно стирать раздел index.
  const saved = await request("/rlm/save", { settings: { port: 65202 } });
  assert.equal(saved.code, 200);
  const settings2 = JSON.parse(readFileSync(join(home, "rlm-tools-bsl", "settings.json"), "utf8"));
  assert.equal(settings2.port, 65202);
  assert.equal(settings2.index.projects[project].enabled, true);

  const missingBin = await stateSettled(project);
  assert.ok(missingBin.body.bin, "CLI найден на этой машине");

  const job = await request("/rlm/index/job", { path: project, action: "build" });
  assert.equal(job.code, 202, JSON.stringify(job.body));
  let jobState = job.body.job ? job.body.job.state : null;
  for (let attempt = 0; attempt < 60 && jobState === "running"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    const current = await request("/rlm/index/state?path=" + encodeURIComponent(project));
    jobState = current.body.job ? current.body.job.state : null;
  }
  assert.notEqual(jobState, "running", "задание завершилось");
  console.log("job:", jobState);

  // Вложенная выгрузка: проект — папка репозитория, выгрузка Конфигуратора лежит в src, рядом
  // мусор (он в .gitignore и в индекс попадать не должен). Индексируется src, а не проект.
  const nested = mkdtempSync(join(tmpdir(), "rlm-index-nested-"));
  mkdirSync(join(nested, "src", "CommonModules", "Тест", "Ext"), { recursive: true });
  writeFileSync(join(nested, "src", "Configuration.xml"), "<MetaDataObject/>");
  writeFileSync(join(nested, "src", "CommonModules", "Тест", "Ext", "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n");
  mkdirSync(join(nested, ".tmp"), { recursive: true });
  writeFileSync(join(nested, ".tmp", "junk.bsl"), "Процедура Мусор()\nКонецПроцедуры\n");
  mkdirSync(join(nested, ".dsh"), { recursive: true });
  writeFileSync(join(nested, ".dsh", "1c-project.json"), JSON.stringify({ rlmIndex: true, rlmIndexPath: "src" }));

  const nestedFlags = await request("/rlm/index/state?flags=1&path=" + encodeURIComponent(nested));
  assert.equal(nestedFlags.body.enabled, true, "галочка читается из параметров проекта");
  assert.equal(nestedFlags.body.indexPath, "src", "путь выгрузки отдаётся флагами, без CLI");

  const nestedState = await stateSettled(nested);
  assert.equal(nestedState.body.target.path, join(nested, "src"), "индексируется заданная папка выгрузки");
  assert.equal(nestedState.body.target.custom, true, "путь не по умолчанию виден карточке");
  assert.equal(nestedState.body.index.status, "missing");

  const nestedJob = await request("/rlm/index/job", { path: nested, action: "build" });
  assert.equal(nestedJob.code, 202, JSON.stringify(nestedJob.body));
  assert.equal(nestedJob.body.job.project, nested, "карточка сверяет задание по папке проекта");
  assert.equal(nestedJob.body.job.path, join(nested, "src"), "работа идёт по корню выгрузки");
  assert.notEqual(await waitJob(nested), "running", "сборка вложенной выгрузки завершилась");

  const nestedFresh = await stateSettled(nested);
  assert.equal(nestedFresh.body.index.status, "fresh", "после сборки индекс свежий: " + JSON.stringify(nestedFresh.body.index));
  assert.equal(nestedFresh.body.project.lastAction, "build");

  // Путь задаётся параметрами проекта, а не угадывается: пустой — папка проекта,
  // несуществующий — отказ с внятным текстом, а не «индекса нет».
  const broken = mkdtempSync(join(tmpdir(), "rlm-index-broken-"));
  mkdirSync(join(broken, ".dsh"), { recursive: true });
  writeFileSync(join(broken, ".dsh", "1c-project.json"), JSON.stringify({ rlmIndex: true, rlmIndexPath: "нет-такой-папки" }));
  const brokenJob = await request("/rlm/index/job", { path: broken, action: "build" });
  assert.equal(brokenJob.code, 400);
  assert.match(String(brokenJob.body.error), /папка выгрузки не найдена/);

  console.log("OK: index routes (state/config/save preservation, bad job path, configured dump path)");
  console.log("bin:", missingBin.body.bin);
  console.log("status:", missingBin.body.index.status);
} finally {
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
}
