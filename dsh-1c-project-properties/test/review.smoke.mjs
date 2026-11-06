// Проверка публичного API 1С:Напарника: квота ключа, второе мнение по коду и
// инструмент bsl_review в нашем MCP-сервере.
//
// Запуск: node test/review.smoke.mjs
//
// Сеть не нужна: на loopback поднимается поддельный Public API (SSE, беседы,
// бюджет), а адрес подставляется через ONEC_AI_BASE_URL — тот же шов, что у
// dsh-workmate, поэтому проверяется наш клиент, а не чужой сервис.
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

const state = { budgetMode: "ok", replyModes: [], prompts: [], deletes: [], conversations: 0 };

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const frame of frames) res.write("data: " + JSON.stringify(frame) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

const api = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";

  if (url.pathname.endsWith("/budget")) {
    if (state.budgetMode === "no-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_type: "invalid_token", error: "bad key" }));
      return;
    }
    if (state.budgetMode === "no-budget") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_type: "budget_exceeded", error: "weekly limit" }));
      return;
    }
    if (state.budgetMode === "no-tariff") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error_type: "no_active_tariff", error: "no tariff" }));
      return;
    }
    if (state.budgetMode === "rate") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ limits: { sliding_5h: { used_percent: 4.5, resets_at: null }, weekly: { used_percent: 12, resets_at: "2026-11-06T07:14:32+00:00" } } }));
    return;
  }

  if (url.pathname.endsWith("/conversations") && req.method === "POST") {
    state.conversations += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ uuid: "conv-" + state.conversations }));
    return;
  }

  if (req.method === "DELETE") {
    state.deletes.push(url.pathname);
    res.writeHead(204).end();
    return;
  }

  if (url.pathname.endsWith("/messages")) {
    state.prompts.push(body);
    const mode = state.replyModes.shift() || "ok";
    if (mode === "stream-error") {
      sse(res, [{ error_type: "model_error", error: "сломалось" }]);
      return;
    }
    if (mode === "empty") {
      sse(res, [{ role: "assistant", finished: true, content: { content: "" } }]);
      return;
    }
    if (mode === "stub") {
      sse(res, [{ role: "assistant", finished: true, content: { content: "Проверю пару моментов по документации." } }]);
      return;
    }
    if (mode === "deltas") {
      sse(res, [
        { role: "assistant", content_delta: { content: "[важно] — запрос в цикле" } },
        { role: "assistant", finished: true, content: { content: "[важно] — запрос в цикле, метод ПровестиДокумент; будет N запросов; вынести за цикл." } },
      ]);
      return;
    }
    sse(res, [
      { role: "user", content: "эхо" },
      {
        role: "assistant",
        finished: true,
        content: { content: "[критично] — нет блокировки; метод Записать; риск двойной записи; обернуть в БлокировкаДанных.\n[мелко] — имя переменной." },
      },
    ]);
    return;
  }

  res.writeHead(404).end();
});

await new Promise((done) => api.listen(0, "127.0.0.1", done));
const { port } = api.address();
process.env.ONEC_AI_BASE_URL = "http://127.0.0.1:" + port + "/public/v1";

const { fetchBudget, looksStub, MAX_CODE_CHARS, reviewCode } = await import(
  pathToFileURL(resolve(here, "..", "lib", "naparnik-public.js")).href
);

console.log("квота ключа");
state.budgetMode = "ok";
const budget = await fetchBudget("key");
check("проценты окна", budget.ok === true && budget.sliding5h.percent === 4.5, JSON.stringify(budget));
check("неделя и сброс", budget.weekly.percent === 12 && budget.weekly.resetsAt.startsWith("2026-11-06"), JSON.stringify(budget.weekly));
state.budgetMode = "no-key";
const noKey = await fetchBudget("key");
check("401 — ключ не принят", noKey.ok === false && noKey.code === "naparnik_key_rejected", JSON.stringify(noKey));
check("401 объясняет, что делать", String(noKey.hint).includes("Ключи доступа"));
state.budgetMode = "no-budget";
const noBudget = await fetchBudget("key");
check("402 — бюджет исчерпан", noBudget.code === "naparnik_budget_exceeded", JSON.stringify(noBudget));
state.budgetMode = "no-tariff";
check("402 без тарифа отдельным кодом", (await fetchBudget("key")).code === "naparnik_no_tariff");
state.budgetMode = "rate";
check("429 — технический лимит", (await fetchBudget("key")).code === "naparnik_rate_limited");
check("без токена не идём в сеть", (await fetchBudget("")).code === "naparnik_token_missing");

console.log("распознавание обрубка");
check("короткий ответ с находкой — не обрубок", looksStub("[мелко] — имя") === false);
check("короткая проза — обрубок", looksStub("Проверю пару моментов.") === true);
check("«дефектов не нашёл» — ответ", looksStub("дефектов не нашёл") === false);
check("длинный текст — ответ", looksStub("а".repeat(400)) === false);

console.log("второе мнение");
state.replyModes = ["ok"];
const good = await reviewCode({ token: "key", code: "Процедура Тест()\nКонецПроцедуры", context: "проведение", focus: "транзакции" });
check("ответ получен", good.ok === true && good.review.includes("критично"), JSON.stringify(good).slice(0, 300));
check("попытка одна", good.attempts === 1);
check("время посчитано", good.elapsedMs >= 0);
check("промпт содержит контекст и фокус", state.prompts.at(-1).includes("проведение") && state.prompts.at(-1).includes("транзакции"));
// Удаление беседы уходит без ожидания: даём ему доехать.
await new Promise((done) => setTimeout(done, 250));
check("беседа удалена", state.deletes.length >= 1, JSON.stringify(state.deletes));

state.replyModes = ["empty", "ok"];
const retried = await reviewCode({ token: "key", code: "Процедура Тест()\nКонецПроцедуры" });
check("пустой ответ повторяется", retried.ok === true && retried.attempts === 2, JSON.stringify(retried).slice(0, 200));
check("на повторе просим отвечать текстом", state.prompts.at(-1).includes("Не вызывай инструменты"));

state.replyModes = ["stub", "empty"];
const dead = await reviewCode({ token: "key", code: "Процедура Тест()\nКонецПроцедуры" });
check("два обрубка — отказ", dead.ok === false && dead.code === "review_empty_reply", JSON.stringify(dead).slice(0, 300));
check("отказ называет попытки", dead.attempts === 2 && String(dead.hint).includes("2"));

state.replyModes = ["stream-error"];
const broken = await reviewCode({ token: "key", code: "Процедура Тест()\nКонецПроцедуры" });
check("ошибка стрима не маскируется", broken.ok === false && broken.code === "naparnik_stream_error", JSON.stringify(broken).slice(0, 200));

state.replyModes = ["deltas"];
const fromDeltas = await reviewCode({ token: "key", code: "Процедура Тест()\nКонецПроцедуры" });
check("финальный текст приоритетнее дельт", fromDeltas.ok === true && fromDeltas.review.includes("вынести за цикл") && !fromDeltas.review.includes("^"), fromDeltas.review);

check("пустой код отклоняется", (await reviewCode({ token: "key", code: "   " })).code === "review_no_code");
const huge = await reviewCode({ token: "key", code: "а".repeat(MAX_CODE_CHARS + 1) });
check("длинный код отклоняется с потолком", huge.code === "review_too_big" && huge.error.includes(String(MAX_CODE_CHARS)), huge.error);
check("без токена отказ до сети", (await reviewCode({ code: "Процедура Тест()\nКонецПроцедуры" })).code === "naparnik_token_missing");

console.log("инструмент в MCP-сервере проверок");
const { startChecksMcpServer } = await import(pathToFileURL(resolve(here, "..", "lib", "bsl-checks", "mcp.js")).href);
let token = "key";
const server = await startChecksMcpServer({ projects: () => [], naparnikToken: () => token });

async function rpc(message) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return res.json();
}

const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const names = (list.result?.tools || []).map((tool) => tool.name);
check("bsl_review объявлен", names.includes("bsl_review"), names.join(", "));
const reviewTool = (list.result.tools || []).find((tool) => tool.name === "bsl_review");
check("схема требует code", JSON.stringify(reviewTool?.inputSchema?.required) === JSON.stringify(["code"]));
check("описание предупреждает про потолок", String(reviewTool?.description || "").includes(String(MAX_CODE_CHARS)));

state.replyModes = ["ok"];
const call = await rpc({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "bsl_review", arguments: { code: "Процедура Тест()\nКонецПроцедуры" } },
});
check("вызов отвечает текстом", call.result?.isError !== true && String(call.result?.content?.[0]?.text || "").includes("критично"), JSON.stringify(call).slice(0, 300));
check("structuredContent с попытками", call.result?.structuredContent?.attempts === 1);

token = "";
const denied = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "bsl_review", arguments: { code: "Процедура Тест()\nКонецПроцедуры" } },
});
check("без токена — машинный отказ", denied.result?.structuredContent?.code === "naparnik_token_missing", JSON.stringify(denied.result).slice(0, 300));
check("отказ помечен isError", denied.result?.isError === true);
check("отказ говорит, что делать", String(denied.result?.structuredContent?.hint || "").includes("настройках плагина"));

await server.close();
api.close();
if (failures) {
  console.log("\nпровалено проверок: " + failures);
  process.exit(1);
}
console.log("\nвсе проверки пройдены");
process.exit(0);
