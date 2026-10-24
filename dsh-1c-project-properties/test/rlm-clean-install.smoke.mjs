// Сценарий «чистая машина»: ни rlm-tools-bsl, ни uv в системе нет.
// Плагин должен сам поставить uv (официальным скриптом) и rlm-tools-bsl — всё внутрь
// изолированного DSH_HOME, затем поднять сервер. Запускается вручную, качает ~60 МБ.
//
// Запуск: node test/rlm-clean-install.smoke.mjs
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
const HOME = mkdtempSync(join(tmpdir(), "dsh-rlm-clean-"));
const FAKE_USERPROFILE = mkdtempSync(join(tmpdir(), "dsh-rlm-noprofile-"));
process.env.DSH_HOME = HOME;
process.env.USERPROFILE = FAKE_USERPROFILE;
// PATH без каталога uv и без python: остаются системные каталоги, нужные для powershell.
process.env.PATH = ["C:\\Windows\\System32", "C:\\Windows", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0"].join(";");

const checks = [];
function check(name, ok, details) {
  checks.push(Boolean(ok));
  console.log((ok ? "PASS" : "FAIL") + " — " + name + (details ? "  [" + details + "]" : ""));
}

const routes = [];
const disposers = [];
const ctx = {
  webServer: { register: (spec) => routes.push(spec) },
  effect: (factory) => {
    const dispose = factory();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  on: () => {},
  logger: { info: (message) => console.log("  host: " + message) },
};

const plugin = await import(new URL("../lib/rlm-runner.js", import.meta.url).href);
plugin.applyRlm(ctx, { port: PORT });

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = routes.find((item) => item.kind === "exact" && item.path === url.pathname);
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  await route.handler(req, res);
});
await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + httpServer.address().port;

let state = null;
const deadline = Date.now() + 15 * 60_000;
let sawInstalling = false;
while (Date.now() < deadline) {
  state = await fetch(base + "/rlm/state").then((r) => r.json()).catch(() => null);
  if (state?.server?.installing) sawInstalling = true;
  if (state?.server?.running && state.server.version) break;
  if (state?.server?.lastError && !state.server.installing) break;
  await new Promise((done) => setTimeout(done, 1000));
}

const dir = join(HOME, "rlm-tools-bsl");
const binDir = join(dir, "bin");
check("uv и сервер поставлены в папку плагина", existsSync(join(binDir, "uv.exe")) && existsSync(join(binDir, "rlm-tools-bsl.exe")), binDir);
check("окружение инструмента внутри папки плагина", existsSync(join(dir, "tool")), join(dir, "tool"));
check("сервер поднят после автоустановки", state?.server?.running === true && Boolean(state.server.version), String(state?.server?.version ?? state?.server?.lastError));
check("версия прочитана из MCP initialize", /^\d+\.\d+/.test(String(state?.server?.version)), String(state?.server?.version));
check("в логе есть вывод установки", existsSync(join(dir, "logs", "server.out.log")));
check("состояние «устанавливается» показывалось", sawInstalling);
console.log("содержимое " + binDir + ": " + (existsSync(binDir) ? readdirSync(binDir).join(", ") : "—"));
console.log("каталоги в " + dir + ": " + readdirSync(dir).join(", "));

for (const dispose of disposers) {
  try {
    await dispose();
  } catch (error) {
    console.log("disposer: " + error);
  }
}
await new Promise((done) => httpServer.close(done));

const failed = checks.filter((item) => !item).length;
console.log("\n" + (checks.length - failed) + "/" + checks.length + " проверок пройдено");
console.log("изолированный DSH_HOME: " + HOME);
rmSync(HOME, { recursive: true, force: true });
rmSync(FAKE_USERPROFILE, { recursive: true, force: true });
console.log("временные каталоги удалены");
process.exit(failed ? 1 : 0);
