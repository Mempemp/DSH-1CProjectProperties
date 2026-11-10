// Проверки кода BSL: модель наборов, принятые замечания, конфиг движка,
// роуты и инструменты агента. Движок не нужен: проверяем нашу половину.
//
// Запуск: node test/bsl-checks.smoke.mjs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "dsh-1c-bsl-checks-test-" + process.pid);
process.env.DSH_HOME = join(work, "home");
// Кеш движка — в тестовый каталог: иначе на машине, где анализатор уже
// скачан, проверка «движка нет» прошла бы по чужому бинарнику.
process.env.DSH_BSL_CHECKER_DIR = join(work, "engine");
process.env.DSH_BSL_CHECKER_BIN = "";
process.env.DSH_BSL_CHECKER_NO_DOWNLOAD = "1";

const lib = join(here, "..", "lib", "bsl-checks");
const load = (name) => import("file://" + join(lib, name).replace(/\\/g, "/"));

const { catalog, categories, enabledByDefault } = await load("catalog.js");
const presetsModule = await load("presets.js");
const { loadAccepted, acceptFindings, restoreFindings, markFindings, findingKey } = await load("acceptance.js");
const { readParams, patchParams, checksReady } = await load("params.js");
const { writeConfig, CONFIG_FILE, syncResidentConfig, rulesToEnable, RESIDENT_CONFIG_FILE } = await load("config.js");
const { registerBslChecksRoutes } = await load("router.js");
const { metadataState, dropSymbolDependent, metadataObjects } = await load("metadata.js");
const { startChecksMcpServer } = await load("mcp.js");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log("  ok   " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL " + label + (detail === undefined ? "" : " — " + detail));
}

const project = join(work, "project");
const dump = join(work, "dump");
mkdirSync(join(project, ".dsh"), { recursive: true });
mkdirSync(join(dump, "CommonModules", "API", "Ext"), { recursive: true });
const moduleFile = join(dump, "CommonModules", "API", "Ext", "Module.bsl");
writeFileSync(moduleFile, "Процедура Тест()\n\tА = 1;\nКонецПроцедуры\n", "utf8");
writeFileSync(
  join(project, ".dsh", "1c-project.json"),
  JSON.stringify({ dumpDir: dump }, null, 2),
  "utf8"
);

console.log("каталог");
check("210 правил", catalog().length === 210, catalog().length);
check("11 категорий", categories().length === 11, categories().length);
// Уровни — ровно те, что отдаёт анализатор: своего маппинга нет.
check(
  "уровни из анализатора",
  catalog().every((rule) => ["error", "warning", "info", "hint"].includes(rule.severity)),
  [...new Set(catalog().map((rule) => rule.severity))].join(","),
);
check("правило анализатора выключено по умолчанию", enabledByDefault("TernaryOperatorUsage") === false);
check("обычное правило включено по умолчанию", enabledByDefault("ParseError") === true);

console.log("наборы");
const presets = presetsModule.listPresets();
check("два набора поставки", presets.presets.filter((item) => item.builtin).length === 2, presets.presets.length);
// Состав поставки зафиксирован заказчиком: список и порог меняются только
// вместе с файлом lib/bsl-checks/presets/recommended.md.
const DELIVERY_OFF = [
  "BadWords",
  "CanonicalSpellingKeywords",
  "CodeOutOfRegion",
  "EmptyRegion",
  "ExcessiveAutoTestCheck",
  "MissingSpace",
  "MultilingualStringHasAllDeclaredLanguages",
  "MultilingualStringUsingWithTemplate",
  "SpaceAtStartComment",
  "UsingObjectNotAvailableUnix",
];
const recommended = presetsModule.resolvePreset("recommended").preset;
check(
  "поставка: те же 10 правил",
  [...presetsModule.RECOMMENDED_OFF].sort().join(",") === DELIVERY_OFF.join(","),
  presetsModule.RECOMMENDED_OFF.join(","),
);
check("поставка: включено 200 из 210", 210 - recommended.off.length === 200, 210 - recommended.off.length);
check("поставка: файл-первоисточник на месте", existsSync(join(here, "..", "lib", "bsl-checks", "presets", "recommended.md")));
console.log("конфигурация для анализатора");
const dumpCfg = syncResidentConfig({ dumpRoot: dump, off: [] });
check("конфиг пишется в корень выгрузки", existsSync(join(dump, RESIDENT_CONFIG_FILE)));
check(
  "конфиг включает правила, выключенные в анализаторе",
  dumpCfg.enabled.includes("TernaryOperatorUsage") && dumpCfg.enabled.every((code) => !enabledByDefault(code)),
);
check(
  "правило из off не включается",
  !syncResidentConfig({ dumpRoot: dump, off: ["TernaryOperatorUsage"] }).enabled.includes("TernaryOperatorUsage"),
);
const foreign = join(work, "foreign-dump");
mkdirSync(foreign, { recursive: true });
writeFileSync(join(foreign, RESIDENT_CONFIG_FILE), "[diagnostics.parameters]\n", "utf8");
const conflict = syncResidentConfig({ dumpRoot: foreign, off: [] });
check("чужой конфиг не перезаписывается", conflict.ok === false && typeof conflict.error === "string");
check(
  "чужой конфиг остался как был",
  readFileSync(join(foreign, RESIDENT_CONFIG_FILE), "utf8") === "[diagnostics.parameters]\n",
);
syncResidentConfig({ dumpRoot: dump, off: catalog().map((rule) => rule.code) });
check("нечего включать — файл убран", !existsSync(join(dump, RESIDENT_CONFIG_FILE)));

check(
  "поставка: все коды есть в каталоге",
  presetsModule.RECOMMENDED_OFF.every((code) => catalog().some((rule) => rule.code === code)),
);

const strict = presetsModule.resolvePreset("strict").preset;
check("строгий включает всё", strict.off.length === 0, strict.off.length);
const edited = presetsModule.editPreset({ id: "recommended", off: ["LineLength"] });
check("правка поставки создаёт копию", edited.ok && edited.preset.id !== "recommended", edited.preset && edited.preset.id);
check("поставка не изменилась", presetsModule.resolvePreset("recommended").preset.off.length === presetsModule.RECOMMENDED_OFF.length);
const removed = presetsModule.deletePreset(edited.preset.id);
check("удаление набора", removed.ok === true);
check("после удаления — откат на поставку", presetsModule.resolvePreset(edited.preset.id).fallback === true);
check("неизвестный набор даёт поставку", presetsModule.resolvePreset("нет-такого").preset.id === presetsModule.DEFAULT_PRESET_ID);

console.log("принятые замечания");
const findings = [
  { code: "MagicNumber", message: "Число", severity: "Major", line: 2, column: 6, path: "CommonModules/API/Ext/Module.bsl", snippet: "\tА = 1;" },
];
const markedBefore = markFindings(findings, loadAccepted(project)).findings;
const accepted = acceptFindings({ projectRoot: project, findings: markedBefore, by: "test", prunePaths: ["CommonModules/API/Ext/Module.bsl"] });
check("принятие записано", accepted.added === 1 && loadAccepted(project).items.length === 1, accepted.added + "/" + loadAccepted(project).items.length);
// Принятие по ключам приходит без находок: хранилище оно стирать не должно.
acceptFindings({ projectRoot: project, findings: [], keys: [markedBefore[0].key], by: "test" });
check("принятие по ключам не стирает хранилище", loadAccepted(project).items.length === 1, loadAccepted(project).items.length);

const shifted = [{ ...findings[0], line: 12 }];
const marked = markFindings(shifted, loadAccepted(project));
check("сдвиг строк не делает замечание новым", marked.findings[0].accepted === true);
check("ключ не содержит номера строки", findingKey(findings[0]) === findingKey(shifted[0]));
const changed = [{ ...findings[0], snippet: "\tА = 2;" }];
check("изменённая строка — новое замечание", markFindings(changed, loadAccepted(project)).findings[0].accepted === false);
const restored = restoreFindings({ projectRoot: project, all: true });
check("возврат всех", restored.removed === 1 && loadAccepted(project).items.length === 0, restored.removed);

console.log("параметры и конфиг");
check("по умолчанию проверки выключены", checksReady(project).enabled === false);
patchParams(project, { checksEnabled: true, checksPreset: "recommended" });
check("после галочки включены", checksReady(project).enabled === true);
check("параметры не теряют чужие поля", readParams(project).dumpDir === dump);
const configFile = writeConfig({ projectRoot: project, dumpRoot: dump, off: ["MissingSpace"] });
const config = readFileSync(configFile, "utf8");
check("файл конфига по ожидаемому пути", configFile === join(project, CONFIG_FILE), configFile);
check("справка платформы bundled", config.includes('source = "bundled"'));
check("путь выгрузки абсолютный", config.includes(dump.replace(/\\/g, "/")) || config.includes(dump));
check("выключенное правило в конфиге", config.includes("MissingSpace"));

console.log("роуты");
const handlers = new Map();
registerBslChecksRoutes({ webServer: { register: (route) => handlers.set(route.path, route.handler) } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  const handler = handlers.get(url.pathname);
  if (!handler) {
    res.writeHead(404).end("no route");
    return;
  }
  await handler(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/1cprops/bsl-checks";

const stateOn = await fetch(base + "/state?project=" + encodeURIComponent(project)).then((r) => r.json());
check("состояние отдаёт включённые проверки", stateOn.enabled === true);
check("состояние перечисляет наборы", Array.isArray(stateOn.presets) && stateOn.presets.length >= 2);
check("состояние знает про каталог", stateOn.catalog.total === 210, stateOn.catalog && stateOn.catalog.total);

const rules = await fetch(base + "/rules?project=" + encodeURIComponent(project)).then((r) => r.json());
check("каталог отдаётся с признаком включения", rules.ok && rules.rules.length === 210);
check("выключенное правило помечено", rules.rules.some((rule) => rule.code === "MissingSpace" && rule.on === false));

// Вкладка настроек работает без проекта: набор по id и общий список.
const rulesByPreset = await fetch(base + "/rules?presetId=recommended").then((r) => r.json());
check("правила читаются по набору без проекта", rulesByPreset.ok === true && rulesByPreset.presetId === "recommended");
const presetStore = await fetch(base + "/presets").then((r) => r.json());
check("список наборов без проекта", presetStore.ok === true && Array.isArray(presetStore.presets) && presetStore.presets.length >= 2);
check("без проекта нет признака выбранного набора", presetStore.presetId === undefined);

// Пропуск должен быть виден в панели сразу: отметки читаются из хранилища.
const skipOne = await fetch(base + "/accept", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    project,
    by: "user",
    findings: [{ path: "CommonModules/API/Ext/Module.bsl", code: "MagicNumber", severity: "Minor", message: "Магическое число", line: 4, column: 9 }],
  }),
}).then((r) => r.json());
check("пропуск записан", skipOne.ok !== false && skipOne.total >= 1, JSON.stringify(skipOne).slice(0, 120));
const storedKey = JSON.parse(readFileSync(join(project, ".dsh", "bsl-checks", "accepted.json"), "utf8")).items[0].k;
writeFileSync(
  join(project, ".dsh", "bsl-checks", "last.json"),
  JSON.stringify({
    checkedAt: "2026-11-05T09:00:00.000Z",
    dumpDir: dump,
    presetId: "recommended",
    counts: { total: 1 },
    files: [
      {
        path: "CommonModules/API/Ext/Module.bsl",
        findings: [{ key: storedKey, code: "MagicNumber", severity: "Minor", message: "Магическое число", line: 4, column: 9, accepted: false }],
      },
    ],
  }),
  "utf8",
);
const panelAfterSkip = await fetch(base + "/panel?project=" + encodeURIComponent(project)).then((r) => r.json());
const skippedFinding = ((panelAfterSkip.last && panelAfterSkip.last.files) || [])
  .flatMap((file) => file.findings || [])
  .find((finding) => finding.code === "MagicNumber" && finding.line === 4);
check("панель показывает пропущенное как пропущенное", skippedFinding && skippedFinding.accepted === true, JSON.stringify(skippedFinding || {}).slice(0, 140));
check("панель отдаёт имя набора", typeof panelAfterSkip.presetName === "string" && panelAfterSkip.presetName.length > 0);
// Убираем снимок прогона: следующий блок проверяет панель без прогона.
rmSync(join(project, ".dsh", "bsl-checks", "last.json"), { force: true });

console.log("наборы через роуты");
const created = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "create", base: "recommended", name: "Мой боевой" }),
}).then((r) => r.json());
check("копия создана и выбрана", created.ok && created.presetName === "Мой боевой" && created.presetId !== "recommended", created.presetName);

const renamed = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "rename", presetId: created.presetId, name: "Мой боевой 2" }),
}).then((r) => r.json());
check("свой набор переименован", renamed.ok && renamed.presetName === "Мой боевой 2", renamed.presetName);

const renameBuiltin = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "rename", presetId: "recommended", name: "Поставка" }),
}).then((r) => r.json());
check("набор поставки не переименовывается", renameBuiltin.ok === false, renameBuiltin.error);

const deleteBuiltin = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "delete", presetId: "strict" }),
}).then((r) => r.json());
check("набор поставки не удаляется", deleteBuiltin.ok === false, deleteBuiltin.error);

const deleted = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "delete", presetId: created.presetId }),
}).then((r) => r.json());
check("удаление используемого набора откатывает проект", deleted.ok && deleted.rolledBack === true && deleted.presetId === "recommended", deleted.presetId);

const selected = await fetch(base + "/preset", {
  method: "POST",
  body: JSON.stringify({ project, action: "select", presetId: "strict" }),
}).then((r) => r.json());
check("набор можно выбрать", selected.presetId === "strict");
await fetch(base + "/preset", { method: "POST", body: JSON.stringify({ project, action: "select", presetId: "recommended" }) });

const emptyFiles = await fetch(base + "/check", { method: "POST", body: JSON.stringify({ project }) }).then((r) => r.json());
check("пустой список файлов не запускает обход", emptyFiles.ok === false && /не указаны файлы/.test(emptyFiles.error), emptyFiles.error);

const panelEmpty = await fetch(base + "/panel?project=" + encodeURIComponent(project)).then((r) => r.json());
check("панель: проверок ещё не было", panelEmpty.ok && panelEmpty.last === null && panelEmpty.enabled === true);

// Хост пишет last.json после каждой проверки; панель читает его как есть.
mkdirSync(join(project, ".dsh", "bsl-checks"), { recursive: true });
writeFileSync(
  join(project, ".dsh", "bsl-checks", "last.json"),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    dumpDir: dump,
    counts: { total: 2, new: 1, accepted: 1, all: 2 },
    files: [{ path: "CommonModules/API/Ext/Module.bsl", passed: false, hidden: 0, findings: [] }],
  }),
  "utf8"
);
const panelFilled = await fetch(base + "/panel?project=" + encodeURIComponent(project)).then((r) => r.json());
check("панель: последний результат отдан", panelFilled.last && panelFilled.last.files.length === 1, JSON.stringify(panelFilled.last && panelFilled.last.counts));

patchParams(project, { checksEnabled: false });
const disabledState = await fetch(base + "/state?project=" + encodeURIComponent(project)).then((r) => r.json());
check("галочка снята — состояние выключено", disabledState.enabled === false);
const disabledCheck = await fetch(base + "/check", {
  method: "POST",
  body: JSON.stringify({ project, files: ["CommonModules/API/Ext/Module.bsl"] }),
}).then((r) => r.json());
check("проверка файлов без галочки отказана", disabledCheck.ok === false && /выключен/.test(disabledCheck.error), disabledCheck.error);
const disabledSnippet = await fetch(base + "/snippet", { method: "POST", body: JSON.stringify({ project, code: "Процедура А()\nКонецПроцедуры" }) }).then((r) => r.json());
check("проверка кода без галочки отказана", disabledSnippet.ok === false && /выключен/.test(disabledSnippet.error), disabledSnippet.error);
const disabledEngine = await fetch(base + "/engine", { method: "POST", body: JSON.stringify({ download: true, project }) }).then((r) => r.json());
check("движок не скачивается без галочки", disabledEngine.ok === false, disabledEngine.error);
server.close();

console.log("инструменты агента");
patchParams(project, { checksEnabled: true });
const mcp = await startChecksMcpServer({ projects: () => [{ path: project, name: "Проект" }] });
let rpcId = 0;
const rpc = async (method, params) => {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (response.status === 202) return null;
  return response.json();
};
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
check("MCP отвечает на initialize", init.result.serverInfo.name === "1c-bsl-checks", init.error);
const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((tool) => tool.name).sort();
check(
  "семь инструментов",
  names.join(",") ===
    "bsl_check_files,bsl_check_text,bsl_findings_pending,bsl_project_enable,bsl_projects_list,bsl_review,bsl_skip_findings",
  names.join(","),
);

patchParams(project, { checksEnabled: false });
const denied = await rpc("tools/call", { name: "bsl_check_files", arguments: { files: ["CommonModules/API/Ext/Module.bsl"] } });
check("инструменты уважают галочку", denied.result.structuredContent.error !== undefined, JSON.stringify(denied.result.structuredContent).slice(0, 120));
patchParams(project, { checksEnabled: true });

const noEngine = await rpc("tools/call", { name: "bsl_check_text", arguments: { code: "Процедура А()\nКонецПроцедуры", file: "CommonModules/API/Ext/Module.bsl" } });
check("без движка инструмент отказывает, а не врёт «чисто»", Boolean(noEngine.result.structuredContent.error), JSON.stringify(noEngine.result.structuredContent).slice(0, 120));
await mcp.close();

console.log("замечания последнего прогона");
const lastFile = join(project, ".dsh", "bsl-checks", "last.json");
writeFileSync(
  lastFile,
  JSON.stringify(
    {
      checkedAt: "2026-11-03T09:00:00.000Z",
      dumpDir: dump,
      presetId: "recommended",
      metadata: { symbolsAvailable: true, configurationXml: true, objects: 313, note: "" },
      counts: { total: 3, new: 2, accepted: 1, all: 3 },
      files: [
        {
          path: "CommonModules/API/Ext/Module.bsl",
          passed: false,
          hidden: 0,
          findings: [
            { key: "k-pending", code: "MagicNumber", severity: "Minor", message: "Магическое число", line: 4, column: 9, accepted: false },
            { key: "k-accepted-flag", code: "LineLength", severity: "Minor", message: "Длинная строка", line: 7, column: 1, accepted: true },
          ],
        },
        {
          path: "Documents/Заказ/Ext/ObjectModule.bsl",
          passed: false,
          hidden: 0,
          findings: [
            { key: "k-in-store", code: "BadWords", severity: "Major", message: "Запрещённое слово", line: 2, column: 5, accepted: false },
          ],
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
);
mkdirSync(join(project, ".dsh", "bsl-checks"), { recursive: true });
writeFileSync(
  join(project, ".dsh", "bsl-checks", "accepted.json"),
  JSON.stringify({ version: 1, items: [{ k: "k-in-store", code: "BadWords", path: "Documents/Заказ/Ext/ObjectModule.bsl", snippet: "", at: "", by: "test" }] }),
  "utf8",
);

const pendingServer = await startChecksMcpServer({ projects: () => [{ path: project, name: "Проект" }] });
let pendingId = 0;
const pendingRpc = async (method, params) => {
  const response = await fetch(pendingServer.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++pendingId, method, params }),
  });
  return response.status === 202 ? null : response.json();
};
await pendingRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const pendingAll = await pendingRpc("tools/call", { name: "bsl_findings_pending", arguments: {} });
const pendingPayload = pendingAll.result.structuredContent;
check("непринятое замечание одно", pendingPayload.ok === true && pendingPayload.counts.pending === 1, JSON.stringify(pendingPayload.counts));
check("принятая отметка не попадает", !(pendingPayload.findings || []).some((item) => item.key === "k-accepted-flag"));
check("принятое в хранилище не попадает", !(pendingPayload.findings || []).some((item) => item.key === "k-in-store"));
check("абсолютный путь собран", String((pendingPayload.findings[0] || {}).absolute || "").endsWith("Module.bsl"), (pendingPayload.findings[0] || {}).absolute);

const pendingFiltered = await pendingRpc("tools/call", {
  name: "bsl_findings_pending",
  arguments: { files: ["Documents/Заказ/Ext/ObjectModule.bsl"] },
});
check("фильтр по файлам работает", pendingFiltered.result.structuredContent.counts.pending === 0);

const noRun = join(work, "never-checked");
mkdirSync(join(noRun, ".dsh"), { recursive: true });
writeFileSync(join(noRun, ".dsh", "1c-project.json"), JSON.stringify({ checksEnabled: true, dumpDir: dump }), "utf8");
const noRunServer = await startChecksMcpServer({ projects: () => [{ path: noRun, name: "Пустой" }] });
let noRunId = 0;
const noRunRpc = async (method, params) => {
  const response = await fetch(noRunServer.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++noRunId, method, params }),
  });
  return response.status === 202 ? null : response.json();
};
await noRunRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const noRunAnswer = await noRunRpc("tools/call", { name: "bsl_findings_pending", arguments: {} });
check("без прогона код no_last_run", noRunAnswer.result.structuredContent.code === "no_last_run", JSON.stringify(noRunAnswer.result.structuredContent).slice(0, 140));
await noRunServer.close();
await pendingServer.close();

console.log("метаданные выгрузки");
const noConfig = metadataState({ dumpRoot: dump, stderr: "" });
check("без Configuration.xml символы считаются недоступными", noConfig.symbolsAvailable === false && noConfig.note.length > 0);
writeFileSync(join(dump, "Configuration.xml"), "<Configuration/>", "utf8");
check("с Configuration.xml символы доступны", metadataState({ dumpRoot: dump, stderr: "" }).symbolsAvailable === true);
check("metadata_objects=0 распознан", metadataObjects("WARN metadata_objects=0") === 0);
check(
  "движок без объектов метаданных считается ненадёжным",
  metadataState({ dumpRoot: dump, stderr: "metadata_objects=0" }).symbolsAvailable === false,
);
const noise = dropSymbolDependent([{ code: "UnresolvedField" }, { code: "MagicNumber" }, { code: "QueryToMissingMetadata" }]);
check("шум по символам снят", noise.findings.length === 1 && noise.dropped === 2, noise.dropped);

console.log("MCP: диагностика и управление проектом");
const emptyMcp = await startChecksMcpServer({ projects: () => [] });
let emptyId = 0;
const emptyRpc = async (method, params) => {
  const response = await fetch(emptyMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++emptyId, method, params }),
  });
  return response.status === 202 ? null : response.json();
};
await emptyRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const noProjects = await emptyRpc("tools/call", { name: "bsl_check_files", arguments: { files: ["a.bsl"] } });
check("пустой список проектов даёт код no_projects", noProjects.result.structuredContent.code === "no_projects", JSON.stringify(noProjects.result.structuredContent).slice(0, 160));
check("у отказа есть подсказка", String(noProjects.result.structuredContent.hint || "").length > 10);
const listEmpty = await emptyRpc("tools/call", { name: "bsl_projects_list", arguments: {} });
check("bsl_projects_list отвечает", listEmpty.result.structuredContent.ok === true);
await emptyMcp.close();

const fresh = join(work, "fresh");
mkdirSync(fresh, { recursive: true });
writeFileSync(join(fresh, "Configuration.xml"), "<Configuration/>", "utf8");
const manageMcp = await startChecksMcpServer({ projects: () => [] });
let manageId = 0;
const manageRpc = async (method, params) => {
  const response = await fetch(manageMcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++manageId, method, params }),
  });
  return response.status === 202 ? null : response.json();
};
await manageRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const enabledNew = await manageRpc("tools/call", { name: "bsl_project_enable", arguments: { project: fresh } });
const freshParams = JSON.parse(readFileSync(join(fresh, ".dsh", "1c-project.json"), "utf8"));
check("проект включается по пути без регистрации", enabledNew.result.structuredContent.ok === true && freshParams.checksEnabled === true, JSON.stringify(enabledNew.result.structuredContent).slice(0, 160));
check("выгрузка определена по Configuration.xml", freshParams.dumpDir === fresh, freshParams.dumpDir);
const engineMissing = await manageRpc("tools/call", { name: "bsl_check_files", arguments: { project: fresh, files: ["a.bsl"] } });
check("без движка код engine_missing", engineMissing.result.structuredContent.code === "engine_missing", JSON.stringify(engineMissing.result.structuredContent).slice(0, 160));
await manageMcp.close();

console.log("клиентская половина");
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
for (const marker of [
  "function ChecksCard(",
  "function ChecksRulesDialog(",
  "function SidebarChecksTab(", 
  "function installSidebarTab(",
  'children: "Создать"',
  "Наборы поставки неизменяемы",
  "jsx(ChecksRulesDialog,",
  "jsx(ChecksCard, { path: project.path })",
  "jsx(ChecksCard, { path: target.path })",
  "installSidebarTab(ctx);",
  "function ChecksSection(",
  'id: "1c-bsl-checks"',
  'label: () => "1С: Анализ кода"',
  "p1c-finding__pos",
  "p1c-finding__msg",
  'children: "Пропустить"',
  'children: "Пропустить все"',
  "p1c-root--panel",
  "p1c-sev--",
  "p1c-finding__skip",
  'children: "Вернуть все"',
  "p1c-panelhead",
  "Показать пропущенные (",
  "Ссылка на модуль в чат",
  "p1c-chevron",
  "p1c-filehead",
  "dsh-bsl-open-at",
  "p1c-finding__pos",
  "children: \"Перейти\"",
  "p1c-toast",
  "p1c-toast__pill",
  "Скопировано: ",
]) {
  check("client.js: " + marker, clientSource.includes(marker));
}

// Номер строки — текст, а не скрытая кнопка; «Перейти» есть всегда.
check("позиция замечания не выглядит кнопкой", !/p1c-finding__pos \{[^}]*cursor: pointer/.test(clientSource));
const perehod = clientSource.indexOf('onClick: () => openAt(absolute, finding.line');
check(
  "«Перейти» не спрятан за наличием onOpenFile",
  perehod > 0 && !clientSource.slice(perehod - 400, perehod).includes("props.onOpenFile ?"),
);
// Панель открывается раньше настроек: стили она должна подключить сама.
check(
  "client.js: панель инжектит стили",
  /function SidebarChecksTab\(props\) \{[\s\S]{0,1600}injectStyles\(\);/.test(clientSource),
);
check(
  "client.js: карточка инжектит стили",
  /function ChecksCard\(props\) \{[\s\S]{0,400}injectStyles\(\);/.test(clientSource),
);
// Классы новых экранов должны иметь правило в общем <style>, иначе вид поедет.
const cssBlock = clientSource.slice(clientSource.indexOf("const CSS = `"), clientSource.indexOf("`;", clientSource.indexOf("const CSS = `")));
for (const cls of ["p1c-check", "p1c-select", "p1c-input", "p1c-card", "p1c-row", "p1c-actions", "p1c-note", "p1c-stack", "p1c-dialog__body", "p1c-dialog__head", "p1c-dialog__footright", "p1c-finding", "p1c-finding__head", "p1c-finding__pos", "p1c-finding__code", "p1c-finding__msg", "p1c-finding__skip", "p1c-path", "p1c-note--warn", "p1c-sev", "p1c-root--panel"]) {
  check("стиль ." + cls, cssBlock.includes("." + cls));
}

if (existsSync(work)) rmSync(work, { recursive: true, force: true });

console.log(failures ? "\nпровалов: " + failures : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);
