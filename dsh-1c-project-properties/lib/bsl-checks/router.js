// HTTP-роуты проверок кода для интерфейса плагина.
//
// Все роуты живут под /1cprops/bsl-checks и отдают JSON. Логика проверок — в
// соседних модулях: здесь только разбор запроса, чтение параметров проекта и
// единый вид ответа.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { acceptFindings, loadAccepted, restoreFindings } from "./acceptance.js";
import { categories, catalog, THRESHOLDS } from "./catalog.js";
import { checkFiles, loadLast } from "./check.js";
import { CONFIG_FILE } from "./config.js";
import { engineStatus, ensureEngine } from "./engine.js";
import { createPreset, deletePreset, editPreset, listPresets, renamePreset, resolvePreset } from "./presets.js";
import { checkSnippet, closeAllSnippetSessions } from "./snippet.js";

const ROUTE = "/1cprops/bsl-checks";
const PARAMS_REL = ".dsh/1c-project.json";

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("тело запроса слишком большое"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readParams(projectPath) {
  const file = join(projectPath, PARAMS_REL);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) || {};
  } catch {
    return {};
  }
}

function patchParams(projectPath, patch) {
  const file = join(projectPath, PARAMS_REL);
  const current = readParams(projectPath);
  const next = { ...current, ...patch };
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return next;
}

// Ручной запуск принимает и файл, и папку: папку раскрываем в модули .bsl.
// Ограничение по числу файлов есть, чтобы случайный корень диска не превратился
// в многочасовой прогон.
const MAX_EXPANDED_FILES = 400;

function collectModules(dir, root, out, depth) {
  if (out.length >= MAX_EXPANDED_FILES || depth > 14) return;
  let items = [];
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (out.length >= MAX_EXPANDED_FILES) return;
    if (item.name.startsWith(".")) continue;
    const full = join(dir, item.name);
    if (item.isDirectory()) collectModules(full, root, out, depth + 1);
    else if (/\.bsl$/i.test(item.name)) out.push(relative(root, full).split("\\").join("/"));
  }
}

// Путь принимаем в трёх видах: от каталога выгрузки, от корня проекта (так его
// копирует редактор) и абсолютный. Иначе вставленный из редактора адрес давал
// «в указанном пути нет модулей».
function normalizeEntry(dumpRoot, projectPath, text) {
  const candidates = [resolve(dumpRoot, text)];
  if (projectPath) candidates.push(resolve(projectPath, text));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function expandFiles(dumpRoot, projectPath, entries) {
  const out = [];
  for (const entry of entries) {
    const text = String(entry || "").trim();
    if (!text) continue;
    const absolute = normalizeEntry(dumpRoot, projectPath, text);
    let stat = null;
    try {
      stat = statSync(absolute);
    } catch {
      out.push(text);
      continue;
    }
    if (stat.isDirectory()) {
      collectModules(absolute, dumpRoot, out, 0);
      continue;
    }
    const inside = relative(dumpRoot, absolute);
    out.push(inside.startsWith("..") ? text : inside.split("\\").join("/"));
  }
  return out;
}

function projectOf(source) {
  const value = source && typeof source === "object" ? source.project || source.path : source;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function presetOf(params) {
  const { preset, fallback } = resolvePreset(params.checksPreset);
  return { preset, fallback };
}

function state(projectPath) {
  const params = readParams(projectPath);
  const { preset, fallback } = presetOf(params);
  const engine = engineStatus();
  const rules = catalog();
  return {
    ok: true,
    enabled: params.checksEnabled === true,
    projectPath,
    dumpDir: typeof params.dumpDir === "string" ? params.dumpDir : "",
    presetId: preset.id,
    presetName: preset.name,
    presetFallback: fallback,
    presetBuiltin: Boolean(preset.builtin),
    threshold: preset.threshold,
    thresholds: THRESHOLDS,
    presets: listPresets().presets.map((item) => ({
      id: item.id,
      name: item.name,
      builtin: Boolean(item.builtin),
      threshold: item.threshold,
      enabled: rules.length - item.off.length,
    })),
    engine,
    catalog: {
      total: rules.length,
      categories: categories().map((name) => ({
        name,
        rules: rules.filter((rule) => rule.category === name).length,
      })),
    },
    accepted: loadAccepted(projectPath).items.length,
    configFile: join(projectPath, CONFIG_FILE),
  };
}

/**
 * Зарегистрировать роуты в webServer плагина.
 * @param {{ webServer: any }} ctx
 */
export function registerBslChecksRoutes(ctx, deps = {}) {
  // Список проектов приходит сверху: роутам он нужен, чтобы понять, включён
  // анализ хоть где-то (скачивание движка) — без привязки к одному проекту.
  const listProjects = typeof deps.listProjects === "function" ? deps.listProjects : () => [];
  // Движок скачали — верхний слой может захотеть пересобрать регистрацию MCP
  // (Напарник живёт в том же бинарнике и без него не подключается).
  const onEngineReady = typeof deps.onEngineReady === "function" ? deps.onEngineReady : () => {};
  // Ответ вкладки настроек: у неё нет проекта, только общие наборы и движок.
  const storeState = () => {
    const rules = catalog();
    return {
      ok: true,
      presets: listPresets().presets.map((item) => ({
        id: item.id,
        name: item.name,
        builtin: Boolean(item.builtin),
        threshold: item.threshold,
        enabled: rules.length - item.off.length,
      })),
      catalog: { total: rules.length, categories: categories().map((name) => ({ name })) },
      engine: engineStatus(),
    };
  };

  const routes = [
    {
      path: "/state",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://local");
          const projectPath = projectOf(url.searchParams.get("project"));
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          json(res, 200, state(projectPath));
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/presets",
      handler: async (_req, res) => {
        try {
          json(res, 200, storeState());
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/panel",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://local");
          const projectPath = projectOf(url.searchParams.get("project"));
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          const params = readParams(projectPath);
          const last = loadLast(projectPath);
          // last.json — снимок прогона. Пропущенные живут отдельно и меняются
          // после него, поэтому отметки проставляем при чтении, иначе кнопка
          // «Пропустить» не даёт видимого эффекта.
          if (last && Array.isArray(last.files)) {
            const skip = new Set(loadAccepted(projectPath).items.map((item) => item.k));
            last.files = last.files.map((file) => ({
              ...file,
              findings: (file.findings || []).map((finding) => ({ ...finding, accepted: skip.has(finding.key) })),
            }));
          }
          json(res, 200, {
            ok: true,
            enabled: params.checksEnabled === true,
            dumpDir: typeof params.dumpDir === "string" ? params.dumpDir : "",
            presetName: presetOf(params).preset.name,
            accepted: loadAccepted(projectPath).items.length,
            last,
          });
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/rules",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://local");
          const projectPath = projectOf(url.searchParams.get("project"));
          // Вкладка анализа кода работает с набором напрямую, без привязки
          // к проекту: набор один на машину, проект лишь ссылается на него.
          const presetId = String(url.searchParams.get("presetId") || "");
          if (!projectPath && !presetId) return json(res, 400, { ok: false, error: "не указан проект или набор" });
          const { preset } = presetId ? resolvePreset(presetId) : presetOf(readParams(projectPath));
          const off = new Set(preset.off);
          json(res, 200, {
            ok: true,
            presetId: preset.id,
            presetName: preset.name,
            presetBuiltin: Boolean(preset.builtin),
            threshold: preset.threshold,
            rules: catalog().map((rule) => ({
              code: rule.code,
              name: rule.name,
              severity: rule.severity,
              type: rule.type,
              category: rule.category,
              description: rule.description,
              on: !off.has(rule.code),
            })),
          });
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/engine",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (!body.download) return json(res, 200, { ok: true, ...engineStatus() });
          // Движок качаем только для проекта с включёнными проверками: без
          // галочки на диск не попадает ничего.
          // Движок качаем только при включённом анализе хотя бы в одном
          // проекте: без галочки на диск не попадает ничего.
          const asked = projectOf(body);
          const candidates = asked ? [asked] : listProjects().map((item) => (item && item.path) || "");
          const allowed = candidates.some((projectPath) => projectPath && readParams(projectPath).checksEnabled === true);
          if (!allowed) {
            return json(res, 400, { ok: false, error: "сначала включите статический анализ хотя бы в одном проекте" });
          }
          const result = await ensureEngine();
          if (result.ok) {
            Promise.resolve(onEngineReady()).catch(() => {});
          }
          json(res, result.ok ? 200 : 400, { ok: result.ok, error: result.error, ...engineStatus() });
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/preset",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const projectPath = projectOf(body);
          const reply = (result) =>
            json(res, result.ok === false ? 400 : 200, projectPath ? { ...state(projectPath), ...result } : { ...storeState(), ...result });
          if (body.action === "select") {
            if (!projectPath) return json(res, 400, { ok: false, error: "набор выбирается в параметрах проекта" });
            patchParams(projectPath, { checksPreset: String(body.presetId || "") });
            return json(res, 200, state(projectPath));
          }
          if (body.action === "delete") {
            const presetId = String(body.presetId || "");
            const removed = deletePreset(presetId);
            // Проект ссылался на удалённый набор — откатываем его на поставку,
            // чтобы в карточке не висело имя, которого больше нет.
            const rolledBack = Boolean(projectPath) && removed.ok && readParams(projectPath).checksPreset === presetId;
            if (rolledBack) patchParams(projectPath, { checksPreset: "recommended" });
            return reply({ ...removed, rolledBack });
          }
          if (body.action === "rename") {
            const renamed = renamePreset(String(body.presetId || ""), body.name);
            return reply(renamed);
          }
          if (body.action === "create") {
            // Копия текущего набора: правила и порог берём у основы, если их не
            // передали явно. Созданный набор сразу становится набором проекта.
            const baseId = body.base ? String(body.base) : "";
            const basePreset = baseId ? resolvePreset(baseId).preset : null;
            const created = createPreset({
              name: body.name || (basePreset ? basePreset.name + " (мой)" : ""),
              off: Array.isArray(body.off) ? body.off : basePreset ? basePreset.off : undefined,
              threshold: body.threshold || (basePreset ? basePreset.threshold : undefined),
              base: baseId,
            });
            if (created.ok && projectPath) patchParams(projectPath, { checksPreset: created.preset.id });
            return reply(created);
          }
          // Правка набора поставки создаёт копию и переключает на неё проект.
          const edited = editPreset({
            id: String(body.presetId || body.id || ""),
            name: body.name,
            off: body.off,
            threshold: body.threshold,
          });
          if (edited.ok && projectPath) patchParams(projectPath, { checksPreset: edited.preset.id });
          reply(edited);
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/toggle",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const projectPath = projectOf(body);
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          patchParams(projectPath, { checksEnabled: body.enabled !== false });
          if (body.enabled === false) closeAllSnippetSessions();
          json(res, 200, state(projectPath));
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/check",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const projectPath = projectOf(body);
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          const params = readParams(projectPath);
          if (params.checksEnabled !== true) {
            return json(res, 400, { ok: false, error: "статический анализ выключен в параметрах проекта" });
          }
          const dumpDir = typeof params.dumpDir === "string" ? params.dumpDir : "";
          if (!dumpDir) return json(res, 400, { ok: false, error: "в проекте не задана выгрузка конфигурации" });
          const requested = Array.isArray(body.files) ? body.files.filter(Boolean) : [];
          const files = expandFiles(dumpDir, projectPath, requested);
          // Проверка всего проекта не входит в сценарий: агент проверяет файлы,
          // которые правит. Пустой список — ошибка вызова, а не полный обход.
          if (!files.length) {
            return json(res, 400, {
              ok: false,
              error: requested.length
                ? "в указанном пути нет модулей .bsl"
                : "не указаны файлы для проверки",
            });
          }
          const { preset } = presetOf(params);
          const result = await checkFiles({
            projectRoot: projectPath,
            dumpRoot: dumpDir,
            preset,
            files,
            by: body.by,
          });
          json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/snippet",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const projectPath = projectOf(body);
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          const params = readParams(projectPath);
          if (params.checksEnabled !== true) {
            return json(res, 400, { ok: false, error: "статический анализ выключен в параметрах проекта" });
          }
          const dumpDir = typeof params.dumpDir === "string" ? params.dumpDir : "";
          if (!dumpDir) return json(res, 400, { ok: false, error: "в проекте не задана выгрузка конфигурации" });
          const { preset } = presetOf(params);
          const result = await checkSnippet({
            binary: engineStatus().binary,
            sourceDir: dumpDir,
            code: String(body.code || ""),
            path: body.file ? String(body.file) : undefined,
            off: preset.off,
            threshold: preset.threshold,
          });
          json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      path: "/accept",
      handler: async (req, res) => {
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const projectPath = projectOf(body);
          if (!projectPath) return json(res, 400, { ok: false, error: "не указан проект" });
          if (body.all || body.restore) {
            const restored = restoreFindings({ projectRoot: projectPath, all: Boolean(body.all), keys: body.keys, path: body.file });
            return json(res, 200, { ...restored, ...state(projectPath) });
          }
          const result = acceptFindings({
            projectRoot: projectPath,
            findings: Array.isArray(body.findings) ? body.findings : [],
            keys: Array.isArray(body.keys) ? body.keys : undefined,
            by: body.by || "user",
          });
          json(res, 200, { ...result, ...state(projectPath) });
        } catch (error) {
          json(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
  ];

  for (const route of routes) {
    ctx.webServer.register({ kind: "exact", path: ROUTE + route.path, handler: route.handler });
  }
}

export { ROUTE as BSL_CHECKS_ROUTE };
