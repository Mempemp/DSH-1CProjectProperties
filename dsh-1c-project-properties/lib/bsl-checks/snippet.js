// Проверка кода, которого ещё нет в файле.
//
// Агент пишет код и хочет знать, что он не принесёт новых замечаний, до записи
// в файл. Командная строка так не умеет, зато умеет MCP-сервер анализатора:
// `diagnostics action=snippet` проверяет текст в контексте указанного модуля и
// на диск ничего не пишет.
//
// Сервер держим один на проект: первый вызов строит резидентную базу (это
// секунды), дальше ответы идут миллисекунды. После пяти минут без работы
// процесс гасится сам, как и у остальных сервисов плагина.
import { spawn } from "node:child_process";
import { dropSymbolDependent, metadataState } from "./metadata.js";

const PROTOCOL_VERSION = "2025-06-18";
// Анализатор по умолчанию отдаёт только error и warning: всё, что ниже, живёт
// в counts и не попадает в findings. Уровень отбора задаёт профиль правил, а не
// анализатор, поэтому просим самый низкий порог и режем по `off` сами.
const MIN_SEVERITY = "hint";
const IDLE_MS = 5 * 60 * 1000;

class McpSession {
  constructor(binary, sourceDir) {
    this.binary = binary;
    this.sourceDir = sourceDir;
    this.child = null;
    this.ready = false;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.stderr = "";
    this.idleTimer = null;
  }

  async start() {
    if (this.child && this.ready) return;
    const child = spawn(
      this.binary,
      ["mcp", "serve", "--profile", "workspace", "-s", this.sourceDir, "--mode", "stdio"],
      { windowsHide: true }
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.on("exit", () => {
      this.child = null;
      this.ready = false;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("MCP-сервер завершился"));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dsh-1c-bsl-checks", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.ready = true;
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id == null) continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "ошибка MCP"));
      else entry.resolve(message.result);
    }
  }

  notify(method, params) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(method, params, timeoutMs = 60000) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("MCP-сервер не запущен"));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP не ответил за " + timeoutMs + " мс"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async tool(name, args, timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    return result?.structuredContent ?? parseJson(result?.content?.[0]?.text);
  }

  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {}
  }
}

// Анализатор зовёт уровень `information` в потоке находок и `info` в каталоге —
// это одно и то же слово, а не другая шкала: приводим только регистр.
function severityKey(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "information" ? "info" : text;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sessions = new Map();

function sessionFor(binary, sourceDir) {
  const key = binary + "|" + sourceDir;
  let session = sessions.get(key);
  if (!session) {
    session = new McpSession(binary, sourceDir);
    sessions.set(key, session);
  }
  return session;
}

/** Погасить все живые сессии: выключение проверок и выход из приложения. */
export function closeAllSnippetSessions() {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

async function waitReady(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await session.tool("diagnostics", { action: "status" }, 15000);
    const state = status?.state || status?.status;
    if (state === "ready") return { ok: true };
    if (state === "failed") return { ok: false, error: status?.detail || "резидентная база не собралась" };
    if (Date.now() > deadline) return { ok: false, error: "резидентная база не собралась за отведённое время" };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
}

/**
 * Проверить файлы резидентным сервером: после первого прогрева это десятки
 * миллисекунд вместо секунды на перезапуск командной строки.
 *
 * @param {{ binary: string, sourceDir: string, files: string[], off?: string[], timeoutMs?: number }} options
 */
export async function checkFilesResident(options) {
  const timeoutMs = options.timeoutMs || 90000;
  const session = sessionFor(options.binary, options.sourceDir);
  const started = Date.now();
  try {
    await session.start();
    const ready = await waitReady(session, Math.max(1000, timeoutMs - (Date.now() - started)));
    if (!ready.ok) return { ok: false, error: ready.error, stderr: session.stderr };

    const off = new Set(options.off || []);
    const metadata = metadataState({ dumpRoot: options.sourceDir, stderr: "" });
    const files = [];
    for (const file of options.files) {
      const payload = await session.tool(
        "diagnostics",
        { action: "file", path: file, min_severity: MIN_SEVERITY },
        timeoutMs,
      );
      const body = payload?.result || payload || {};
      if (body.error) return { ok: false, error: body.detail || body.error };
      const rawAll = Array.isArray(body.findings) ? body.findings : [];
      const raw = metadata.symbolsAvailable ? rawAll : dropSymbolDependent(rawAll).findings;
      const findings = raw
        .filter((item) => !off.has(item.code))
        .map((item) => ({
          code: item.code,
          message: item.message,
          severity: severityKey(item.severity),
          line: Number(item.range?.start_line ?? item.start_line ?? 0) + 1,
          column: Number(item.range?.start_column ?? item.start_column ?? 0) + 1,
        }));
      files.push({ path: file, findings, hidden: raw.length - findings.length });
    }
    session.touch();
    return { ok: true, files, metadata, elapsedMs: Date.now() - started };
  } catch (error) {
    session.close();
    return { ok: false, error: error?.message || String(error), stderr: session.stderr };
  }
}

/**
 * Проверить фрагмент BSL-кода в контексте модуля.
 *
 * @param {{ binary: string, sourceDir: string, code: string, path?: string, off?: string[], timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, findings?: object[], state?: string, error?: string }>}
 */
export async function checkSnippet(options) {
  const timeoutMs = options.timeoutMs || 90000;
  const session = sessionFor(options.binary, options.sourceDir);
  const started = Date.now();
  try {
    await session.start();
    const ready = await waitReady(session, Math.max(1000, timeoutMs - (Date.now() - started)));
    if (!ready.ok) return { ok: false, error: ready.error, stderr: session.stderr };

    const args = { action: "snippet", code: options.code, min_severity: MIN_SEVERITY };
    if (options.path) args.path = options.path;
    const payload = await session.tool("diagnostics", args, timeoutMs);
    session.touch();

    const body = payload?.result || payload || {};
    if (body.error) return { ok: false, error: body.detail || body.error };

    const off = new Set(options.off || []);
    const metadata = metadataState({ dumpRoot: options.sourceDir, stderr: "" });
    const rawAll = Array.isArray(body.findings) ? body.findings : [];
    const raw = metadata.symbolsAvailable ? rawAll : dropSymbolDependent(rawAll).findings;
    const findings = raw
      .filter((item) => !off.has(item.code))
      .map((item) => ({
        code: item.code,
        message: item.message,
        severity: severityKey(item.severity),
        line: Number(item.range?.start_line ?? item.start_line ?? 0) + 1,
        column: Number(item.range?.start_column ?? item.start_column ?? 0) + 1,
      }));

    return {
      ok: true,
      state: payload?.state || "ready",
      hidden: rawAll.length - findings.length,
      metadata,
      findings,
    };
  } catch (error) {
    session.close();
    return { ok: false, error: error?.message || String(error), stderr: session.stderr };
  }
}
