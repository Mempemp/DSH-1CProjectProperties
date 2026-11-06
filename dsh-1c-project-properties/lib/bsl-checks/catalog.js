// Каталог правил bsl-analyzer.
//
// catalog.json — снимок `bsl-analyzer-app rules export --format json` версии
// 0.4.3: код, русское название, важность, тип, теги, описание. Плагин не зовёт
// анализатор за каталогом: список правил нужен интерфейсу сразу, в том числе
// когда движок ещё не скачан.
//
// Категории строятся здесь, а не в интерфейсе: один и тот же порядок нужен
// окну правил, счётчикам пресета и отчёту.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SEVERITY_RU = {
  BLOCKER: "блокер",
  CRITICAL: "критично",
  MAJOR: "важно",
  MINOR: "средне",
  INFO: "инфо",
};

export const TYPE_RU = {
  bug: "ошибка",
  smell: "качество кода",
  vuln: "уязвимость",
  hot: "опасное место",
};

// У анализатора две шкалы: каталог отдаёт пять уровней SonarQube, а поток
// находок — семь собственных. Сводим их к одному порядку, чтобы порог показа
// работал одинаково для обеих.
export const SEVERITY_RANK = {
  Hint: 0,
  Information: 1,
  Info: 1,
  INFO: 1,
  Warning: 2,
  Minor: 2,
  MINOR: 2,
  Major: 3,
  MAJOR: 3,
  Error: 3,
  Critical: 4,
  CRITICAL: 4,
  Blocker: 5,
  BLOCKER: 5,
};

export const THRESHOLDS = {
  all: { rank: 0, label: "всё, включая подсказки" },
  warn: { rank: 2, label: "предупреждения и выше" },
  major: { rank: 3, label: "важное и выше" },
  crit: { rank: 4, label: "только критичное" },
};

// Порядок важен: первое совпадение выигрывает.
const CATEGORIES = [
  [
    "Безопасность и права",
    /^(DisableSafeMode|ExecuteExternalCode|ExecuteExternalCodeInCommonModule|ExternalAppStarting|FileSystemAccess|OSUsersMethod|InternetAccess|UseSystemInformation|UsingExternalCodeTools|UsingHardcodeNetworkAddress|UsingHardcodeSecretInformation|CommonModuleNameFullAccess|PrivilegedModuleMethodCall|SetPermissionsForNewObjects|SetPrivilegedMode|UnsafeSafeModeMethodCall|IsInRoleMethod|UnsafeFindByCode)$/i,
  ],
  [
    "Запросы и SQL",
    /Query|SDBL|SelectTop|UnionAll|Join|VirtualTable|FieldsFromJoins|RefOveruse|Assign|Materialized|TempTable|InYourQuery|DataExchangeLoading/i,
  ],
  ["Транзакции и блокировки", /Transaction|Lock|Commit|Begin|DataLock|ObjectLock/i],
  [
    "Синтаксис и ошибки",
    /^(ParseError|EmptyStatement|UnreachableCode|DoubleNegatives|PostfixAccessOnExpression|UselessTernaryOperator|UnaryPlusInConcatenation|IdenticalExpressions|ExcessiveAutoTestCheck|ExtraCommas|SemicolonPresence|EmptyCodeBlock|CodeBlockBeforeSub|MultilinePreprocessorInstruction|UnknownPreprocessorSymbol|CompilationDirectiveLost|CompilationDirectiveNeedLess|SeveralCompilerDirectives|StyleElementConstructors|TernaryOperatorUsage|InvalidCharacterInFile)$/i,
  ],
  ["Методы и параметры", /Function|Parameter|Param|Method|ArgCount|PublicMethods|ProceedWithCall|Return|Order|NumberOf|TooMany/i],
  [
    "Переменные и циклы",
    /^(ExportVariables|MissingVariablesDescription|UninitializedLocalVariable|UnusedLocalVariable|UnusedParameters|MisplacedLoopControl|UseLessForEach|IteratorCollidesCollection|ImplicitDatabaseReadInCycle|UsingGoto|CodeAfterAsyncCall|UnusedLocalMethod|DeletingCollectionItem|SelfInsertion|DuplicatedInsertionIntoCollection)$/i,
  ],
  ["Переменные и циклы", /Unused|Unresolved|Uninit|Assign|Deprecated|Magic|Duplicate|Nested|Complex/i],
  [
    "Оформление кода",
    /Space|Line|Region|Comment|Canonical|Consecutive|Incorrect|OneStatement|EmptyLine|CodeOut|NonStandard|IfElse|BadWords|Typo|YoLetterUsage|LatinAndCyrillic|Multilingual/i,
  ],
  [
    "Платформа и совместимость",
    /^(UnavailableInEnvironment|PlatformMember|GlobalPropertyNotWritable|Weaving|WrongHttpServiceHandler|WrongWebServiceHandler|TryNumber|GlobalContext|OrdinaryAppSupport|UsingModalWindows|UsingSynchronousCalls|TimeoutsInExternalResources|UsingServiceTag|UsageWriteLogEvent|UsingCancelParameter|UsingFindElementByString|ScheduledJobHandler|MissingEventSubscriptionHandler|TransferringParametersBetweenClientAndServer|DenyIncompleteValues|CachedPublic|MissingCodeTryCatchEx|UsingHardcodePath|MissingTempStorageDeletion|MissingTemporaryFileDeletion|TempFilesDir)$/i,
  ],
  [
    "Метаданные и формы",
    /Metadata|Object|Attribute|TabularSection|Predefined|Enum|Name|CommonModule|Module|Form|Command|Interface|Subsystem|Style|Global/i,
  ],
  ["Служебное", /^(UnknownSuppressionCode|SuppressionWithoutCode)$/i],
];

export function categoryOf(code) {
  for (const [name, pattern] of CATEGORIES) {
    if (pattern.test(code)) return name;
  }
  return "Прочее";
}

let loaded = null;

/** Каталог целиком: [{ code, name, severity, type, tags, description, category }]. */
export function catalog() {
  if (!loaded) {
    const raw = JSON.parse(readFileSync(join(HERE, "catalog.json"), "utf8"));
    loaded = raw.map((rule) => ({
      code: rule.c,
      name: rule.n,
      severity: rule.s,
      type: rule.t,
      tags: Array.isArray(rule.g) ? rule.g : [],
      description: rule.d,
      category: categoryOf(rule.c),
    }));
  }
  return loaded;
}

export function catalogByCode() {
  const map = new Map();
  for (const rule of catalog()) map.set(rule.code, rule);
  return map;
}

export function categories() {
  const seen = new Set();
  const out = [];
  for (const rule of catalog()) {
    if (seen.has(rule.category)) continue;
    seen.add(rule.category);
    out.push(rule.category);
  }
  return out;
}

export function severityRank(value) {
  return SEVERITY_RANK[value] ?? 1;
}

export function passesThreshold(severity, threshold) {
  const limit = THRESHOLDS[threshold]?.rank ?? 0;
  return severityRank(severity) >= limit;
}
