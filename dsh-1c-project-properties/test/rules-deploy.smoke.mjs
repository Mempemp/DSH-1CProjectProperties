// Проверка контракта развёртывания правил в проект.
//
// Запуск: node test/rules-deploy.smoke.mjs
//
// Тест самодостаточный: собирает синтетический набор правил (той же формы, что
// сеет DSH Desktop в $DSH_HOME/1c-rules), разворачивает его в поддельный проект
// и проверяет то, что легко сломать незаметно: переписывание ссылок,
// сохранение чужого AGENTS.md, идемпотентность повторного прогона, сохранение
// правок пользователя и корректное удаление.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(resolve(here, "..", "lib", "rules-deploy.js")).href;
const { deployRules, removeRules, rulesStatus, rewritePaths, readPayload } = await import(moduleUrl);
const { buildDesignerArgs } = await import(pathToFileURL(resolve(here, "..", "lib", "index.js")).href);

const work = join(tmpdir(), "dsh-1c-rules-deploy-test-" + process.pid);
const home = join(work, "home");
const project = join(work, "project");
const payloadRoot = join(home, "1c-rules");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function buildPayload() {
  write(
    join(payloadRoot, "AGENTS.md"),
    [
      "# 1C Rules",
      "",
      "Hard gate is owned by `AGENTS.md`. Rules: `content/rules/gate.md`,",
      "roles: `content/agents/worker.md`, commands: `content/commands/doctor.md`,",
      "skills: `content/skills/demo/SKILL.md`. Model profile: `content/rules/model-<slug>.md`.",
      "",
    ].join("\n"),
  );
  write(join(payloadRoot, "content", "rules", "gate.md"), "См. `content/rules/other.md` и `AGENTS.md`.\n");
  write(join(payloadRoot, "content", "rules", "other.md"), "Правило без ссылок.\n");
  write(join(payloadRoot, "content", "agents", "worker.md"), "---\nname: worker\n---\nРоль из `content/rules/gate.md`.\n");
  write(join(payloadRoot, "content", "commands", "doctor.md"), "---\ndescription: диагностика\n---\nПроверка.\n");
  write(
    join(payloadRoot, "content", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\nЗапусти `skills/demo/tools/run.ps1`, см. `content/rules/gate.md`.\n",
  );
  write(join(payloadRoot, "content", "skills", "demo", "tools", "run.ps1"), "Write-Host 'demo'\n");
  write(
    join(payloadRoot, "content", "openspec-bundle", "claude-code", ".claude", "skills", "openspec-propose", "SKILL.md"),
    "---\nname: openspec-propose\n---\nПредложи изменение.\n",
  );
  write(join(payloadRoot, "openspec", "config.yaml"), "schema: spec-driven\n");
  write(join(payloadRoot, "openspec", "project.md"), "# Проект\n");
  write(join(payloadRoot, "USER-RULES.md"), "# Правила проекта\n\nДополнения команды.\n");
  write(join(payloadRoot, "memory.md"), "# Память проекта\n");
  write(join(payloadRoot, "LLM-RULES.md"), "# LLM Rules\n");
  write(
    join(payloadRoot, ".dev.env.example"),
    ["# параметры проекта", "PLATFORM_PATH=", "PLATFORM_VERSION=", "INFOBASE_PATH=", "IB_USER=", "IB_PASSWORD=", "USE_EDT=false", "PREFIX=", ""].join("\n"),
  );
  write(
    join(payloadRoot, "payload.json"),
    JSON.stringify({
      format: "dsh-desktop-payload",
      formatVersion: 1,
      id: "1c-rules",
      name: "1c-rules",
      version: "2026.09.16-test",
      digest: "f".repeat(64),
      catalog: { id: "dsh-desktop", version: "0.9.0-1" },
      seededAt: new Date().toISOString(),
    }, null, 2),
  );
}

function buildProject() {
  write(join(project, "AGENTS.md"), "# Мой AGENTS\n\nНе трогать ветку main.\n");
  write(join(project, "Configuration.xml"), "<Configuration><CompatibilityMode>8.3.24</CompatibilityMode></Configuration>\n");
  write(join(project, ".gitignore"), "node_modules/\n");
  write(
    join(project, ".dsh", "1c-project.json"),
    JSON.stringify({ infobasePath: "C:\\Bases\\Test", user: "Админ", password: "секрет", platformPath: "C:\\1cv8\\bin\\1cv8.exe" }, null, 2),
  );
}

const params = { infobasePath: "C:\\Bases\\Test", user: "Админ", password: "секрет", platformPath: "C:\\1cv8\\bin\\1cv8.exe" };
const common = { platformPath: "", extraProjects: [] };
const read = (rel) => readFileSync(join(project, rel), "utf8");

rmSync(work, { recursive: true, force: true });
buildPayload();
buildProject();

// ── Пакетные операции Конфигуратора ─────────────────────────────────────────
// Неверный ключ платформа молча игнорирует, и операция «проходит успешно»,
// ничего не сделав, — поэтому ключи проверяются буквально.
console.log("пакетные операции: аргументы");
const auth = { user: "Админ", password: "секрет", unlockCode: "123" };
const base = { baseArg: "/FC:\\Bases\\Test", params: auth, logFile: "C:\\t\\out.log", resultFile: "C:\\t\\res.txt" };

const dumpArgs = buildDesignerArgs({ ...base, operation: "dump", targetDir: "C:\\p\\src", format: "Plain" }).args;
check("выгрузка: команда DESIGNER и база", dumpArgs[0] === "DESIGNER" && dumpArgs[1] === "/FC:\\Bases\\Test");
check("выгрузка: /N /P /UC", dumpArgs.includes("/NАдмин") && dumpArgs.includes("/Pсекрет") && dumpArgs.includes("/UC123"));
check("выгрузка: /DumpConfigToFiles с каталогом", dumpArgs.includes("/DumpConfigToFiles") && dumpArgs.includes("C:\\p\\src"));
check("выгрузка: формат передан", dumpArgs[dumpArgs.indexOf("-Format") + 1] === "Plain");
check("выгрузка: без -update по умолчанию", !dumpArgs.includes("-update"));
check("выгрузка: /Out и /DumpResult", dumpArgs.includes("/OutC:\\t\\out.log") && dumpArgs.includes("/DumpResultC:\\t\\res.txt"));
check("выгрузка: диалоги отключены", dumpArgs.includes("/DisableStartupDialogs") && dumpArgs.includes("/DisableStartupMessages"));

const incArgs = buildDesignerArgs({ ...base, operation: "dump", targetDir: "C:\\p", update: true }).args;
check("инкрементальная выгрузка: -update -force", incArgs.includes("-update") && incArgs.includes("-force"));

const extArgs = buildDesignerArgs({ ...base, operation: "extensions", targetDir: "C:\\p\\Extensions" }).args;
check("расширения: свой каталог", extArgs[extArgs.indexOf("/DumpConfigToFiles") + 1] === "C:\\p\\Extensions");
check("расширения: -AllExtensions и иерархический формат", extArgs.includes("-AllExtensions") && extArgs[extArgs.indexOf("-Format") + 1] === "Hierarchical");

const loadArgs = buildDesignerArgs({ ...base, operation: "load", sourceDir: "C:\\p\\src", format: "Hierarchical" }).args;
check("загрузка: /LoadConfigFromFiles с каталогом", loadArgs.includes("/LoadConfigFromFiles") && loadArgs.includes("C:\\p\\src"));
check("загрузка: обновление базы по умолчанию", loadArgs.includes("/UpdateDBCfg"));
check("загрузка: динамическое обновление", loadArgs.includes("-Dynamic+") && loadArgs.includes("-SessionTerminate") && loadArgs.includes("force"));

const staticLoad = buildDesignerArgs({ ...base, operation: "load", sourceDir: "C:\\p", dynamic: false }).args;
check("загрузка без динамики: -Dynamic+ нет", staticLoad.includes("/UpdateDBCfg") && !staticLoad.includes("-Dynamic+"));

const noUpdate = buildDesignerArgs({ ...base, operation: "load", sourceDir: "C:\\p", updateDb: false }).args;
check("загрузка без обновления БД: /UpdateDBCfg нет", !noUpdate.includes("/UpdateDBCfg"));

const anon = buildDesignerArgs({ operation: "dump", baseArg: "/S\"srv\\base\"", params: {}, targetDir: "C:\\p", logFile: "l", resultFile: "r" }).args;
check("без аутентификации: /N и /P не передаются", !anon.some((a) => a.startsWith("/N") || a.startsWith("/P")));
check("серверная база: строка соединения на месте", anon[1] === "/S\"srv\\base\"");

check("неизвестная операция отклоняется", (() => {
  try {
    buildDesignerArgs({ operation: "erase", baseArg: "/F", targetDir: "x", logFile: "l", resultFile: "r" });
    return false;
  } catch {
    return true;
  }
})());

console.log("набор правил");
const payload = readPayload(home);
check("payload читается", payload.ok === true, payload.error);
check("версия из манифеста", payload.manifest?.version === "2026.09.16-test");

console.log("предпросмотр");
const preview = deployRules({ dshHome: home, projectPath: project, params, common, dryRun: true });
check("предпросмотр проходит", preview.ok === true, preview.error);
check("после предпросмотра ничего не записано", !existsSync(join(project, ".dsh", "skills")));
check("чужой AGENTS.md на месте", read("AGENTS.md").includes("Не трогать ветку main"));

console.log("развёртывание");
const deployed = deployRules({ dshHome: home, projectPath: project, params, common });
check("развёртывание проходит", deployed.ok === true, deployed.error);
check("правило на месте", existsSync(join(project, ".dsh", "rules-1c", "gate.md")));
check("роль на месте", existsSync(join(project, ".dsh", "agents-1c", "worker.md")));
check("сценарий на месте", existsSync(join(project, ".dsh", "commands-1c", "doctor.md")));
check("навык на месте", existsSync(join(project, ".dsh", "skills", "demo", "SKILL.md")));
check("скрипт навыка на месте", existsSync(join(project, ".dsh", "skills", "demo", "tools", "run.ps1")));
check("openSpec-навык на месте", existsSync(join(project, ".dsh", "skills", "openspec-propose", "SKILL.md")));
check("openSpec workspace развёрнут", existsSync(join(project, "openspec", "config.yaml")));
check("манифест развёртывания записан", existsSync(join(project, ".dsh", "1c-rules.json")));

console.log("переписывание ссылок");
const entry = read("AGENTS.md");
check("AGENTS.md стал управляемым", entry.includes("managed by dsh-1c-project-properties"));
check("не осталось content/-ссылок", !/content\/(rules|agents|commands|skills)\//u.test(entry), entry.match(/content\/[a-z]+\/[^\s`,)]*/gu)?.join(", "));
check("ссылки ведут в .dsh/rules-1c", entry.includes(".dsh/rules-1c/gate.md"));
check("плейсхолдер model-<slug> переписан", entry.includes(".dsh/rules-1c/model-<slug>.md"));
check("ссылка на AGENTS.md сохранена", entry.includes("`AGENTS.md`"));
const rule = read(".dsh/rules-1c/gate.md");
check("ссылки внутри правил переписаны", rule.includes(".dsh/rules-1c/other.md") && !rule.includes("content/rules/"));
const skill = read(".dsh/skills/demo/SKILL.md");
check("путь к скриптам навыка переписан", skill.includes(".dsh/skills/demo/tools/run.ps1"));
check("уже переписанный путь не портится", rewritePaths(".dsh/skills/x/tools/y.ps1") === ".dsh/skills/x/tools/y.ps1");

console.log("чужой AGENTS.md");
check("сохранён в бэкап", existsSync(join(project, "AGENTS.md.bak.md")));
check("текст пользователя вклеен в USER-RULES.md", read("USER-RULES.md").includes("Не трогать ветку main"));
check("вклейка помечена маркерами", read("USER-RULES.md").includes("1c-rules:migrated:start"));

console.log(".dev.env");
const env = read(".dev.env");
check("путь к базе перенесён", /^INFOBASE_PATH=C:\\Bases\\Test$/mu.test(env));
check("пользователь перенесён", /^IB_USER=Админ$/mu.test(env));
check("версия из Configuration.xml", /^PLATFORM_VERSION=8\.3\.24$/mu.test(env));
check("пароль не перенесён без опции", /^IB_PASSWORD=$/mu.test(env));
check("комментарий примера сохранён", env.includes("# параметры проекта"));
check("предупреждение про .gitignore", deployed.warnings.some((line) => line.includes(".gitignore")));

console.log("идемпотентность");
const again = deployRules({ dshHome: home, projectPath: project, params: {}, common });
check("повтор ничего не пишет", again.summary.written === 0, JSON.stringify(again.summary));
check("повтор ничего не удаляет", again.summary.removed === 0);
check("состояние: развёрнуто", rulesStatus({ dshHome: home, projectPath: project }).deployed === true);

console.log("правки пользователя");
write(join(project, ".dsh", "rules-1c", "gate.md"), read(".dsh/rules-1c/gate.md") + "\n<!-- моя правка -->\n");
const afterEdit = deployRules({ dshHome: home, projectPath: project, params: {}, common });
check("правка не перезаписана", read(".dsh/rules-1c/gate.md").includes("моя правка"));
check("правка попала в отчёт как сохранённая", afterEdit.summary.preserved >= 1);
check("статус видит правку", rulesStatus({ dshHome: home, projectPath: project }).modified.includes(".dsh/rules-1c/gate.md"));

console.log("удаление");
const removed = removeRules({ projectPath: project });
check("прежний AGENTS.md возвращён", read("AGENTS.md").includes("Не трогать ветку main"));
check("управляемого AGENTS.md больше нет", !read("AGENTS.md").includes("managed by dsh-1c-project-properties"));
check("файл с правкой пользователя оставлен", existsSync(join(project, ".dsh", "rules-1c", "gate.md")));
check("остальные правила удалены", !existsSync(join(project, ".dsh", "rules-1c", "other.md")));
check("роли удалены", !existsSync(join(project, ".dsh", "agents-1c")));
check("навыки удалены", !existsSync(join(project, ".dsh", "skills")));
check("USER-RULES.md оставлен", existsSync(join(project, "USER-RULES.md")));
check("memory.md оставлен", existsSync(join(project, "memory.md")));
check("манифест удалён", !existsSync(join(project, ".dsh", "1c-rules.json")));
check("отчёт об удалении непустой", removed.removed.length > 0 && removed.restored === "AGENTS.md");

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nвсе проверки пройдены" : "\nпровалено проверок: " + failures);
process.exit(failures === 0 ? 0 : 1);
