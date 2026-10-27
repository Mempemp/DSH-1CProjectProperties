// Карточка индекса rlm: правила автообновления и кнопка полной пересборки.
//
// Запуск: node test/rlm-index-card.smoke.mjs
//
// Клиентская половина проверяется без браузера: блок карточки вырезается из lib/client.js по
// маркерам и исполняется с подставными React-хуками (useState/useEffect/useRef работают),
// поэтому видно, какие запросы карточка шлёт сама и что показывает в каждом статусе.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "..", "lib", "client.js"), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("    const INDEX_STATUS = {");
const end = source.indexOf("    const EMPTY_FORM = ");
assert.ok(start > 0 && end > start, "блок карточки индекса найден в client.js");
const block = source.slice(start, end);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stub = (name) => {
  const Component = (props) => ({ type: name, props: props || {} });
  Component.displayName = name;
  return Component;
};

/** Мини-рантайм хуков: useState с настоящими перерисовками, useEffect после каждой отрисовки. */
function createHooks() {
  return {
    hooks: [],
    effectDeps: {},
    callbacks: {},
    cursor: 0,
    effects: [],
    cleanups: [],
    dirty: false,
    reset() {
      this.cursor = 0;
      this.effects = [];
    },
  };
}

function makeDeps(hooks, api) {
  return {
    useState(init) {
      const index = hooks.cursor;
      hooks.cursor += 1;
      if (!(index in hooks.hooks)) hooks.hooks[index] = typeof init === "function" ? init() : init;
      const set = (value) => {
        hooks.hooks[index] = typeof value === "function" ? value(hooks.hooks[index]) : value;
        hooks.dirty = true;
      };
      return [hooks.hooks[index], set];
    },
    // Зависимости сравниваются как в React: без этого эффект монтирования перезапускался бы
    // на каждой перерисовке и сбрасывал флаг «автообновление уже запускалось».
    useEffect(fn, deps) {
      const index = hooks.cursor;
      hooks.cursor += 1;
      const previous = hooks.effectDeps[index];
      const changed =
        !previous ||
        !deps ||
        !previous.deps ||
        deps.length !== previous.deps.length ||
        deps.some((value, position) => !Object.is(value, previous.deps[position]));
      if (changed) {
        hooks.effects.push(fn);
        hooks.effectDeps[index] = { deps };
      }
    },
    // useCallback тоже запоминается по зависимостям: иначе функция каждый раз новая,
    // эффект монтирования перезапускается и сбрасывает «автообновление уже запускалось».
    useCallback(fn, deps) {
      const index = hooks.cursor;
      hooks.cursor += 1;
      const previous = hooks.callbacks[index];
      const changed =
        !previous ||
        !deps ||
        !previous.deps ||
        deps.length !== previous.deps.length ||
        deps.some((value, position) => !Object.is(value, previous.deps[position]));
      if (changed) hooks.callbacks[index] = { fn, deps };
      return hooks.callbacks[index].fn;
    },
    useRef(value) {
      const index = hooks.cursor;
      hooks.cursor += 1;
      if (!(index in hooks.hooks)) hooks.hooks[index] = { current: value };
      return hooks.hooks[index];
    },
    jsx: (type, props) => ({ type: typeof type === "function" ? type.displayName || type.name || "fn" : type, props }),
    jsxs: (type, props) => ({ type: typeof type === "function" ? type.displayName || type.name || "fn" : type, props }),
    request: api.request,
    rlmRequest: api.rlmRequest,
    Card: stub("Card"),
    Row: stub("Row"),
    Field: stub("Field"),
    Check: stub("Check"),
    Btn: stub("Btn"),
    Dot: stub("Dot"),
    JobBox: stub("JobBox"),
  };
}

function factoryFor(deps) {
  const factory = new Function(
    "deps",
    "const { useState, useEffect, useCallback, useRef, jsx, jsxs, request, rlmRequest, Card, Row, Field, Check, Btn, Dot, JobBox } = deps;\n" +
      block +
      "\nreturn RlmIndexCard;",
  );
  return factory(deps);
}

/** Дерево узлов: хватает, чтобы найти кнопку по подписи и собрать текст заметки. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node.props) return;
  visit(node);
  for (const value of Object.values(node.props)) {
    if (value && typeof value === "object") walk(value, visit);
  }
}

function textOf(node) {
  const parts = [];
  const collect = (value) => {
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!value.props) return;
    collect(value.props.children);
  };
  collect(node);
  return parts.join(" ");
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

const buttons = (tree) => findAll(tree, (node) => node.type === "Btn");
const buttonByLabel = (tree, label) => buttons(tree).find((node) => node.props.children === label);
const noteText = (tree) => textOf(tree);

/**
 * Монтирование карточки с подставным ответом хоста. state — то, что вернёт /index/state;
 * вызовы /index/job складываются в api.jobs.
 */
async function mountCard(state, { path = "D:\\projects\\nested" } = {}) {
  const hooks = createHooks();
  const api = {
    jobs: [],
    states: 0,
    request: async (url) => {
      if (url === "/project-index") return { ok: true };
      return { ok: true };
    },
    rlmRequest: async (url, init) => {
      if (url.startsWith("/index/state")) {
        api.states += 1;
        return typeof state === "function" ? state(api.states) : state;
      }
      if (url === "/index/job") {
        const body = JSON.parse(init.body);
        api.jobs.push({ path: body.path, action: body.action });
        return { ok: true };
      }
      if (url === "/index/config") return typeof state === "function" ? state(api.states) : state;
      if (url === "/index/cancel") return { ok: true };
      return { ok: true };
    },
  };
  const deps = makeDeps(hooks, api);
  const Card = factoryFor(deps);
  let tree = null;
  const props = { path };

  const draw = () => {
    hooks.reset();
    tree = Card(props);
    const effects = hooks.effects.slice();
    hooks.effects = [];
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
    }
  };

  draw();
  await sleep(20);
  // Доводим до устойчивого состояния: load() асинхронный, setState перерисовывает.
  for (let pass = 0; pass < 12; pass += 1) {
    if (!hooks.dirty) break;
    hooks.dirty = false;
    draw();
    await sleep(20);
  }
  for (const cleanup of hooks.cleanups) {
    try {
      cleanup();
    } catch {}
  }
  return { tree, api, hooks };
}

const baseState = (status, extra = {}) => ({
  ok: true,
  bin: "C:\\tools\\rlm-bsl-index.exe",
  enabled: true,
  checking: false,
  path: "D:\\projects\\nested",
  target: { path: "D:\\projects\\nested\\src", custom: true },
  indexPath: "src",
  project: null,
  job: null,
  index: { ok: true, status, statusText: status, size: "634.5 MB", built: "5m ago", dbPath: "C:\\cache\\x\\bsl_index.db" },
  ...extra,
});

console.log("карточка индекса: автообновление");

// 1. «Структура изменилась» обновлением не лечится: карточка не запускает его сама.
{
  const { tree, api } = await mountCard(baseState("stale_structure"));
  assert.equal(api.jobs.length, 0, "при stale_structure автообновление не запускается: " + JSON.stringify(api.jobs));
  assert.ok(buttonByLabel(tree, "Пересобрать"), "есть кнопка полной пересборки");
  const note = noteText(tree);
  assert.match(note, /\.gitignore/, "заметка объясняет, почему обновление не помогает");
  assert.match(note, /На диске не тот набор файлов/, "заметка называет причину");
  console.log("  ok   stale_structure: автообновления нет, есть «Пересобрать» и объяснение");
}

// 2. «Файлы изменились» — обновление уместно, карточка запускает его сама.
{
  const { api } = await mountCard(baseState("stale_content"));
  assert.equal(api.jobs.length, 1, "при stale_content автообновление запускается");
  assert.equal(api.jobs[0].action, "update");
  console.log("  ok   stale_content: автообновление update");
}

// 3. «Устарел по возрасту» — тоже обновление.
{
  const { api } = await mountCard(baseState("stale_age"));
  assert.equal(api.jobs.length, 1);
  assert.equal(api.jobs[0].action, "update");
  console.log("  ok   stale_age: автообновление update");
}

// 4. Актуальный индекс и отсутствие индекса: автообновления нет, у отсутствующего — «Собрать».
{
  const fresh = await mountCard(baseState("fresh"));
  assert.equal(fresh.api.jobs.length, 0, "актуальный индекс не трогаем");
  const missing = await mountCard(baseState("missing"));
  assert.equal(missing.api.jobs.length, 0, "сборку отсутствующего индекса запускает хост, не карточка");
  assert.ok(buttonByLabel(missing.tree, "Собрать"), "у отсутствующего индекса кнопка «Собрать»");
  console.log("  ok   fresh/missing: без автообновления, кнопки называют действие");
}

// 4b. Проверка не уложилась в таймаут: это не ошибка и не повод что-то запускать.
{
  const { tree, api } = await mountCard(
    baseState("unchecked", {
      index: { ok: false, status: "unchecked", error: "проверка свежести не закончилась за 15 мин: каталог большой или диск медленный." },
    }),
  );
  assert.equal(api.jobs.length, 0, "при unchecked ничего не запускается само");
  assert.equal(buttonByLabel(tree, "Обновить").props.children, "Обновить", "действие по умолчанию — дешёвое обновление");
  const errNote = findAll(tree, (node) => node.type === "div" && String(node.props.className || "").includes("p1c-note--err"));
  assert.equal(errNote.length, 0, "таймаут показывается нейтрально, без красного");
  assert.match(noteText(tree), /не закончилась за 15 мин/);
  console.log("  ok   unchecked: без автообновления, текст нейтральный");
}

console.log("карточка индекса: кнопки");

// 5. «Пересобрать» запускает полную сборку, рядом остаётся дешёвое «Обновить».
{
  const { tree, api } = await mountCard(baseState("stale_structure"));
  buttonByLabel(tree, "Пересобрать").props.onClick();
  await sleep(20);
  assert.deepEqual(api.jobs.at(-1), { path: "D:\\projects\\nested", action: "build" }, "«Пересобрать» — это build");
  buttonByLabel(tree, "Обновить").props.onClick();
  await sleep(20);
  assert.deepEqual(api.jobs.at(-1), { path: "D:\\projects\\nested", action: "update" }, "«Обновить» — это update");
  console.log("  ok   «Пересобрать» → build, «Обновить» → update");
}

// 6. У вложенной выгрузки видно, что индексируется именно она.
{
  const { tree } = await mountCard(baseState("fresh"));
  assert.match(noteText(tree), /Индексируется папка выгрузки/, "карточка называет папку выгрузки");
  assert.match(noteText(tree), /nested\\src/, "путь выгрузки показан целиком");
  const pathField = findAll(tree, (node) => node.type === "Field" && node.props.label === "Папка выгрузки")[0];
  assert.ok(pathField, "есть поле «Папка выгрузки»");
  assert.match(String(pathField.props.hint), /Пусто — папка проекта: D:\\projects\\nested/);
  console.log("  ok   папка выгрузки: поле настройки и «Индексируется папка выгрузки: …\\src»");
}

console.log("карточка индекса: пока идёт проверка");

// 7. Пока свежесть проверяется, галочка не врёт «выключено» и статус не «неизвестно».
{
  let calls = 0;
  const state = () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        bin: "C:\\tools\\rlm-bsl-index.exe",
        enabled: true,
        checking: true,
        path: "D:\\projects\\nested",
        target: { path: "D:\\projects\\nested\\src", custom: true },
        project: null,
        job: null,
        index: null,
      };
    }
    return baseState("fresh");
  };
  const { tree } = await mountCard(state, { path: "D:\\projects\\nested" });
  const check = findAll(tree, (node) => node.type === "Check")[0];
  assert.ok(check, "галочка отрисована");
  assert.equal(check.props.checked, true, "галочка читается из параметров проекта, а не по умолчанию");
  assert.equal(check.props.children, "индексировать проект", "подпись вернулась после проверки");
  console.log("  ok   проверка… → checked из параметров проекта (без мигания «выключено»)");
}

// 8. Первая отрисовка, когда ответа хоста ещё нет: подпись честно говорит «читаю».
{
  const { tree } = await mountCard(() => new Promise(() => {}));
  const check = findAll(tree, (node) => node.type === "Check")[0];
  assert.ok(check, "галочка отрисована");
  assert.equal(check.props.checked, false);
  assert.equal(check.props.disabled, true, "до чтения параметров галочка неактивна");
  assert.match(String(check.props.children), /читаю параметры проекта/);
  console.log("  ok   до ответа хоста: «читаю параметры проекта…», галочка неактивна");
}

console.log("OK: карточка индекса (правила автообновления, кнопки, состояния загрузки)");
