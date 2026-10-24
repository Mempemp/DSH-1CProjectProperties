import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Формат исходников, который CLI не считает поддерживаемым (выгрузка в файлы без cf/EDT),
// раньше упирался в интерактивный вопрос и индекс не собирался вообще. Проверяем на реальном
// CLI: первая попытка падает, повтор с --allow-unsupported-format даёт неполный индекс.

const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["rlm-bsl-index"], { encoding: "utf8" });
const cliFound =
  probe.status === 0 ||
  existsSync(join(homedir(), ".local", "bin", process.platform === "win32" ? "rlm-bsl-index.exe" : "rlm-bsl-index"));
if (!cliFound) {
  console.log("пропуск: rlm-bsl-index не установлен в этой системе");
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), "rlm-format-"));
process.env.DSH_HOME = home;

const { applyRlm } = await import("../lib/rlm-runner.js");

const routes = new Map();
const ctx = {
  webServer: { register: ({ path, handler }) => routes.set(path, handler) },
  logger: { info: () => {}, error: () => {} },
  effect: () => {},
  get: () => null,
};
applyRlm(ctx, { autoStart: false });

function request(url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = url;
    setImmediate(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
    const res = {
      writeHead(code) {
        this.code = code;
      },
      end(text) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ code: this.code, json: parsed });
      },
    };
    Promise.resolve(routes.get(url.split("?")[0])(req, res)).catch(reject);
  });
}

const project = join(home, "project");
mkdirSync(join(project, "CommonModules", "Тест", "Ext"), { recursive: true });
writeFileSync(join(project, "CommonModules", "Тест", "Ext", "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n", "utf8");

const started = await request("/rlm/index/job", { path: project, action: "build" });
assert.equal(started.json?.job?.state, "running", JSON.stringify(started.json));

let state = null;
for (let attempt = 0; attempt < 90; attempt += 1) {
  const polled = await request(`/rlm/index/state?path=${encodeURIComponent(project)}`);
  state = polled.json;
  if (state?.job && state.job.state !== "running") break;
  await new Promise(done => setTimeout(done, 1000));
}

assert.equal(state?.job?.state, "done", JSON.stringify(state?.job));
assert.equal(state?.job?.cancelled, undefined);
assert.equal(state?.job?.partial, true, "индекс на нестандартном формате должен быть помечен неполным");
const log = readFileSync(join(home, "rlm-tools-bsl", "logs", "index.log"), "utf8");
assert.ok(log.includes("--allow-unsupported-format"), "в журнале должен быть повтор с флагом");
assert.ok(/не распознан|неполным/.test(log), "русский текст журнала должен читаться, а не быть мусором");

console.log("ok   формат не cf/EDT: повтор с --allow-unsupported-format, индекс помечен неполным");
