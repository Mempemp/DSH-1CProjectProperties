// dsh-1c-project-properties — хост-половина плагина.
//
// Хранит параметры 1С в разрезе проекта:
//   <папка проекта>/.dsh/1c-project.json                  — путь к базе, пользователь/пароль, путь к платформе
//   $DSH_HOME/1c-project-properties/settings.json         — общие значения (платформа по умолчанию)
//
// Список проектов = реестр воркспейсов DSH + дополнительные пути, добавленные вручную.
// Все роуты живут под префиксом /1cprops и отдают JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const name = "dsh-1c-project-properties";

// webServer — HTTP-роуты, workspaceRegistry — список проектов пользователя.
export const inject = ["webServer", "workspaceRegistry"];

const ROUTE = "/1cprops";
const SCHEMA = "dsh-1c-project-properties/v1";
const PARAMS_DIR = ".dsh";
const PARAMS_FILE = "1c-project.json";
const PARAMS_REL = PARAMS_DIR + "/" + PARAMS_FILE;

// Порядок ключей в файле проекта (и полный список поддерживаемых полей).
const PARAM_KEYS = ["infobasePath", "user", "password", "platformPath"];

// $DSH_HOME: та же приоритетность, что у ядра — переменная окружения, иначе ~/.dsh.
const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : join(homedir(), ".dsh");
})();
const COMMON_FILE = join(DSH_HOME, "1c-project-properties", "settings.json");

// ── утилиты файловой системы ────────────────────────────────────────────────

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
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

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Запись через временный файл: падение процесса не оставит обрезанный JSON.
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

// ── пути проектов ───────────────────────────────────────────────────────────

function canonical(p) {
  const abs = resolve(String(p));
  const stripped = abs.replace(/[\\/]+$/, "");
  return stripped || abs;
}

function pathKey(p) {
  const c = canonical(p);
  return process.platform === "win32" ? c.toLowerCase() : c;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── общие (машинные) настройки ──────────────────────────────────────────────

function readCommon() {
  const raw = readJson(COMMON_FILE) ?? {};
  return {
    platformPath: typeof raw.platformPath === "string" ? raw.platformPath : "",
    extraProjects: Array.isArray(raw.extraProjects)
      ? raw.extraProjects.filter((p) => typeof p === "string" && p.trim()).map((p) => canonical(p))
      : [],
  };
}

function writeCommon(next) {
  writeJson(COMMON_FILE, next);
  return next;
}

// ── параметры проекта ───────────────────────────────────────────────────────

function paramsFile(projectPath) {
  return join(projectPath, PARAMS_DIR, PARAMS_FILE);
}

function readParams(projectPath) {
  const file = paramsFile(projectPath);
  const raw = readJson(file);
  const params = {};
  for (const key of PARAM_KEYS) params[key] = typeof raw?.[key] === "string" ? raw[key] : "";
  return { file, hasFile: raw !== null, params };
}

// Сохраняет только известные поля; чужие ключи в файле не теряются.
function saveParams(projectPath, patch) {
  const file = paramsFile(projectPath);
  const current = readJson(file) ?? {};
  const next = { $schema: SCHEMA };
  for (const key of PARAM_KEYS) {
    const value = patch?.[key];
    next[key] = typeof value === "string" ? value : typeof current[key] === "string" ? current[key] : "";
  }
  for (const [key, value] of Object.entries(current)) {
    if (!(key in next)) next[key] = value;
  }
  writeJson(file, next);
  return next;
}

// ── поиск установленных платформ 1С ─────────────────────────────────────────

function compareVersions(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectPlatforms() {
  const roots = [
    join(process.env.ProgramFiles || "C:\\Program Files", "1cv8"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "1cv8"),
  ];
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "Programs", "1cv8"));

  const found = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = join(root, entry.name, "bin", "1cv8.exe");
      if (existsSync(exe) && !found.has(entry.name)) found.set(entry.name, exe);
    }
  }
  return [...found.entries()]
    .map(([version, path]) => ({ version, path }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// ── сборка списка проектов ──────────────────────────────────────────────────

function listProjects(ctx, common) {
  const projects = [];
  const seen = new Set();

  let workspaces = [];
  try {
    workspaces = ctx.workspaceRegistry?.list?.() ?? [];
  } catch {
    workspaces = [];
  }
  for (const workspace of workspaces) {
    if (!workspace?.path) continue;
    const key = pathKey(workspace.path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({
      source: "workspace",
      path: canonical(workspace.path),
      title: workspace.title || basename(canonical(workspace.path)),
    });
  }

  for (const extra of common.extraProjects) {
    const key = pathKey(extra);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({ source: "extra", path: canonical(extra), title: basename(canonical(extra)) });
  }

  return projects;
}

function describeProject(entry, common) {
  const info = readParams(entry.path);
  const platformPath = info.params.platformPath;
  return {
    ...entry,
    exists: isDirectory(entry.path),
    hasFile: info.hasFile,
    filePath: info.file,
    params: info.params,
    effectivePlatformPath: platformPath || common.platformPath,
    platformFromCommon: platformPath === "",
  };
}

// ── плагин ──────────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/state",
    handler: (_req, res) => {
      try {
        const common = readCommon();
        json(res, 200, {
          ok: true,
          paramsRel: PARAMS_REL,
          commonFile: COMMON_FILE,
          common,
          projects: listProjects(ctx, common).map((entry) => describeProject(entry, common)),
          platforms: detectPlatforms(),
        });
      } catch (error) {
        json(res, 500, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Общие значения: платформа по умолчанию для проектов, где путь не задан.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/common",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const common = readCommon();
        if (typeof body?.platformPath === "string") common.platformPath = body.platformPath.trim();
        writeCommon(common);
        json(res, 200, { ok: true, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Сохранение параметров одного проекта.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-save",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const target = String(body?.path ?? "").trim();
        if (!target || !isAbsolute(target)) {
          return json(res, 400, { ok: false, error: "нужен абсолютный путь к папке проекта" });
        }
        const projectPath = canonical(target);
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        saveParams(projectPath, body?.params ?? {});
        const common = readCommon();
        json(res, 200, { ok: true, ...describeProject({ source: "workspace", path: projectPath }, common) });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Чтение действующих параметров проекта — точка входа для других плагинов и агентов.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project",
    handler: (req, res) => {
      try {
        const target = new URL(req.url, "http://127.0.0.1").searchParams.get("path");
        if (!target) return json(res, 400, { ok: false, error: "параметр path обязателен" });
        const projectPath = canonical(target);
        const common = readCommon();
        const described = describeProject({ source: "lookup", path: projectPath }, common);
        json(res, 200, { ok: true, ...described });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Удаление файла параметров проекта.
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-clear",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const file = paramsFile(projectPath);
        try {
          unlinkSync(file);
        } catch {
          // файла нет — уже то, что нужно
        }
        json(res, 200, { ok: true, path: projectPath, hasFile: false, filePath: file });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  // Дополнительный путь в списке проектов (папка, не зарегистрированная в DSH).
  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-add",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        if (!isAbsolute(projectPath) || !isDirectory(projectPath)) {
          return json(res, 400, { ok: false, error: "папка не найдена: " + projectPath });
        }
        const common = readCommon();
        if (!common.extraProjects.some((p) => pathKey(p) === pathKey(projectPath))) {
          common.extraProjects.push(projectPath);
          writeCommon(common);
        }
        json(res, 200, { ok: true, path: projectPath, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: ROUTE + "/project-forget",
    handler: async (req, res) => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const projectPath = canonical(String(body?.path ?? "").trim());
        const common = readCommon();
        common.extraProjects = common.extraProjects.filter((p) => pathKey(p) !== pathKey(projectPath));
        writeCommon(common);
        json(res, 200, { ok: true, common });
      } catch (error) {
        json(res, 400, { ok: false, error: error?.message || String(error) });
      }
    },
  });
}
