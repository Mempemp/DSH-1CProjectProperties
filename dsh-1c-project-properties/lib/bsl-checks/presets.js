// Наборы правил проверки кода.
//
// Наборы поставки неизменяемы: каталог правил приезжает из движка и меняется с
// его версией, а правка поставки после обновления терялась бы молча. Первая
// правка делает копию набора и переключает на неё проект — дальше правки идут
// в копию и действуют на все проекты, которые на неё ссылаются.
//
// Проект хранит только имя набора (checksPreset в .dsh/1c-project.json).
// Копий правил в проекте нет, поэтому «отличий проекта от набора» не бывает.
//
// Свои наборы лежат в $DSH_HOME/1c-bsl-checks/presets.json и общие для машины.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { catalog } from "./catalog.js";

// Состав поставки согласован с заказчиком 03.11.2026 и зафиксирован файлом
// lib/bsl-checks/presets/recommended.md. Выключено десять правил: типографика
// вроде пробелов и канонического написания, запрещённые слова, проверки
// АвтоТест и мультиязычности, Unix-специфика. Всё остальное включено, порог
// показа — «всё»: набор задуман как полный, а не как «важное и выше».
export const RECOMMENDED_OFF = [
  "CanonicalSpellingKeywords",
  "MissingSpace",
  "SpaceAtStartComment",
  "EmptyRegion",
  "CodeOutOfRegion",
  "BadWords",
  "ExcessiveAutoTestCheck",
  "MultilingualStringHasAllDeclaredLanguages",
  "MultilingualStringUsingWithTemplate",
  "UsingObjectNotAvailableUnix",
];

export const BUILTIN_PRESETS = [
  {
    id: "recommended",
    name: "Рекомендуемый",
    off: RECOMMENDED_OFF,
    builtin: true,
  },
  {
    id: "strict",
    name: "Строгий",
    off: [],
    builtin: true,
  },
];

export const DEFAULT_PRESET_ID = "recommended";

const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : join(homedir(), ".dsh");
})();

const STORE_FILE = join(DSH_HOME, "1c-bsl-checks", "presets.json");

function readStore() {
  if (!existsSync(STORE_FILE)) return { version: 1, presets: [] };
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    const presets = Array.isArray(raw?.presets)
      ? raw.presets.map(normalizeCustom).filter(Boolean)
      : [];
    return { version: 1, presets };
  } catch {
    // Битый файл не отменяет проверки: свои наборы теряются, проекты
    // откатываются на поставку, а причина видна в списке пресетов.
    return { version: 1, presets: [], error: "файл своих наборов не прочитан" };
  }
}

// Набор без порога или со списком не того типа — не повод терять остальные:
// дополняем недостающее значениями по умолчанию. Так старая версия файла или
// правка руками не стирает наборы молча.
function normalizeCustom(item) {
  if (!item || typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    ...item,
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Мой набор",
    off: Array.isArray(item.off) ? item.off.filter((code) => typeof code === "string") : [],
  };
}

function writeStore(store) {
  mkdirSync(join(STORE_FILE, ".."), { recursive: true });
  // Копия предыдущего состояния: свои наборы дороже одного лишнего файла.
  if (existsSync(STORE_FILE)) {
    try {
      writeFileSync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
    } catch {}
  }
  const tmp = STORE_FILE + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify({ version: 1, presets: store.presets }, null, 2) + "\n", "utf8");
  renameSync(tmp, STORE_FILE);
}

export function listPresets() {
  const store = readStore();
  return {
    presets: [
      ...BUILTIN_PRESETS.map((preset) => ({ ...preset, off: [...preset.off] })),
      ...store.presets.map((preset) => ({ ...preset, builtin: false, off: [...preset.off] })),
    ],
    error: store.error || "",
  };
}

/** Набор по имени; неизвестное имя даёт поставку и признак подмены. */
export function resolvePreset(id) {
  const wanted = typeof id === "string" ? id.trim() : "";
  const { presets } = listPresets();
  const found = presets.find((preset) => preset.id === wanted);
  if (found) return { preset: found, fallback: false };
  const fallback = presets.find((preset) => preset.id === DEFAULT_PRESET_ID);
  return { preset: fallback, fallback: Boolean(wanted) };
}

/** Код правила -> включено ли оно в наборе. */
export function ruleStates(preset) {
  const off = new Set(preset.off);
  const states = new Map();
  for (const rule of catalog()) states.set(rule.code, !off.has(rule.code));
  return states;
}

export function enabledCount(preset) {
  const off = new Set(preset.off);
  return catalog().filter((rule) => !off.has(rule.code)).length;
}

// Правка набора поставки превращается в копию: возвращаем id, на который
// должен переключиться проект.
export function editPreset({ id, name, off }) {
  const builtin = BUILTIN_PRESETS.find((preset) => preset.id === id);
  if (builtin) {
    return createPreset({
      name: name || builtin.name + " (мой)",
      off: Array.isArray(off) ? off : builtin.off,
      base: builtin.id,
    });
  }
  const store = readStore();
  const index = store.presets.findIndex((preset) => preset.id === id);
  if (index < 0) return { ok: false, error: "набор не найден" };
  const next = {
    ...store.presets[index],
    name: typeof name === "string" && name.trim() ? name.trim() : store.presets[index].name,
    off: Array.isArray(off) ? off : store.presets[index].off,
    updatedAt: new Date().toISOString(),
  };
  store.presets[index] = next;
  writeStore(store);
  return { ok: true, preset: next };
}

export function createPreset({ name, off, base }) {
  const store = readStore();
  const id = "own-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const preset = {
    id,
    name: typeof name === "string" && name.trim() ? name.trim() : "Мой набор",
    off: Array.isArray(off) ? off : [],
    base: typeof base === "string" ? base : "",
    createdAt: new Date().toISOString(),
  };
  store.presets.push(preset);
  writeStore(store);
  return { ok: true, preset };
}

/** Переименовать свой набор. Набор поставки не переименовывается — его правят копией. */
export function renamePreset(id, name) {
  const wanted = typeof name === "string" ? name.trim() : "";
  if (!wanted) return { ok: false, error: "название пустое" };
  if (BUILTIN_PRESETS.some((preset) => preset.id === id)) {
    return { ok: false, error: "набор поставки не переименовывается" };
  }
  return editPreset({ id, name: wanted });
}

export function deletePreset(id) {
  const builtin = BUILTIN_PRESETS.find((preset) => preset.id === id);
  if (builtin) return { ok: false, error: "набор поставки удалить нельзя" };
  const store = readStore();
  const before = store.presets.length;
  store.presets = store.presets.filter((preset) => preset.id !== id);
  if (store.presets.length === before) return { ok: false, error: "набор не найден" };
  writeStore(store);
  // Проекты, ссылавшиеся на набор, при следующем чтении получат поставку —
  // об этом сообщает resolvePreset(...).fallback.
  return { ok: true };
}

export function presetsFile() {
  return STORE_FILE;
}
