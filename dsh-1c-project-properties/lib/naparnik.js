// Клиент 1С:Напарника: держит один процесс движка проверок в профиле reference
// и зовёт в нём `its_help`.
//
// Зачем свой клиент, а не транспорт MCP-менеджера: сервер движка отдаёт три
// инструмента (its_help, search, syntax_help), а агенту нужен один — остальные
// дублируют 1c-platform-context и v8std и только занимают место в списке. Поэтому
// сервер регистрируется как обёртка со своим списком инструментов, и вызов идёт
// отсюда, а не удалённо.
//
// Транспорт — stdio, JSON-RPC по строке на сообщение (спецификация MCP).
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT_MS = 25_000;
const CALL_TIMEOUT_MS = 130_000;
const LOG_TAIL_LINES = 30;

const state = {
  child: null,
  pid: 0,
  config: "",
  startedAt: 0,
  buffer: "",
  pending: new Map(),
  nextId: 1,
  logTail: [],
  error: "",
};

function pushLog(chunk) {
  const text = String(chunk || "");
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) state.logTail.push(line.trim());
  }
  if (state.logTail.length > LOG_TAIL_LINES) {
    state.logTail.splice(0, state.logTail.length - LOG_TAIL_LINES);
  }
}

function send(message) {
  const child = state.child;
  if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) {
    throw new Error("процесс Напарника не запущен");
  }
  child.stdin.write(JSON.stringify(message) + "\n");
}

function failAllPending(error) {
  for (const [, pending] of state.pending) pending.reject(error);
  state.pending.clear();
}

function readLines(chunk) {
  state.buffer += String(chunk || "");
  let cut = state.buffer.indexOf("\n");
  while (cut >= 0) {
    const line = state.buffer.slice(0, cut).trim();
    state.buffer = state.buffer.slice(cut + 1);
    cut = state.buffer.indexOf("\n");
    if (!line) continue;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      // Посторонний вывод в stdout не должен ронять диалог: движок пишет логи в stderr,
      // но лишняя строка от него не повод терять ответы на запросы.
      continue;
    }
    if (message.id == null) continue;
    const pending = state.pending.get(message.id);
    if (!pending) continue;
    state.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "ошибка MCP"));
    else pending.resolve(message.result);
  }
}

function request(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("Напарник не ответил за " + Math.round(timeoutMs / 1000) + " с"));
    }, timeoutMs);
    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/** Запустить процесс под текущий токен. Повторный вызов с теми же параметрами — no-op. */
export async function startNaparnik({ command, args, env }) {
  const key = JSON.stringify({ command, args, token: env?.NAPARNIK_TOKEN ?? "" });
  if (state.child && state.child.exitCode === null && state.config === key) {
    return { ok: true, pid: state.pid, reused: true };
  }
  stopNaparnik();
  state.config = key;
  state.error = "";
  state.logTail = [];

  const child = spawn(command, Array.isArray(args) ? args : [], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  state.child = child;
  state.pid = child.pid ?? 0;
  state.startedAt = Date.now();
  child.stdout?.on("data", readLines);
  child.stderr?.on("data", pushLog);
  child.on("error", (error) => {
    state.error = error?.message || String(error);
  });
  child.on("exit", (code) => {
    if (state.child !== child) return;
    state.child = null;
    state.pid = 0;
    if (code !== 0 && code !== null) state.error = "процесс завершился с кодом " + code;
    failAllPending(new Error(state.error || "процесс Напарника завершился"));
  });

  try {
    await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "dsh-1c-project-properties", version: "0.14.0" },
      },
      INIT_TIMEOUT_MS,
    );
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return { ok: true, pid: state.pid };
  } catch (error) {
    const detail = state.logTail.slice(-3).join(" | ");
    stopNaparnik();
    state.error = (error?.message || String(error)) + (detail ? ": " + detail : "");
    return { ok: false, error: state.error };
  }
}

/** Остановить процесс: токен сменился, сервер снимают с учёта или плагин закрывают. */
export function stopNaparnik() {
  const child = state.child;
  state.child = null;
  state.pid = 0;
  state.config = "";
  failAllPending(new Error("Напарник остановлен"));
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // процесс мог уйти сам
  }
}

/**
 * Развернуть вставки поиска ИТС в читаемый текст.
 *
 * На вопрос, где движок ходит в поиск ИТС, ответ приходит со вставленными
 * результатами как сырым JSON: {"durationMs":2178,"content":"Найдено 6 результатов: ... #std755 ..."}.
 * Агенту нужен текст стандарта, а не экранированный JSON на десять тысяч знаков,
 * поэтому каждый такой блок заменяется своим полем content.
 */
function itsSourceLine(block) {
  const title = /Расположение документа '([^']+)'/.exec(block)?.[1] || "";
  const id = /\*\*id:([^*]+)\*\*/.exec(block)?.[1] || "";
  // Общие контейнеры ИТС («Базы данных ИТС», «Самые полезные руководства»,
  // «Другие методические материалы») одинаковы в каждом ответе и ничего не
  // различают: в подписи оставляем последние два уровня пути.
  const generic = /^(Базы данных ИТС|Самые полезные руководства|Другие методические материалы)/i;
  const path = [];
  for (const line of block.split("\n")) {
    // Уровни дерева ИТС идут строками «└── Название/ (id:...)»; корень и общий
    // контейнер «Базы данных ИТС» в подпись не берём — они одинаковы везде.
    const node = /^\s*└──\s*(.+?)\/\s*\(id:([^)]+)\)/.exec(line);
    if (!node || node[2] === "root") continue;
    const name = node[1].trim();
    if (generic.test(name)) continue;
    if (path[path.length - 1] === name) continue;
    path.push(name);
  }
  const parts = [path.slice(-2).join(" / "), title, id].filter(Boolean);
  return parts.length ? "Источник: " + parts.join(" · ") : "";
}

/**
 * Свернуть служебные блоки поиска ИТС в одну строку источника.
 *
 * Перед текстом каждого найденного документа сервис отдаёт путь в дереве базы
 * ИТС («Расположение документа») и оглавление документа («Структура всего
 * документа»), разделённые «========». В ответе про блокирующие вызовы это
 * половина знаков — 6 292 из 12 644. Для агента ценно только происхождение:
 * раздел, документ и id; оглавление и рисунок дерева ему не нужны.
 */
function compactItsSources(text) {
  let out = text;
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const start = out.indexOf("Расположение документа '");
    if (start < 0) break;
    const first = out.indexOf("========", start);
    const second = first < 0 ? -1 : out.indexOf("========", first + 8);
    if (second < 0) break;
    const end = second + 8;
    const block = out.slice(start, end);
    if (!block.includes("Структура всего документа")) break;
    out = out.slice(0, start) + itsSourceLine(block) + out.slice(end);
  }
  return out;
}

export function flattenItsAnswer(text) {
  const source = String(text || "");
  // Вставки поиска есть не в каждом ответе, но служебные блоки ИТС — в каждом
  // ответе с цитатой, поэтому свёртка источников работает и без JSON.
  const hasBlobs = source.includes('"content"');
  let out = hasBlobs ? "" : source;
  let index = 0;
  while (hasBlobs && index < source.length) {
    const start = source.indexOf("{", index);
    if (start < 0) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, start);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) {
      out += source.slice(start);
      break;
    }
    const chunk = source.slice(start, end + 1);
    let parsed = null;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
      out += parsed.content;
    } else {
      out += chunk;
    }
    index = end + 1;
  }
  const compact = compactItsSources(out);
  return compact.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** Вызвать инструмент и вернуть его текстовый ответ. */
export async function callNaparnik(tool, args, timeoutMs = CALL_TIMEOUT_MS) {
  if (!state.child || state.child.exitCode !== null) {
    throw new Error("Напарник не запущен: нет движка bsl-analyzer или токена в настройках");
  }
  const result = await request("tools/call", { name: tool, arguments: args }, timeoutMs);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (result?.isError === true) throw new Error(flattenItsAnswer(text) || "Напарник вернул ошибку без текста");
  return flattenItsAnswer(text);
}

/** Снимок для статуса и карточки настроек. */
export function naparnikRuntime() {
  return {
    running: Boolean(state.child && state.child.exitCode === null),
    pid: state.pid,
    startedAt: state.startedAt,
    error: state.error,
    logTail: state.logTail.slice(-5),
  };
}
