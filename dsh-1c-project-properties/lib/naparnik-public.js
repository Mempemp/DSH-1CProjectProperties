// Публичный API 1С:Напарника (code.1c.ai/public/v1).
//
// Два дела, которых нет у профиля reference движка проверок: остаток квоты
// ключа и второе мнение по коду. Сюда же уходит ошибка 402 budget_exceeded —
// по ней видно, почему инструмент перестал отвечать.
//
// Ключ тот же, что у its_help: раздел «Ключи доступа» на code.1c.ai. Проверено:
// /public/v1/budget отвечает 200 на этот токен и с Bearer, и без префикса.
const DEFAULT_BASE = "https://code.1c.ai/public/v1";
const HTTP_TIMEOUT_MS = Number(process.env.ONEC_AI_TIMEOUT_MS || 240_000);
const BUDGET_TIMEOUT_MS = 25_000;

// Потолок входа: длинные запросы Напарник чаще обрывает пустым ответом, поэтому
// модуль дробится до отправки, а не после трёх пустых попыток.
const MAX_CODE_CHARS = 60_000;
const REVIEW_ATTEMPTS = 2;
const RETRY_HINT =
  "\n\nНе вызывай инструменты: ответь обычным текстом. Если код большой — дай только главные находки.";
const STUB_CHARS = 300;
const FINDINGS_MARK = /\[(критично|важно|мелко)\]|находк|дефектов\s+не\s+наш[её]л/i;

function baseUrl() {
  return String(process.env.ONEC_AI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

async function request(path, { token, method = "GET", body, timeoutMs = 60_000, accept = "application/json" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(baseUrl() + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        accept,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Отказ сервиса в терминах, по которым видно, что делать. */
function httpError(status, type, message) {
  if (status === 401) {
    return {
      code: "naparnik_key_rejected",
      error: "1С:Напарник не принял ключ: " + (message || "401"),
      hint: "Ключ неверный или просрочен. Возьмите новый в разделе «Ключи доступа» на code.1c.ai и вставьте в настройках плагина: «1С: Анализ кода» → «1С:Напарник».",
    };
  }
  if (status === 402 && type === "budget_exceeded") {
    return {
      code: "naparnik_budget_exceeded",
      error: "Бюджет 1С:Напарника исчерпан: " + (message || "402"),
      hint: "Израсходовано окно 5 часов или недельный лимит. Остаток — строкой «Бюджет» в настройках плагина; до сброса окна второе мнение недоступно.",
    };
  }
  if (status === 402 && type === "no_active_tariff") {
    return {
      code: "naparnik_no_tariff",
      error: "У ключа нет активного тарифа: " + (message || "402"),
      hint: "Оформите доступ к 1С:Напарнику на code.1c.ai — без тарифа ключ отвечает отказом.",
    };
  }
  if (status === 429) {
    return {
      code: "naparnik_rate_limited",
      error: "Технический лимит запросов: " + (message || "429"),
      hint: "Повторите позже; частые вызовы подряд сервис не принимает.",
    };
  }
  return {
    code: "naparnik_http_error",
    error: "1С:Напарник ответил HTTP " + status + (type ? " " + type : "") + ": " + String(message || "").slice(0, 300),
    hint: "Повторите вызов; если повторяется — проверьте состояние сервиса.",
  };
}

async function readError(response) {
  const raw = await response.text().catch(() => "");
  let type = "";
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    type = parsed.error_type || "";
    message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error ?? raw);
  } catch {
    // тело не JSON — остаётся как есть
  }
  return httpError(response.status, type, message);
}

/** Остаток квоты ключа: окно 5 часов и неделя. */
export async function fetchBudget(token) {
  if (!token) {
    return { ok: false, code: "naparnik_token_missing", error: "токен не задан", hint: "Вставьте ключ в настройках плагина." };
  }
  let response;
  try {
    response = await request("/budget", { token, timeoutMs: BUDGET_TIMEOUT_MS });
  } catch (error) {
    return {
      ok: false,
      code: "naparnik_unreachable",
      error: "сервис не ответил: " + (error?.message || String(error)),
      hint: "Проверьте сеть; остальные инструменты сборки работают без Напарника.",
    };
  }
  if (!response.ok) return { ok: false, ...(await readError(response)) };
  const payload = await response.json().catch(() => null);
  const window = (value) =>
    value && typeof value === "object"
      ? { percent: Number(value.used_percent) || 0, resetsAt: value.resets_at || "" }
      : null;
  return {
    ok: true,
    sliding5h: window(payload?.limits?.sliding_5h),
    weekly: window(payload?.limits?.weekly),
    checkedAt: new Date().toISOString(),
  };
}

/** Ответ — обрубок: пустой, короткий и без разметки находок. */
export function looksStub(text) {
  const value = String(text || "").trim();
  if (value.length < STUB_CHARS) return !FINDINGS_MARK.test(value);
  return false;
}

async function newConversation(token) {
  const response = await request("/conversations", {
    token,
    method: "POST",
    body: { ui_language: "ru", programming_language: "1c", script_language: "ru" },
    timeoutMs: 30_000,
  });
  if (!response.ok) return { error: await readError(response) };
  const payload = await response.json().catch(() => null);
  if (!payload?.uuid) {
    return { error: { code: "naparnik_no_conversation", error: "сервис не вернул uuid беседы", hint: "Повторите вызов." } };
  }
  return { uuid: payload.uuid };
}

function dropConversation(token, uuid) {
  request(`/conversations/${encodeURIComponent(uuid)}`, { token, method: "DELETE", timeoutMs: 15_000 }).catch(() => {});
}

/** Отправить вопрос и собрать текст ответа из SSE. */
async function streamReply(token, uuid, prompt, timeoutMs) {
  const response = await request(`/conversations/${encodeURIComponent(uuid)}/messages`, {
    token,
    method: "POST",
    body: { parent_uuid: null, role: "user", content: prompt },
    timeoutMs,
    accept: "text/event-stream",
  });
  if (!response.ok) return { error: await readError(response) };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deltas = [];
  const finals = [];
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        done = true;
        break;
      }
      let packet = null;
      try {
        packet = JSON.parse(payload);
      } catch {
        continue;
      }
      if (packet.error) {
        return {
          error: {
            code: "naparnik_stream_error",
            error: "1С:Напарник: " + (packet.error_type || "stream_error") + ": " + String(packet.error).slice(0, 300),
            hint: "Повторите вызов или разбейте задачу на части.",
          },
        };
      }
      if (packet.role === "user") continue;
      if (packet.content_delta?.content) deltas.push(packet.content_delta.content);
      // Финальный content приоритетнее накопленных дельт: сервер мог отфильтровать текст.
      if (packet.finished && typeof packet.content?.content === "string" && packet.content.content.trim()) {
        finals.push(packet.content.content);
      }
    }
  }
  return { text: (finals.length ? finals.join("\n\n") : deltas.join("")).trim() };
}

function reviewPrompt({ code, context, focus }) {
  const parts = [
    "Ты — второй ревьюер: опытный 1С-разработчик, проверяешь код коллеги и ищешь дефекты.",
    "Ищи реальные дефекты, риски и регрессии. Не переписывай код, не хвали, не выдумывай придирки ради объёма.",
    "",
    "Формат ответа строго:",
    "1. Находки по убыванию критичности. Каждая: [критично|важно|мелко] — что не так; где (метод, строка или фрагмент); к чему приведёт; как чинить в двух словах.",
    "2. Открытые вопросы и допущения — только если без них вердикт невозможен.",
    "3. Если дефектов нет — одна строка «дефектов не нашёл».",
  ];
  if (context) parts.push("", "Контекст задачи:", context);
  if (focus) parts.push("", "На что смотреть в первую очередь:", focus);
  parts.push("", "Код:", "```", code, "```");
  return parts.join("\n");
}

/**
 * Второе мнение по коду: отдельная беседа на попытку, удаляется после ответа.
 * Пустой или обрубленный ответ — не повод отдавать его как вердикт: одна
 * повторная попытка с подсказкой «ответь текстом», и только потом отказ.
 */
export async function reviewCode({ token, code, context, focus, timeoutMs = HTTP_TIMEOUT_MS }) {
  const source = String(code || "");
  if (!source.trim()) {
    return { ok: false, code: "review_no_code", error: "не передан код", hint: "Передайте code: модуль, функцию или дифф целиком." };
  }
  if (source.length > MAX_CODE_CHARS) {
    return {
      ok: false,
      code: "review_too_big",
      error: "код слишком большой: " + source.length + " знаков, потолок " + MAX_CODE_CHARS,
      hint: "Разделите модуль на методы или передайте только изменённый фрагмент — длинный вход Напарник чаще обрывает пустым ответом.",
    };
  }
  if (!token) {
    return {
      ok: false,
      code: "naparnik_token_missing",
      error: "токен не задан",
      hint: "Вставьте ключ в настройках плагина: «1С: Анализ кода» → «1С:Напарник».",
    };
  }

  const startedAt = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt += 1) {
    const conversation = await newConversation(token);
    if (conversation.error) return { ok: false, attempts: attempt, ...conversation.error };
    try {
      const prompt = attempt === 1 ? reviewPrompt({ code: source, context, focus }) : reviewPrompt({ code: source, context, focus }) + RETRY_HINT;
      const reply = await streamReply(token, conversation.uuid, prompt, timeoutMs);
      if (reply.error) return { ok: false, attempts: attempt, ...reply.error };
      const text = String(reply.text || "");
      if (text && !looksStub(text)) {
        return { ok: true, review: text, attempts: attempt, elapsedMs: Date.now() - startedAt };
      }
      last = text
        ? "Напарник оборвал ответ на " + text.length + " знаках: «" + text.slice(0, 120) + "»"
        : "Напарник вернул пустой текст (модель ушла в инструменты и не ответила)";
    } finally {
      dropConversation(token, conversation.uuid);
    }
  }
  return {
    ok: false,
    code: "review_empty_reply",
    error: last || "Напарник не дал ответа",
    hint: "Попыток: " + REVIEW_ATTEMPTS + ". Разбейте код на части или повторите позже: пустой ответ — стохастика сервиса, а не свойство кода.",
    attempts: REVIEW_ATTEMPTS,
    elapsedMs: Date.now() - startedAt,
  };
}

export { MAX_CODE_CHARS };
