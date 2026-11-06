// Движок проверок: где взять бинарник анализатора и как его запустить.
//
// Версия закреплена. Байты сверяются по SHA-256: скачанный файл попадает в кеш
// только после проверки, а недокачанный не считается готовым. Кеш лежит вне
// проекта, поэтому обновление плагина его не трогает.
//
// Для win-x64 хеш закреплён. Для остальных платформ загрузка запрещена до тех
// пор, пока хеш не закреплён: молча качать непроверенное нельзя.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENGINE_VERSION = "0.4.3";

const ASSETS = {
  "win32-x64": {
    name: "bsl-analyzer-app-windows-amd64.exe",
    binary: "bsl-analyzer-app.exe",
    sha256: "de41a2d10fb69935041bbfcaddfb3a6d4e6ead544c110cdb3ed1fbb3f248fc06",
    size: 79462912,
  },
  "darwin-arm64": { name: "bsl-analyzer-app-darwin-arm64", binary: "bsl-analyzer-app", sha256: "", size: 0 },
  "linux-x64": { name: "bsl-analyzer-app-linux-amd64", binary: "bsl-analyzer-app", sha256: "", size: 0 },
};

function cacheRoot() {
  const env = process.env.DSH_BSL_CHECKER_DIR;
  if (env && env.trim()) return env.trim();
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".cache");
  return join(base, "dsh-1c", "bsl-analyzer", ENGINE_VERSION);
}

export function engineTarget() {
  return process.platform + "-" + process.arch;
}

export function assetFor(target = engineTarget()) {
  return ASSETS[target] || null;
}

/** Путь к проверенному бинарнику или пустая строка. */
export function resolveBinary() {
  const explicit = process.env.DSH_BSL_CHECKER_BIN;
  if (explicit && explicit.trim() && existsSync(explicit.trim())) return explicit.trim();
  const asset = assetFor();
  if (!asset) return "";
  const file = join(cacheRoot(), asset.binary);
  if (!existsSync(file)) return "";
  if (asset.sha256) {
    try {
      const size = statSync(file).size;
      if (asset.size && size !== asset.size) return "";
      if (sha256File(file) !== asset.sha256) return "";
    } catch {
      return "";
    }
  }
  return file;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function engineStatus() {
  const asset = assetFor();
  const bin = resolveBinary();
  return {
    version: ENGINE_VERSION,
    target: engineTarget(),
    supported: Boolean(asset),
    downloaded: Boolean(bin),
    binary: bin,
    cacheDir: cacheRoot(),
    canDownload: Boolean(asset && asset.sha256),
  };
}

/** Скачать и проверить движок. Возвращает путь к бинарнику. */
export async function ensureEngine({ onProgress } = {}) {
  const ready = resolveBinary();
  if (ready) return { ok: true, binary: ready, downloaded: false };
  // Тестовый шов: без него проверка «движка нет» уходила бы качать 76 МБ.
  if (process.env.DSH_BSL_CHECKER_NO_DOWNLOAD === "1") {
    return { ok: false, error: "движок проверок не установлен" };
  }
  const asset = assetFor();
  if (!asset) return { ok: false, error: "платформа не поддерживается: " + engineTarget() };
  if (!asset.sha256) return { ok: false, error: "хеш сборки для этой платформы не закреплён" };

  const dir = cacheRoot();
  mkdirSync(dir, { recursive: true });
  const url = "https://github.com/itrous/bsl-analyzer/releases/download/v" + ENGINE_VERSION + "/" + asset.name;
  const tmp = join(dir, asset.binary + ".part-" + process.pid);
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return { ok: false, error: "загрузка не удалась: HTTP " + response.status };
    const total = Number(response.headers.get("content-length") || 0);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
    }
    const buffer = Buffer.concat(chunks);
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== asset.sha256) {
      rmSync(tmp, { force: true });
      return { ok: false, error: "контрольная сумма не совпала" };
    }
    writeFileSync(tmp, buffer);
    if (process.platform !== "win32") chmodSync(tmp, 0o755);
    renameSync(tmp, join(dir, asset.binary));
    return { ok: true, binary: join(dir, asset.binary), downloaded: true };
  } catch (error) {
    rmSync(tmp, { force: true });
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Прогон анализатора.
 *
 * @param {{ binary: string, sourceDir: string, configFile: string, files?: string[], timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, findings: object[], elapsedSecs: number, stderr: string, error?: string }>}
 */
export function runAnalyze({ binary, sourceDir, configFile, files, timeoutMs = 180000 }) {
  const args = [
    "analyze",
    "-s",
    sourceDir,
    "-c",
    configFile,
    "--format",
    "jsonl",
    "--quiet",
  ];
  if (files && files.length) args.push("--incremental", "--changed-files", files.join(","));

  return new Promise((resolvePromise) => {
    const child = spawn(binary, args, { windowsHide: true });
    const findings = [];
    let elapsedSecs = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolvePromise({ ok: false, findings: [], elapsedSecs: 0, stderr, error: "проверка не уложилась в отведённое время" });
    }, timeoutMs);

    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      if (event.type === "file" && Array.isArray(event.diagnostics)) {
        // Путь живёт на событии файла, а находки — плоский массив внутри него.
        for (const item of event.diagnostics) findings.push({ ...item, path: event.path });
      } else if (event.type === "done") {
        elapsedSecs = Number(event.elapsed_secs || 0);
      }
    };

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, findings: [], elapsedSecs: 0, stderr, error: error?.message || String(error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      if (code === 0 || code === null) resolvePromise({ ok: true, findings, elapsedSecs, stderr });
      else resolvePromise({ ok: false, findings, elapsedSecs, stderr, error: "анализатор завершился с кодом " + code });
    });
  });
}
