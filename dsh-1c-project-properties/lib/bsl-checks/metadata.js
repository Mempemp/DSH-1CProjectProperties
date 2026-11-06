// Готовность метаданных выгрузки.
//
// Часть правил опирается на загруженную конфигурацию: без неё любой вызов
// «неизвестного метода» или обращение к справочнику становится находкой уровня
// Blocker, хотя объект существует. Движок в такой ситуации молчит (пишет WARN
// в stderr), поэтому решаем на своей стороне: если Configuration.xml нет или
// движок сообщил metadata_objects=0, находки, зависящие от символов, не
// показываем и говорим об этом прямо.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const SYMBOL_DEPENDENT = new Set([
  "UnresolvedField",
  "UnresolvedMethodCall",
  "UnresolvedName",
  "UnresolvedBareCall",
  "UnresolvedMetadataPath",
  "QueryToMissingMetadata",
  "UnknownTypeInNew",
  "TypeMismatch",
  "MismatchedArgCount",
  "MissingCommonModuleMethod",
  "ModuleAccessibility",
  "TransferringParametersBetweenClientAndServer",
]);

/** Есть ли в каталоге выгрузки корневой Configuration.xml. */
export function hasConfigurationXml(dumpRoot) {
  return Boolean(dumpRoot) && existsSync(join(dumpRoot, "Configuration.xml"));
}

/** Сколько объектов метаданных загрузил движок (null — не сообщил). */
export function metadataObjects(stderr) {
  const match = /metadata_objects=(\d+)/.exec(String(stderr || ""));
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Оценка доверия к прогону.
 *
 * @returns {{ symbolsAvailable: boolean, configurationXml: boolean, objects: number|null, note: string }}
 */
export function metadataState({ dumpRoot, stderr }) {
  const configurationXml = hasConfigurationXml(dumpRoot);
  const objects = metadataObjects(stderr);
  const symbolsAvailable = configurationXml && objects !== 0;
  let note = "";
  if (!configurationXml) {
    note =
      "В каталоге выгрузки нет Configuration.xml: конфигурация не разобрана, поэтому проверки имён, вызовов и запросов к метаданным пропущены.";
  } else if (objects === 0) {
    note =
      "Движок не загрузил объекты метаданных (metadata_objects=0): проверки имён, вызовов и запросов к метаданным пропущены.";
  }
  return { symbolsAvailable, configurationXml, objects, note };
}

/** Убрать находки, которым нужны символы, и посчитать, сколько убрали. */
export function dropSymbolDependent(findings) {
  const kept = [];
  let dropped = 0;
  for (const finding of findings) {
    if (SYMBOL_DEPENDENT.has(finding.code)) dropped += 1;
    else kept.push(finding);
  }
  return { findings: kept, dropped };
}
