// Правила 1С в проекте: наш слой разворачивается всегда, comol — флажком.
// Снятый флажок ничего не удаляет; удаление — только явная команда removeRules.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const {
  deployRules,
  readPayload,
  removeRules,
  rewritePaths,
  rulesStatus,
  rulesSummary,
} = await import("../lib/rules-deploy.js");
const { COMOL } = await import("../lib/rulesets.js");

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
const payloadRoot = join(home, COMOL.payloadDir);

write(
  join(payloadRoot, "payload.json"),
  JSON.stringify({ id: "comol", version: "2026.10.31-test", digest: "digest-test" }, null, 2),
);
write(
  join(payloadRoot, "content", "rules", "module-structure.md"),
  "Смотри `content/rules/help-corpus-retrieval.md` и `skills/demo/SKILL.md`.\n",
);
write(join(payloadRoot, "content", "agents", "explorer.md"), "# explorer\n");
write(join(payloadRoot, "content", "commands", "updaterules.md"), "# updaterules\n");
write(join(payloadRoot, "content", "skills", "demo", "SKILL.md"), "# demo\n");
write(
  join(payloadRoot, "content", "openspec-bundle", "claude-code", ".claude", "skills", "opsx", "SKILL.md"),
  "# opsx\n",
);
write(join(payloadRoot, "openspec", "README.md"), "openspec workspace\n");
write(
  join(payloadRoot, ".dev.env.example"),
  "PLATFORM_PATH=\nPLATFORM_VERSION=\nINFOBASE_PATH=\nIB_USER=\nUSE_EDT=\nPREFIX=\n",
);

const project = join(work, "project");
write(
  join(project, "Configuration.xml"),
  "<Configuration><CompatibilityMode>8.3.24</CompatibilityMode></Configuration>",
);

const params = {
  infobasePath: "C:\\Bases\\Test",
  user: "Админ",
  password: "секрет",
  platformPath: "C:\\1cv8\\bin\\1cv8.exe",
};
const common = { platformPath: "" };

console.log("реестр и payload");
check("единственный набор — comol", COMOL.id === "comol" && COMOL.payloadDir === "1c-rules");
check("payload найден", readPayload(home).ok === true);
check("нет payload'а — понятная ошибка", readPayload(join(work, "empty")).ok === false);

console.log("наш слой без comol");
const plain = deployRules({ dshHome: home, projectPath: project, params, common });
check("развёртывание прошло", plain.ok === true, plain.error);
check("плейбук code.md на месте", existsSync(join(project, ".dsh", "rules-own", "code.md")));
check("плейбук review.md на месте", existsSync(join(project, ".dsh", "rules-own", "review.md")));
check("плейбук its.md на месте", existsSync(join(project, ".dsh", "rules-own", "its.md")));
check("остальные плейбуки на месте", existsSync(join(project, ".dsh", "rules-own", "find.md")));
check("AGENTS.md создан", existsSync(join(project, "AGENTS.md")));
const agentsPlain = read(join(project, "AGENTS.md"));
check("AGENTS.md без блока comol", !agentsPlain.includes("ruleset:comol:start"));
check("в AGENTS.md есть маршрут к code.md", agentsPlain.includes(".dsh/rules-own/code.md"));
check("в AGENTS.md есть маршрут к review.md", agentsPlain.includes(".dsh/rules-own/review.md"));
check("в AGENTS.md есть маршрут к its.md", agentsPlain.includes(".dsh/rules-own/its.md"));
check("USER-RULES.md создан", existsSync(join(project, "USER-RULES.md")));
check("comol не развёрнут", !existsSync(join(project, ".dsh", "rules-1c")));
check(".dev.env не создан", !existsSync(join(project, ".dev.env")));
const envPlain = read(join(project, ".dsh", "rules-own", "environment.md"));
check("справка без comol", !envPlain.includes(".dsh/rules-1c") && envPlain.includes(".dsh/rules-own"));
check("справка: справочник правил подключён", envPlain.includes("Полный справочник правил") && envPlain.includes("reference"));
const refDir = (envPlain.match(/\| Полный текст правил 1С \(дословно, из comol\) \| `([^`]+)` \|/u) || [])[1] || "";
check("справка: путь справочника существует", refDir !== "" && existsSync(refDir), refDir);
check(
  "справочник: файлы на месте",
  refDir !== "" && ["locks-and-transactions.md", "anti-patterns.md", "registers-design.md", "dcs-design.md"]
    .every((name) => existsSync(join(refDir, name))),
);
const lockRef = refDir ? read(join(refDir, "locks-and-transactions.md")) : "";
check("справочник: дословный текст с указанием источника", lockRef.includes("comol/ai_rules_1c @ 18e3383d"));
const manifestPlain = JSON.parse(read(join(project, ".dsh", "1c-rules.json")));
check("манифест: withComol=false", manifestPlain.withComol === false);
check("сводка: развёрнуто без comol", rulesSummary(project).withComol === false);

console.log("флажок comol");
const withComol = deployRules({ dshHome: home, projectPath: project, withComol: true, params, common });
check("развёртывание с comol прошло", withComol.ok === true, withComol.error);
check("правила comol на месте", existsSync(join(project, ".dsh", "rules-1c", "module-structure.md")));
check("роли на месте", existsSync(join(project, ".dsh", "agents-1c", "explorer.md")));
check("команды на месте", existsSync(join(project, ".dsh", "commands-1c", "updaterules.md")));
check("навыки на месте", existsSync(join(project, ".dsh", "skills", "demo", "SKILL.md")));
check("навыки openspec на месте", existsSync(join(project, ".dsh", "skills", "opsx", "SKILL.md")));
check("openspec workspace на месте", existsSync(join(project, "openspec", "README.md")));
check("блок comol в AGENTS.md", read(join(project, "AGENTS.md")).includes("ruleset:comol:start"));
const rewritten = read(join(project, ".dsh", "rules-1c", "module-structure.md"));
check(
  "ссылки переписаны на проектные",
  rewritten.includes(".dsh/rules-1c/help-corpus-retrieval.md") &&
    rewritten.includes(".dsh/skills/demo/SKILL.md"),
  rewritten,
);
check(".dev.env создан", existsSync(join(project, ".dev.env")));
check(
  "пароль в .dev.env не записан",
  !read(join(project, ".dev.env")).includes("IB_PASSWORD") && !read(join(project, ".dev.env")).includes("секрет"),
);
check("манифест: withComol=true", JSON.parse(read(join(project, ".dsh", "1c-rules.json"))).withComol === true);
const statusOn = rulesStatus({ dshHome: home, projectPath: project });
check("состояние: comol развёрнут", statusOn.withComol === true && statusOn.counts.files > 10);
check("состояние: правок нет", statusOn.modified.length === 0, statusOn.modified.join(", "));

console.log("снятый флажок не удаляет");
const off = deployRules({ dshHome: home, projectPath: project, withComol: false, params, common });
check("развёртывание без comol прошло", off.ok === true, off.error);
check("файлы comol остались", existsSync(join(project, ".dsh", "rules-1c", "module-structure.md")));
check("блок comol убран из AGENTS.md", !read(join(project, "AGENTS.md")).includes("ruleset:comol:start"));
check("манифест: withComol=false", JSON.parse(read(join(project, ".dsh", "1c-rules.json"))).withComol === false);

console.log("правки пользователя");
const codeFile = join(project, ".dsh", "rules-own", "code.md");
const original = read(codeFile);
write(codeFile, original + "\n<!-- моя правка -->\n");
const again = deployRules({ dshHome: home, projectPath: project, withComol: true, params, common });
check("правка не перезаписана", read(codeFile).includes("<!-- моя правка -->"));
check(
  "отчёт: файл сохранён",
  again.files.some((file) => file.status === "preserved" && file.path === ".dsh/rules-own/code.md"),
);

console.log("чужой AGENTS.md");
const project2 = join(work, "project-foreign");
write(join(project2, "Configuration.xml"), "<Configuration/>");
write(join(project2, "AGENTS.md"), "# Чужой AGENTS\n\nНе трогать.\n");
const foreign = deployRules({ dshHome: home, projectPath: project2, params, common });
check("развёртывание прошло", foreign.ok === true, foreign.error);
check("прежний AGENTS.md сохранён", existsSync(join(project2, "AGENTS.md.bak.md")));
check(
  "прежний текст вклеен в USER-RULES.md",
  read(join(project2, "USER-RULES.md")).includes("Перенесено из AGENTS.md") &&
    read(join(project2, "USER-RULES.md")).includes("# Чужой AGENTS"),
);

console.log("удаление правил");
const removed = removeRules({ projectPath: project });
check("удаление прошло", removed.ok === true, removed.error);
check("AGENTS.md удалён", !existsSync(join(project, "AGENTS.md")));
check("USER-RULES.md остался", existsSync(join(project, "USER-RULES.md")));
check("манифест удалён", !existsSync(join(project, ".dsh", "1c-rules.json")));
check("файлы comol удалены", !existsSync(join(project, ".dsh", "rules-1c", "module-structure.md")));
check("правка пользователя осталась", existsSync(codeFile) && read(codeFile).includes("<!-- моя правка -->"));

console.log("переписывание ссылок");
const paths = rewritePaths("content/rules/a.md content/agents/b.md content/commands/c.md skills/x/SKILL.md");
check(
  "все виды ссылок",
  paths.includes(".dsh/rules-1c/a.md") &&
    paths.includes(".dsh/agents-1c/b.md") &&
    paths.includes(".dsh/commands-1c/c.md") &&
    paths.includes(".dsh/skills/x/SKILL.md"),
  paths,
);

console.log("");
if (failed > 0) {
  console.log(`провалено ${failed} из ${total}`);
  process.exit(1);
}
console.log(`все проверки пройдены (${total})`);
