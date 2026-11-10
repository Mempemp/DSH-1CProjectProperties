// Раскладка правил в проект: один слой — AGENTS.md, плейбуки, USER-RULES.md,
// environment.md. Повторный запуск не перезаписывает правки, удаление — только
// явной командой removeRules.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { deployRules, removeRules, rulesStatus, rulesSummary } = await import("../lib/rules-deploy.js");

let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " — " + detail}`);
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function read(file) {
  return readFileSync(file, "utf8");
}

const work = mkdtempSync(join(tmpdir(), "dsh1c-rules-"));
const home = join(work, "home");
mkdirSync(home, { recursive: true });

const project = join(work, "project");
write(join(project, "Configuration.xml"), "<Configuration><CompatibilityMode>8.3.24</CompatibilityMode></Configuration>");

console.log("раскладка");
const first = deployRules({ dshHome: home, projectPath: project });
check("развёртывание прошло", first.ok === true, first.error);

const own = join(project, ".dsh", "rules-own");
const expected = [
  "code.md", "db.md", "edit.md", "find.md", "its.md", "metadata.md",
  "platform.md", "query.md", "reports.md", "review.md", "ui.md", "environment.md",
];
const present = readdirSync(own).sort();
check("плейбуки на месте", expected.every((name) => present.includes(name)), present.join(", "));
check("в проекте только наш слой", !existsSync(join(project, ".dsh", "rules-1c")) && !existsSync(join(project, "openspec")));
check("параметры платформы в проект не пишутся", !existsSync(join(project, ".dev.env")));
check("AGENTS.md создан", existsSync(join(project, "AGENTS.md")));
check("USER-RULES.md создан", existsSync(join(project, "USER-RULES.md")));

console.log("AGENTS.md");
const agents = read(join(project, "AGENTS.md"));
check("маршрут к code.md", agents.includes(".dsh/rules-own/code.md"));
check("маршрут к review.md", agents.includes(".dsh/rules-own/review.md"));
check("маршрут к its.md", agents.includes(".dsh/rules-own/its.md"));
check("маршрут к reports.md", agents.includes(".dsh/rules-own/reports.md"));
check("без вызовов чужих инструментов", !/mcp__|comol|ai_rules_1c/u.test(agents));
check("без пояснений и оправданий", !/оправдан|не нужен|поэтому|в отличие|больше не/u.test(agents));
check("без блоков второго набора", !/ruleset:|расширенный набор|справочник в пакете/u.test(agents));

const env = read(join(own, "environment.md"));
check("справка: наш слой", env.includes("`.dsh/rules-own/`") && env.includes("`AGENTS.md`"));
check("справка: без второго набора", !/rules-1c|agents-1c|commands-1c|reference/u.test(env));
check("справка: MCP-серверы", env.includes("## MCP-серверы"));

console.log("манифест и состояние");
const manifest = JSON.parse(read(join(project, ".dsh", "1c-rules.json")));
check("манифест: файлы записаны", Array.isArray(manifest.files) && manifest.files.length >= expected.length);
check("манифест: без следов набора", manifest.withComol === undefined && manifest.payload === undefined);
const status = rulesStatus({ dshHome: home, projectPath: project });
check("состояние: развёрнуто", status.deployed === true && status.counts.files === manifest.files.length);
check("состояние: правок нет", status.modified.length === 0, status.modified.join(", "));
check("сводка: развёрнуто", rulesSummary(project).deployed === true);

console.log("повторная раскладка");
const second = deployRules({ dshHome: home, projectPath: project });
check("повтор прошёл", second.ok === true, second.error);
check("повтор ничего не переписал", second.files.every((file) => file.status !== "written"), JSON.stringify(second.files.slice(0, 3)));

console.log("правки пользователя");
const codeFile = join(own, "code.md");
write(codeFile, read(codeFile) + "\n<!-- моя правка -->\n");
const third = deployRules({ dshHome: home, projectPath: project });
check("правка не перезаписана", read(codeFile).includes("<!-- моя правка -->"));
check(
  "отчёт: файл сохранён",
  third.files.some((file) => file.status === "preserved" && file.path === ".dsh/rules-own/code.md"),
);
check(
  "состояние: правка видна",
  rulesStatus({ dshHome: home, projectPath: project }).modified.includes(".dsh/rules-own/code.md"),
);

console.log("чужой AGENTS.md");
const project2 = join(work, "project-foreign");
write(join(project2, "Configuration.xml"), "<Configuration/>");
write(join(project2, "AGENTS.md"), "# Чужой AGENTS\n\nНе трогать.\n");
const foreign = deployRules({ dshHome: home, projectPath: project2 });
check("раскладка в чужой проект прошла", foreign.ok === true, foreign.error);
check("прежний AGENTS.md сохранён", existsSync(join(project2, "AGENTS.md.bak.md")));
check(
  "прежний текст вклеен в USER-RULES.md",
  read(join(project2, "USER-RULES.md")).includes("Перенесено из AGENTS.md") &&
    read(join(project2, "USER-RULES.md")).includes("# Чужой AGENTS"),
);

console.log("проверка пути");
const missing = deployRules({ dshHome: home, projectPath: join(work, "нет-такой-папки") });
check("нет папки — отказ с текстом", missing.ok === false && typeof missing.error === "string");

console.log("удаление правил");
const removed = removeRules({ projectPath: project });
check("удаление прошло", removed.ok === true, removed.error);
check("AGENTS.md удалён", !existsSync(join(project, "AGENTS.md")));
check("USER-RULES.md остался", existsSync(join(project, "USER-RULES.md")));
check("манифест удалён", !existsSync(join(project, ".dsh", "1c-rules.json")));
check("правка пользователя осталась", existsSync(codeFile) && read(codeFile).includes("<!-- моя правка -->"));

console.log("");
if (failed > 0) {
  console.log(`провалено ${failed} из ${total}`);
  process.exit(1);
}
console.log(`все проверки пройдены (${total})`);
