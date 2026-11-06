// Инструменты агента: проверка кода до записи, проверка файлов, принятие и
// управление проектом.
//
// Свой MCP-сервер, потому что поверхность движка слишком широка: у него в
// профиле workspace ещё поиск, граф, метаданные и живые вызовы в базе, а агенту
// нужны понятные действия. Заодно так видно, что именно вызвал агент.
//
// Ошибки отдаются машинно: { code, error, hint }. Агент по коду понимает, что
// делать дальше, а не читает «нет проектов» без указания шага.
//
// Транспорт — streamable HTTP на localhost: сервер поднимается вместе с
// плагином, MCP-менеджер получает URL и показывает его как обычный сервер.
import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { acceptFindings, loadAccepted } from "./acceptance.js";
import { checkFiles, loadLast } from "./check.js";
import { engineStatus, ensureEngine } from "./engine.js";
import { checksReady, patchParams, readParams } from "./params.js";
import { resolvePreset } from "./presets.js";
import { checkSnippet, closeAllSnippetSessions } from "./snippet.js";
import { MAX_CODE_CHARS, reviewCode } from "../naparnik-public.js";

export const MCP_SERVER_NAME = "1c-bsl-checks";
const PROTOCOL_VERSION = "2025-06-18";

const PROJECT_PARAM = {
  type: "string",
  description:
    "Путь к каталогу проекта (например D:\\Work\\hrm1) или его имя. Можно не указывать, если проект один.",
};

// Имена, которые агент приносит из чужих наборов правил (1С-наборы под другую сборку MCP).
// Отвечаем адресно: выдуманное имя не должно превращаться в повторную догадку. В tools/list
// этих имён нет — поверхность инструментов не растёт.
const INVENTED_TOOLS = {
  syntaxcheck: "bsl_check_files",
  check_1c_code: "bsl_check_files",
  review_1c_code: "bsl_review",
  trace_impact: "bsl_check_files",
  search_function: "rlm: find_module",
  ssl_search: "v8std_search",
  templatesearch: "rlm: find_module",
};

const TOOLS = [
  {
    name: "bsl_check_text",
    description:
      "Проверить фрагмент BSL-кода до записи в файл. Возвращает замечания анализатора в контексте указанного модуля; файлы на диске не меняются.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Текст BSL-кода" },
        file: { type: "string", description: "Путь модуля относительно выгрузки, задаёт контекст" },
        project: PROJECT_PARAM,
      },
      required: ["code"],
    },
  },
  {
    name: "bsl_check_files",
    description:
      "Проверить перечисленные файлы выгрузки. Возвращает новые и ранее пропущенные замечания по каждому файлу.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Пути файлов относительно выгрузки" },
        project: PROJECT_PARAM,
      },
      required: ["files"],
    },
  },
  {
    name: "bsl_skip_findings",
    description:
      "Пропустить текущие замечания перечисленных файлов: они перестанут показываться как новые. Код не меняется, замечания остаются в журнале прогона.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Пути файлов относительно выгрузки" },
        project: PROJECT_PARAM,
      },
      required: ["files"],
    },
  },
  {
    name: "bsl_findings_pending",
    description:
      "Замечания последнего прогона, которые ещё не приняты. Агент забирает готовый список, чтобы исправить код; принятые и скрытые из-за незагруженных метаданных сюда не попадают.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PARAM,
        files: {
          type: "array",
          items: { type: "string" },
          description: "Ограничить перечисленными файлами (пути относительно выгрузки)",
        },
      },
    },
  },
  {
    name: "bsl_review",
    description:
      "Второе мнение по коду 1С от 1С:Напарника: независимый ревьюер находит дефекты в модуле, функции или диффе. " +
      "Вызывать перед вердиктом «ревью готово» по BSL-коду; свой разбор и этот не заменяют друг друга, расхождения назвать. " +
      "Не заменяет bsl_check_text/bsl_check_files (правила) и справку платформы: это вторая голова, а не компилятор. " +
      "Передавайте код текстом, модуль целиком или изменённый фрагмент; потолок " + MAX_CODE_CHARS + " знаков, длинное дробится.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Код, дифф или модуль целиком. Обязательно." },
        context: { type: "string", description: "Что за задача и что менялось — повышает качество находок." },
        focus: {
          type: "string",
          description: "На что смотреть в первую очередь: транзакции, запрос в цикле, права, клиент-сервер, совместимость.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "bsl_projects_list",
    description:
      "Показать проекты, известные плагину: путь, включён ли анализ, какая задана выгрузка, сколько замечаний принято. Первый шаг, когда анализ не отвечает.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bsl_project_enable",
    description:
      "Включить статический анализ для проекта и задать каталог выгрузки. Меняет только .dsh/1c-project.json проекта.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PARAM,
        dumpDir: {
          type: "string",
          description: "Каталог выгрузки конфигурации (где лежит Configuration.xml). По умолчанию — сам проект.",
        },
        enabled: { type: "boolean", description: "Включить или выключить анализ. По умолчанию включить." },
      },
      required: ["project"],
    },
  },
];

function fail(code, error, hint, details) {
  const payload = { ok: false, code, error, hint };
  if (details !== undefined) payload.details = details;
  return payload;
}

function normalizePath(value) {
  return String(value || "")
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function looksLikePath(value) {
  const text = String(value || "");
  return text.includes("/") || text.includes("\\") || /^[a-zA-Z]:$/.test(text.slice(0, 2));
}

function knownProject(item) {
  const state = checksReady(item.path);
  return {
    path: item.path,
    name: item.name || basename(item.path),
    enabled: state.enabled,
    dumpDir: state.dumpDir,
    preset: state.params.checksPreset || "",
  };
}

/** Найти проект по аргументу: путь, имя или единственный включённый. */
function resolveProject(projects, wanted) {
  const list = Array.isArray(projects) ? projects : [];
  const known = list.map(knownProject);

  if (wanted) {
    const text = String(wanted).trim();
    if (existsSync(text) && statSync(text).isDirectory()) {
      const same = known.find((item) => normalizePath(item.path) === normalizePath(text));
      return { project: same || { path: text, name: basename(text), enabled: false, dumpDir: "", preset: "" } };
    }
    const wantedNorm = normalizePath(text).replace(/^.*\//, "");
    const byPath = known.find((item) => normalizePath(item.path) === normalizePath(text));
    if (byPath) return { project: byPath };
    const byName = known.find(
      (item) =>
        String(item.name).toLowerCase() === text.toLowerCase() ||
        normalizePath(item.path).replace(/^.*\//, "") === wantedNorm,
    );
    if (byName) return { project: byName };
    return {
      error: fail(
        "project_not_found",
        "Проект не найден: " + text,
        known.length
          ? "Передайте полный путь к каталогу проекта или имя из списка."
          : "Плагин пока не знает ни одного проекта. Передайте путь к каталогу проекта, например D:\\Work\\hrm1.",
        { known: known.map((item) => item.path) },
      ),
    };
  }

  if (!known.length) {
    return {
      error: fail(
        "no_projects",
        "Плагину пока не известен ни один проект",
        "Передайте project полным путём к каталогу проекта (где лежит .dsh/1c-project.json или Configuration.xml). Список известных проектов — bsl_projects_list.",
      ),
    };
  }

  const ready = known.filter((item) => item.enabled && item.dumpDir);
  if (ready.length === 1) return { project: ready[0] };
  if (!ready.length) {
    const broken = known.map((item) => ({
      path: item.path,
      enabled: item.enabled,
      dumpDir: item.dumpDir,
    }));
    return {
      error: fail(
        "checks_disabled",
        "Статический анализ не настроен ни для одного проекта",
        "Вызовите bsl_project_enable с путём проекта и каталогом выгрузки — этого достаточно, чтобы проверки заработали.",
        { projects: broken },
      ),
    };
  }
  return {
    error: fail(
      "ambiguous_project",
      "Проектов несколько, нужно указать project",
      "Передайте project: путь к нужному каталогу.",
      { projects: ready.map((item) => item.path) },
    ),
  };
}

function statusPayload(projectPath) {
  const params = readParams(projectPath);
  const state = checksReady(projectPath);
  return {
    project: projectPath,
    enabled: state.enabled,
    dumpDir: state.dumpDir,
    preset: state.params.checksPreset || "",
    accepted: loadAccepted(projectPath).items.length,
    engine: engineStatus(),
  };
}

function requireReady(projectPath) {
  const state = checksReady(projectPath);
  if (!state.enabled) {
    return {
      error: fail(
        "checks_disabled",
        "Статический анализ выключен в параметрах проекта",
        "Включите его: bsl_project_enable { project, dumpDir } или галочка в карточке «Статический анализ кода».",
        { project: projectPath },
      ),
    };
  }
  if (!state.dumpDir) {
    return {
      error: fail(
        "dump_dir_missing",
        "В проекте не задан каталог выгрузки конфигурации",
        "Укажите его: bsl_project_enable { project, dumpDir } — путь к каталогу, где лежит Configuration.xml.",
        { project: projectPath },
      ),
    };
  }
  return { state };
}

async function ensureBinary() {
  const ready = engineStatus().binary;
  if (ready) return { binary: ready };
  const downloaded = await ensureEngine();
  if (!downloaded.ok || !downloaded.binary) {
    return {
      error: fail(
        "engine_missing",
        "Движок проверок не установлен",
        "Пользователь скачивает его кнопкой «Скачать движок проверок» в карточке «Статический анализ кода» (около 76 МБ, один раз).",
      ),
    };
  }
  return { binary: downloaded.binary };
}

// Ключ Напарника приходит сверху: сервер инструментов не читает настройки сам.
let naparnikToken = () => "";
export function setNaparnikTokenSource(source) {
  naparnikToken = typeof source === "function" ? source : () => "";
}

async function callTool(name, args, projects) {
  if (name === "bsl_review") {
    const result = await reviewCode({
      token: String(naparnikToken() || ""),
      code: args?.code,
      context: args?.context,
      focus: args?.focus,
    });
    if (result.ok) return { ok: true, review: result.review, attempts: result.attempts, elapsedMs: result.elapsedMs };
    return fail(result.code || "review_failed", result.error, result.hint, {
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
    });
  }

  if (name === "bsl_findings_pending") {
    const found = resolveProject(projects, args?.project);
    if (found.error) return found.error;
    const projectPath = found.project.path;
    const last = loadLast(projectPath);
    if (!last) {
      return fail(
        "no_last_run",
        "Проверок по проекту ещё не было",
        "Запустите bsl_check_files с нужными файлами или кнопку «Проверить» в панели «Анализ кода 1С».",
        { project: projectPath },
      );
    }
    // Принятые могли пополниться после прогона: сверяемся с хранилищем, а не
    // только с отметкой в файле последнего результата.
    const accepted = new Set(loadAccepted(projectPath).items.map((item) => item.k));
    const wanted = Array.isArray(args?.files) && args.files.length
      ? new Set(args.files.map((file) => String(file).replace(/\\/g, "/").toLowerCase()))
      : null;
    const pending = [];
    for (const file of last.files || []) {
      const fileKey = String(file.path).replace(/\\/g, "/").toLowerCase();
      if (wanted && !wanted.has(fileKey)) continue;
      for (const finding of file.findings || []) {
        if (finding.accepted) continue;
        if (accepted.has(finding.key)) continue;
        pending.push({
          path: file.path,
          absolute: last.dumpDir ? last.dumpDir.replace(/[\\/]+$/, "") + "\\" + file.path.replace(/\//g, "\\") : file.path,
          line: finding.line,
          column: finding.column,
          code: finding.code,
          severity: finding.severity,
          message: finding.message,
          key: finding.key,
        });
      }
    }
    const touched = new Set(pending.map((item) => item.path));
    return {
      ok: true,
      project: projectPath,
      checkedAt: last.checkedAt,
      preset: last.presetId,
      metadata: last.metadata,
      counts: { pending: pending.length, files: touched.size },
      findings: pending,
    };
  }

  if (name === "bsl_projects_list") {
    const list = Array.isArray(projects) ? projects.map(knownProject) : [];
    return { ok: true, projects: list, engine: engineStatus() };
  }

  if (name === "bsl_project_enable") {
    const found = resolveProject(projects, args?.project);
    if (found.error) return found.error;
    const projectPath = found.project.path;
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      return fail("project_not_found", "Каталог проекта не существует: " + projectPath, "Проверьте путь.");
    }
    const enabled = args?.enabled !== false;
    const params = readParams(projectPath);
    const dumpDir =
      typeof args?.dumpDir === "string" && args.dumpDir.trim()
        ? args.dumpDir.trim()
        : params.dumpDir || (existsSync(join(projectPath, "Configuration.xml")) ? projectPath : "");
    patchParams(projectPath, { checksEnabled: enabled, dumpDir });
    const status = statusPayload(projectPath);
    const notes = [];
    if (dumpDir && !existsSync(join(dumpDir, "Configuration.xml"))) {
      notes.push(
        "В каталоге выгрузки нет Configuration.xml: метаданные не загрузятся, часть проверок имён и запросов будет ложной.",
      );
    }
    return { ok: true, ...status, notes };
  }

  const found = resolveProject(projects, args?.project);
  if (found.error) return found.error;
  const projectPath = found.project.path;
  const ready = requireReady(projectPath);
  if (ready.error) return ready.error;
  const state = ready.state;
  const { preset } = resolvePreset(state.params.checksPreset);

  if (name === "bsl_check_text") {
    const engine = await ensureBinary();
    if (engine.error) return engine.error;
    const result = await checkSnippet({
      binary: engine.binary,
      sourceDir: state.dumpDir,
      code: String(args.code || ""),
      path: args.file ? String(args.file) : undefined,
      off: preset.off,
      threshold: preset.threshold,
    });
    if (!result.ok) {
      return fail("check_failed", result.error || "проверка не удалась", "Повторите вызов; если не помогает — смотрите журнал DSH.");
    }
    return {
      ok: true,
      project: projectPath,
      preset: preset.name,
      findings: result.findings,
      counts: { total: result.findings.length, hidden: result.hidden || 0 },
    };
  }

  const files = Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [];
  if (!files.length) {
    return fail("no_files", "Не указаны файлы", "Передайте files: пути модулей относительно каталога выгрузки.");
  }

  // Без движка проверять нечем: отдаём отдельный код, чтобы агент сказал
  // пользователю про кнопку скачивания, а не «проверка не удалась».
  const engineReady = await ensureBinary();
  if (engineReady.error) return engineReady.error;

  const result = await checkFiles({
    projectRoot: projectPath,
    dumpRoot: state.dumpDir,
    preset,
    files,
    by: "agent",
  });
  if (!result.ok) {
    const message = result.error || "проверка не удалась";
    const code = /движок/i.test(message) ? "engine_missing" : "check_failed";
    return fail(code, message, "Проверьте пути файлов относительно каталога выгрузки.");
  }

  if (name === "bsl_skip_findings") {
    const accepted = acceptFindings({
      projectRoot: projectPath,
      findings: result.findings,
      by: "agent",
      prunePaths: result.files.map((file) => file.path),
    });
    return {
      ok: true,
      project: projectPath,
      skippedNow: accepted.added,
      skippedTotal: accepted.total,
      files: result.files.map((file) => file.path),
    };
  }

  return {
    ok: true,
    project: projectPath,
    preset: preset.name,
    counts: result.counts,
    metadata: result.metadata,
    files: result.files.map((file) => ({
      path: file.path,
      passed: file.passed,
      findings: file.findings.map((finding) => ({
        line: finding.line,
        column: finding.column,
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        accepted: finding.accepted,
      })),
    })),
  };
}

function send(res, code, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function handleRpc(message, projects) {
  const { id, method, params } = message || {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: "0.2.0" },
      },
    };
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method !== "tools/call") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "метод не поддерживается: " + method } };
  }
  const name = params?.name;
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) {
    const instead = INVENTED_TOOLS[String(name).toLowerCase()];
    if (instead) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "инструмента " + name + " нет. Используй " + instead + "." },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: "неизвестный инструмент: " + name } };
  }
  try {
    const payload = await callTool(name, params.arguments || {}, projects);
    // Отказ отдаём и текстом, и полями: текст читает человек в логе, код —
    // агент, который решает, что делать дальше.
    const text = payload.ok === false ? [payload.error, payload.hint].filter(Boolean).join(" ") : JSON.stringify(payload);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text }],
        structuredContent: payload,
        isError: payload.ok === false,
      },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: String(error?.message || error) }],
        structuredContent: fail("internal_error", String(error?.message || error), ""),
        isError: true,
      },
    };
  }
}

/**
 * Поднять MCP-сервер на свободном порту.
 *
 * @param {{ projects: () => Promise<object[]> | object[] }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startChecksMcpServer(options) {
  setNaparnikTokenSource(options && options.naparnikToken);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      send(res, 405, { error: "только POST" });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "не разобран JSON" } });
      return;
    }
    const projects = typeof options.projects === "function" ? await options.projects() : options.projects;
    const reply = await handleRpc(message, projects);
    if (!reply) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, reply);
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  return {
    url: "http://127.0.0.1:" + port + "/mcp",
    close: async () => {
      closeAllSnippetSessions();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

export function acceptedFor(projectPath) {
  return loadAccepted(projectPath).items.length;
}

export { readParams };
