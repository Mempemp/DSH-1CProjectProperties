// «Устарел по возрасту» после успешного обновления.
//
// Запуск: node test/rlm-index-age.smoke.mjs
//
// Дефект с живого проекта: карточка индекса показывает «устарел по возрасту», нажатие
// «Обновить» запускает update, а признак не снимается — проверка снова отвечает «stale (age)».
// Настоящая причина: возраст индекса движок считает от своей метки сборки (index_meta.built_at),
// и до 1.46 «index update» её не сдвигал, если не находил изменённых .bsl (комментарий движка:
// «Прежде — только при изменённых .bsl … возраст индекса не сбрасывался»). Проверено на 1.45.0:
// update без изменённых .bsl оставлял «Status: stale (age)»; на 1.47.0 и 1.51.0 — «fresh».
// У плагина есть своя метка успешной сверки (settings.json → index.projects[].lastIndexAt), и она
// должна перевешивать замороженную метку движка; сам разбор статуса тут не при чём.
//
// Сценарий воспроизводится честно: индекс собирается настоящим движком, затем built_at
// переносится на 9 суток назад — ровно то состояние, которое оставлял update старого движка.
// Чужая SQLite не патчится: правится только тестовая копия в изолированном RLM_INDEX_DIR.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "rlm-index-age-"));
const projects = [];
process.env.DSH_HOME = home;

const { applyRlm, applyOwnVerification, parseBuiltAge } = await import("../lib/rlm-runner.js");

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + extra : ""));
  if (!ok) fails++;
};

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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function settled(project, attempts = 60) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await request("/rlm/index/state?path=" + encodeURIComponent(project));
    if (!last.body.checking) return last.body;
    await sleep(400);
  }
  throw new Error("проверка свежести не устоялась: " + JSON.stringify(last && last.body && last.body.index));
}

function makeProject(name) {
  const project = mkdtempSync(join(tmpdir(), "rlm-index-age-" + name + "-"));
  projects.push(project);
  mkdirSync(join(project, "CommonModules", "Тест", "Ext"), { recursive: true });
  writeFileSync(join(project, "Configuration.xml"), "<MetaDataObject/>");
  writeFileSync(join(project, "CommonModules", "Тест", "Ext", "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n");
  mkdirSync(join(project, ".dsh"), { recursive: true });
  writeFileSync(join(project, ".dsh", "1c-project.json"), JSON.stringify({ rlmIndex: true }));
  return project;
}

const settingsFile = () => join(home, "rlm-tools-bsl", "settings.json");

/** Метка успешной сверки в состоянии плагина: пишется на завершении задания. */
function lastIndexAt(project) {
  try {
    const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return settings.index.projects[project] && settings.index.projects[project].lastIndexAt;
  } catch {
    return null;
  }
}

function setLastIndexAt(project, iso) {
  const settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
  const entry = settings.index.projects[project];
  assert.ok(entry, "состояние проекта записано после сборки");
  entry.lastIndexAt = iso;
  writeFileSync(settingsFile(), JSON.stringify(settings));
}

/** Индекс конкретного проекта в изолированном корне: ищем по base_path в index_meta. */
function findIndexDb(project) {
  const root = join(home, "indexes");
  for (const name of readdirSync(root)) {
    const db = join(root, name, "bsl_index.db");
    if (!existsSync(db)) continue;
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const row = conn.prepare("SELECT value FROM index_meta WHERE key = 'base_path'").get();
      if (row && String(row.value).toLowerCase() === project.toLowerCase()) return db;
    } finally {
      conn.close();
    }
  }
  throw new Error("индекс проекта не найден в " + root);
}

/** Так выглядит индекс, который update старого движка не пометил: built_at остался прежним. */
function ageBuildMark(project, days) {
  const db = findIndexDb(project);
  const conn = new DatabaseSync(db);
  try {
    const value = String((Date.now() - days * 86_400_000) / 1000);
    conn.prepare("UPDATE index_meta SET value = ? WHERE key = 'built_at'").run(value);
  } finally {
    conn.close();
  }
}

/** Задание завершено, когда плагин записал метку сверки: /index/state не читаем, чтобы не греть кэш. */
async function waitJobDone(project, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(250);
    if (lastIndexAt(project)) return true;
  }
  return false;
}

try {
  applyRlm(ctx, {
    autoStart: false,
    command: "C:/__no_such_rlm_server__.exe",
    autoInstall: false,
    mcpAutoRegister: false,
    port: 65311,
    env: { RLM_INDEX_DIR: join(home, "indexes") },
  });
  await sleep(300);

  // ── индекс без сборки: карточка честно говорит «индекса нет» ────────────────────────
  const empty = makeProject("empty");
  const first = await request("/rlm/index/state?path=" + encodeURIComponent(empty));
  assert.equal(first.body.checking, true, "первое чтение отвечает до проверки свежести");
  const missing = await settled(empty);
  check("до сборки индекса нет", missing.index && missing.index.status === "missing", String(missing.index && missing.index.status));

  // ── замороженная метка: сборка настоящим движком, метка сборки отодвинута на 9 суток ──
  const frozen = makeProject("frozen");
  const build = await request("/rlm/index/job", { path: frozen, action: "build" });
  assert.equal(build.code, 202, JSON.stringify(build.body));
  check("сборка настоящим движком завершилась", await waitJobDone(frozen), String(lastIndexAt(frozen)));
  ageBuildMark(frozen, 9);
  const frozenState = await settled(frozen);
  check(
    "после успешной сверки возраст не возвращается",
    frozenState.index && frozenState.index.status === "fresh",
    String(frozenState.index && frozenState.index.status) + " built=" + String(frozenState.index && frozenState.index.built),
  );
  check("видно, что метку сборки движок не сдвинул", frozenState.index && frozenState.index.buildMarkStale === true);
  check("видно, когда сверяли", Number.isFinite(frozenState.index && frozenState.index.verifiedAt));

  // ── честный возраст: своя сверка тоже старая — статус остаётся «устарел по возрасту» ──
  const aged = makeProject("aged");
  const agedBuild = await request("/rlm/index/job", { path: aged, action: "build" });
  assert.equal(agedBuild.code, 202, JSON.stringify(agedBuild.body));
  check("сборка второго проекта завершилась", await waitJobDone(aged));
  ageBuildMark(aged, 9);
  setLastIndexAt(aged, new Date(Date.now() - 20 * 86_400_000).toISOString());
  const agedState = await settled(aged);
  check(
    "давняя сверка не выдаётся за актуальную",
    agedState.index && agedState.index.status === "stale_age",
    String(agedState.index && agedState.index.status),
  );
  check("признак несдвинутой метки не выставлен", !(agedState.index && agedState.index.buildMarkStale));
} finally {
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch {}
  }
  for (const project of projects) rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

// ── разбор возраста движка ──────────────────────────────────────────────────
check("34s ago", parseBuiltAge("34s ago") === 34_000);
check("35m ago", parseBuiltAge("35m ago") === 35 * 60_000);
check("5.0h ago", parseBuiltAge("5.0h ago") === 5 * 3_600_000);
check("9.0d ago", parseBuiltAge("9.0d ago") === 9 * 86_400_000);
check("запятая как разделитель", parseBuiltAge("1,5h ago") === 1.5 * 3_600_000);
check("пустая строка", parseBuiltAge("") === null);
check("без возраста", parseBuiltAge(undefined) === null);
check("мусор", parseBuiltAge("недавно") === null);

// ── решение «своя сверка новее замороженной метки движка» ───────────────────
const now = Date.parse("2026-11-14T12:00:00.000Z");
const maxAgeMs = 7 * 86_400_000;
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const staleAge = { ok: true, status: "stale_age", built: "9.0d ago" };
const opts = { now, maxAgeMs };

const corrected = applyOwnVerification(staleAge, iso(60_000), opts);
check("сверка минуту назад снимает возраст", corrected.status === "fresh");
check("снятие возраста помечено", corrected.buildMarkStale === true && corrected.verifiedAt === now - 60_000);
check("исходный вердикт не испорчен", staleAge.status === "stale_age" && staleAge.buildMarkStale === undefined);
check("сверка двадцатидневной давности возраст не снимает", applyOwnVerification(staleAge, iso(20 * 86_400_000), opts).status === "stale_age");
check("сверка новее метки, но за пределом возраста, не снимает", applyOwnVerification(staleAge, iso(8 * 86_400_000), opts).status === "stale_age");
check("сверка ровно в момент сборки возраст не снимает", applyOwnVerification(staleAge, iso(9 * 86_400_000), opts).status === "stale_age");
check("свой предел возраста учитывается", applyOwnVerification(staleAge, iso(60_000), { now, maxAgeMs: 0 }).status === "stale_age");
check("нет метки сверки — статус как у движка", applyOwnVerification(staleAge, null, opts).status === "stale_age");
check("нечитаемая метка сверки — статус как у движка", applyOwnVerification(staleAge, "не дата", opts).status === "stale_age");
check("нечитаемый возраст — статус как у движка", applyOwnVerification({ ok: true, status: "stale_age" }, iso(60_000), opts).status === "stale_age");
const freshVerdict = { ok: true, status: "fresh", built: "9.0d ago" };
check("свежий вердикт не трогаем", applyOwnVerification(freshVerdict, iso(60_000), opts) === freshVerdict);
check("изменение файлов не подменяем", applyOwnVerification({ ok: true, status: "stale_content" }, iso(0), opts).status === "stale_content");
check("изменение структуры не подменяем", applyOwnVerification({ ok: true, status: "stale_structure" }, iso(0), opts).status === "stale_structure");
check("отсутствие индекса не подменяем", applyOwnVerification({ ok: true, status: "missing" }, iso(0), opts).status === "missing");
check("пустой ответ не падает", applyOwnVerification(null, iso(0), opts) === null);

console.log(fails ? `\n${fails} FAIL` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
