// Платформенный контекст 1С — супервизор внешнего MCP-сервера.
//
// Справку по API платформы отдаёт сторонний бинарник bsl-context-rs
// (vendor/bsl-context-rs, MIT): он читает синтакс-помощник выбранной версии
// платформы (shcntx_ru.hbk) и поднимает MCP по streamable-http на loopback.
// Плагин владеет жизненным циклом этого процесса: кладёт конфиг в
// $DSH_HOME/1c-platform-context, запускает его с путём к платформе из общих
// настроек, ждёт готовности индекса, отдаёт статус в UI и по /1cprops/*,
// а маршрут к серверу отдаёт MCP-менеджеру (ctx.mcpManager.registerServer).
//
// Путь к платформе здесь тот же, что у выгрузки: значение из общих настроек.
// Пока оно пустое, сервер всё равно поднимается — инструменты отвечают отказом
// с подсказкой, и это ожидаемое состояние первой установки, а не ошибка.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Имя сервера в MCP-менеджере; инструменты агента видны как mcp__<имя>__<tool>. */
export const PLATFORM_CONTEXT_SERVER = "1c-platform-context";

/** Порт по умолчанию — тот же, что в примере конфига bsl-context-rs. */
const PREFERRED_PORT = 8007;

/** Сколько ждём готовности индекса платформы (у нас на прогоне — секунды). */
const HEALTH_TIMEOUT_MS = 120_000;

/** Хвост stdout/stderr бинарника, который показываем в статусе. */
const LOG_TAIL_LINES = 40;

const VENDOR_EXE = fileURLToPath(
  new URL("../vendor/bsl-context-rs/bsl-context-rs.exe", import.meta.url)
);

const state = {
  child: null,
  pid: 0,
  port: 0,
  url: "",
  platformPath: "",
  configFile: "",
  startedAt: 0,
  health: null,
  error: "",
  logTail: [],
};

/** Путь к распространяемому бинарнику — для статуса и диагностики. */
export function platformContextExe() {
  return VENDOR_EXE;
}

function pushLog(chunk) {
  const text = String(chunk || "");
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    state.logTail.push(line.trim());
  }
  if (state.logTail.length > LOG_TAIL_LINES) {
    state.logTail.splice(0, state.logTail.length - LOG_TAIL_LINES);
  }
}

/** Каталог платформы, который понимает bsl-context-rs: сам каталог версии или его bin. */
export function platformDirFrom(raw) {
  const value = String(raw || "").trim();
  if (!value) return { error: "путь к платформе 1С не задан" };

  // Принимаем и файл (…\bin\1cv8.exe), и каталог версии, и каталог bin:
  // bsl-context-rs ищет shcntx_ru.hbk и в <path>, и в <path>/bin.
  let isDir = false;
  try {
    isDir = statSync(value).isDirectory();
  } catch {
    return { error: "путь к платформе не найден: " + value };
  }
  const candidates = isDir ? [value, join(value, "bin")] : [dirname(value)];
  for (const dir of candidates) {
    if (existsSync(join(dir, "shcntx_ru.hbk"))) return { dir };
  }
  return { error: "рядом нет shcntx_ru.hbk: " + candidates.join(" / ") };
}

/** Свободен ли порт на loopback; иначе берём любой свободный (0 → эфемерный). */
function pickPort(preferred) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => {
      const fallback = createServer();
      fallback.unref();
      fallback.once("error", () => resolve(0));
      fallback.listen(0, "127.0.0.1", () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, "127.0.0.1", () => {
      probe.close(() => resolve(preferred));
    });
  });
}

function writeConfig({ dir, platformPath, port }) {
  const lines = [
    "# Конфиг bsl-context-rs, который пишет dsh-1c-project-properties.",
    "# Файл перезаписывается при каждом запуске — правьте настройки плагина,",
    "# а не этот файл.",
    'host = "127.0.0.1"',
    `port = ${port}`,
  ];
  if (platformPath) {
    // TOML-строка в одинарных кавычках: слэши Windows не экранируются.
    lines.push(`platform_path = '${platformPath.replace(/'/g, "''")}'`);
  }
  lines.push(`log_dir = '${join(dir, "logs").replace(/'/g, "''")}'`);
  lines.push('log_level = "info"');
  lines.push("default_validation_level = 1");
  return lines.join("\n") + "\n";
}

async function readHealth(port, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Ждём, пока сервер ответит на /health (и, если путь задан, соберёт индекс). */
async function waitForHealth(port, needsIndex, deadline) {
  let last = null;
  while (Date.now() < deadline) {
    if (state.child && state.child.exitCode !== null) return { health: last, exited: true };
    const health = await readHealth(port);
    if (health) {
      last = health;
      if (!needsIndex || health.index_loaded === true) return { health, exited: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { health: last, exited: false, timeout: true };
}

function killChild() {
  const child = state.child;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // процесс мог уйти сам — цель достигнута
  }
}

/** Остановить сервер и забыть о нём. */
export function stopPlatformContext() {
  killChild();
  state.child = null;
  state.pid = 0;
  state.port = 0;
  state.url = "";
  state.health = null;
  state.startedAt = 0;
}

/**
 * Запустить сервер с указанным путём к платформе (пустой путь допустим).
 * Повторный вызов без изменений — no-op; путь изменился — перезапуск.
 */
export async function startPlatformContext({ dataDir, platformPath, port }) {
  const wanted = String(platformPath || "").trim();
  if (state.child && state.child.exitCode === null && state.platformPath === wanted) {
    return { ok: true, reused: true, ...platformContextStatus() };
  }
  if (state.child) stopPlatformContext();

  state.platformPath = wanted;
  state.error = "";

  if (!existsSync(VENDOR_EXE)) {
    state.error = "не найден бинарник платформенного контекста: " + VENDOR_EXE;
    return { ok: false, ...platformContextStatus() };
  }

  mkdirSync(dataDir, { recursive: true });
  const configFile = join(dataDir, "config.toml");
  const chosen = await pickPort(Number(port) > 0 ? Number(port) : PREFERRED_PORT);
  writeFileSync(configFile, writeConfig({ dir: dataDir, platformPath: wanted, port: chosen }), "utf8");
  state.configFile = configFile;

  const child = spawn(VENDOR_EXE, ["--config", configFile], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  state.pid = child.pid ?? 0;
  state.port = chosen;
  state.url = `http://127.0.0.1:${chosen}/mcp`;
  state.startedAt = Date.now();
  state.logTail = [];
  child.stdout?.on("data", pushLog);
  child.stderr?.on("data", pushLog);
  child.on("error", (error) => {
    state.error = error?.message || String(error);
  });
  child.on("exit", (code) => {
    if (state.child === child) {
      state.child = null;
      state.port = 0;
      state.url = "";
      if (code !== 0 && code !== null) state.error = `сервер завершился с кодом ${code}`;
    }
  });

  const { health, timeout, exited } = await waitForHealth(
    chosen,
    wanted !== "",
    Date.now() + HEALTH_TIMEOUT_MS
  );
  state.health = health;
  if (exited) state.error = state.error || "сервер завершился сразу после запуска";
  else if (!health) state.error = "сервер не ответил на /health";
  else if (timeout) state.error = "индекс платформы не собрался за отведённое время";

  return { ok: Boolean(health), ...platformContextStatus() };
}

/** Снимок состояния для роутов, UI и регистрации в MCP-менеджере. */
export function platformContextStatus() {
  const running = Boolean(state.child && state.child.exitCode === null);
  const health = state.health || null;
  return {
    server: PLATFORM_CONTEXT_SERVER,
    running,
    pid: state.pid,
    port: state.port,
    url: state.url,
    platformPath: state.platformPath,
    configFile: state.configFile,
    exe: VENDOR_EXE,
    startedAt: state.startedAt,
    version: health?.version || "",
    indexLoaded: health?.index_loaded === true,
    indexStats: health?.index_stats || null,
    error: state.error,
    logTail: state.logTail.slice(-LOG_TAIL_LINES),
  };
}

/** Перезапуск с новым путём (например, после смены общих настроек). */
export async function restartPlatformContext({ dataDir, platformPath, port }) {
  stopPlatformContext();
  return startPlatformContext({ dataDir, platformPath, port });
}
