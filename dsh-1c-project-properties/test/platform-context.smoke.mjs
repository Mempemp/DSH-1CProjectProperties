// Проверка супервизора платформенного контекста (vendor/bsl-context-rs).
//
// Запуск: node test/platform-context.smoke.mjs
//
// Тест поднимает настоящий бинарник из vendor/, ждёт /health и индекса
// платформы, дёргает MCP по streamable-http (initialize + tools/list) и
// проверяет, что процесс действительно гасится. Если на машине не установлена
// платформа 1С, тест проверяет только разбор путей и запуск без пути — это
// штатное состояние первой установки.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(resolve(here, "..", "lib", "platform-context.js")).href;
const {
  PLATFORM_CONTEXT_SERVER,
  platformContextStatus,
  platformDirFrom,
  restartPlatformContext,
  startPlatformContext,
  stopPlatformContext,
} = await import(moduleUrl);

const work = join(tmpdir(), "dsh-1c-platform-context-test-" + process.pid);

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

function findPlatform() {
  const roots = [
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ];
  const found = [];
  for (const root of roots) {
    const base = join(root, "1cv8");
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bin = join(base, entry.name, "bin");
      if (existsSync(join(bin, "1cv8.exe")) && existsSync(join(bin, "shcntx_ru.hbk"))) {
        found.push(bin);
      }
    }
  }
  return found.sort().pop() || "";
}

async function mcpTools(url) {
  const post = async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, text };
  };

  await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dsh-1c-project-properties-smoke", version: "0" },
    },
  });
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  try {
    const parsed = JSON.parse(listed.text);
    return (parsed?.result?.tools || []).map((tool) => tool.name);
  } catch {
    return [];
  }
}

const platform = findPlatform();
console.log("платформа: " + (platform || "не найдена — проверяем усечённый сценарий"));
console.log("разбор путей");
check("пустой путь — ошибка с подсказкой", platformDirFrom("").error.includes("не задан"));
check("несуществующий путь — ошибка", Boolean(platformDirFrom(join(work, "нет-такого")).error));
if (platform) {
  check("каталог bin принят", platformDirFrom(platform).dir === platform);
  check("каталог версии принят", platformDirFrom(dirname(platform)).dir === platform);
  check("файл 1cv8.exe принят", platformDirFrom(join(platform, "1cv8.exe")).dir === platform);
}

console.log("запуск без пути (первая установка)");
const bare = await startPlatformContext({ dataDir: join(work, "bare"), platformPath: "" });
check("сервер поднялся", bare.ok === true, bare.error);
check("через статус видно, что он жив", platformContextStatus().running === true);
check("индекс не собран — это ожидаемо", bare.indexLoaded === false);
check("статус называет сервер менеджеру", bare.server === PLATFORM_CONTEXT_SERVER);
check("конфиг записан", existsSync(bare.configFile), bare.configFile);
stopPlatformContext();
check("после остановки процесс снят", platformContextStatus().running === false);

if (platform) {
  console.log("запуск с платформой");
  const started = await startPlatformContext({
    dataDir: join(work, "with-platform"),
    platformPath: platform,
  });
  check("сервер поднялся", started.ok === true, started.error);
  check("индекс платформы собран", started.indexLoaded === true, started.error);
  check("в индексе есть типы", Number(started.indexStats?.types || 0) > 0, JSON.stringify(started.indexStats));
  check("версия сервера известна", Boolean(started.version), started.version);
  check("адрес MCP — streamable-http на loopback", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(started.url || ""), started.url);

  const tools = await mcpTools(started.url);
  check("MCP отдаёт инструменты", tools.length > 0, JSON.stringify(tools));
  check("есть search и get_members", tools.includes("search") && tools.includes("get_members"), JSON.stringify(tools));

  const again = await startPlatformContext({
    dataDir: join(work, "with-platform"),
    platformPath: platform,
  });
  check("повторный запуск переиспользует процесс", again.reused === true && again.pid === started.pid);

  const restarted = await restartPlatformContext({
    dataDir: join(work, "with-platform"),
    platformPath: platform,
  });
  check("перезапуск поднимает новый процесс", restarted.ok === true && restarted.pid !== started.pid, restarted.error);
  check("перезапуск видит индекс", restarted.indexLoaded === true, restarted.error);

  stopPlatformContext();
  await new Promise((done) => setTimeout(done, 800));
  let alive = false;
  try {
    const probe = await fetch(restarted.url, { signal: AbortSignal.timeout(2000) });
    alive = probe.status < 500;
  } catch {
    alive = false;
  }
  check("остановленный сервер больше не отвечает", alive === false);
}

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nвсе проверки пройдены" : "\nпровалено проверок: " + failures);
process.exit(failures === 0 ? 0 : 1);
