#!/usr/bin/env node
// Переносит доменные правила comol в reference/comol дословно, без пересказа.
//
// Что берём: весь content/rules, кроме правил их рабочего процесса (см. SKIP).
// Плюс две справки по запросам: в них почти нет привязки к инструментам comol.
// Всё остальное дерево (DSL-спеки, мануалы MCP-инструментов, openspec) не берём.
//
//   node tools/port-comol-reference.mjs --from <архив.zip|каталог репозитория>
//   node tools/port-comol-reference.mjs --check   # только отчёт, без записи
//
// Архив по умолчанию ищется в кэше каталога сборки.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const PIN = "18e3383da1e436ef980440503ae590da9b8722bf";
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "reference", "comol");

/** Берём целиком. */
const INCLUDE_DIRS = ["content/rules/"];
const INCLUDE_FILES = [
  "content/skills/1c-metadata-manage/docs/query-writing.md",
  "content/skills/1c-metadata-manage/docs/query-optimization.md",
];

/**
 * Не берём, хотя лежит рядом с правилами. Причина у каждой группы своя.
 * Новое имя здесь — повод решить, правило это про 1С или про их процесс.
 */
const SKIP = {
  // инструкции под конкретные модели
  "model-adaptation.md": "модель",
  "model-fable5.md": "модель",
  "model-gpt6.md": "модель",
  "model-opus5.md": "модель",
  "model-sonnet5.md": "модель",
  "model-gpt56.md": "модель",
  // их схема делегирования и роли
  "subagents.md": "процесс",
  "subagent-core.md": "процесс",
  "subagent-pipeline.md": "процесс",
  "orchestrator-economy.md": "процесс",
  // их приёмка и отчётность
  "verification-gates.md": "процесс",
  "verification-policy.md": "процесс",
  "verification-delivery.md": "процесс",
  // их MCP-серверы и политика инструментов
  "mcp-policy.md": "их mcp",
  "mcp-deployment.md": "их mcp",
  "mcp-first-search.md": "их mcp",
  "tool-policy.md": "их mcp",
  "tooling-playbooks.md": "их mcp",
  // процесс вокруг задачи и памяти
  "sdd-integrations.md": "процесс",
  "support-feedback.md": "процесс",
  "project-memory.md": "процесс",
  "memory-setup.md": "процесс",
  // их соглашение о параметрах проекта (.dev.env); у нас .dsh/1c-project.json
  "dev-standards-env.md": "их соглашение",
};

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

function defaultSource() {
  const cache = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "dsh-1c-catalog", "downloads");
  if (!existsSync(cache)) return "";
  const hit = readdirSync(cache).find((name) => name.startsWith("comol-ai_rules_1c-") && name.endsWith(".zip"));
  return hit ? join(cache, hit) : "";
}

/** Чтение zip без зависимостей: только stored/deflate, что и отдаёт GitHub. */
function readZip(file) {
  const buffer = readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("не нашёл конец центрального каталога: файл повреждён или это не zip");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("битая запись центрального каталога");
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith(".md")) continue;
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8"));
  }
  return files;
}

function readDirectory(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.set(full.slice(root.length + 1).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return files;
}

function sourceFiles(source) {
  // В архиве GitHub всё лежит под <репозиторий>-<коммит>/, в каталоге — без префикса.
  const cut = (name) => (name.includes("content/") ? name.slice(name.indexOf("content/")) : name);
  const all = statSync(source).isDirectory() ? readDirectory(source) : readZip(source);
  const out = new Map();
  for (const [name, text] of all) out.set(cut(name), text);
  return out;
}

function flatName(rel) {
  return rel
    .replace(/^content\/rules\//u, "")
    .replace(/^content\/skills\/1c-metadata-manage\/docs\//u, "query-");
}

function main() {
  const check = process.argv.includes("--check");
  const source = arg("--from") || defaultSource();
  if (!source || !existsSync(source)) {
    console.error("нет источника: передайте --from <архив.zip|каталог> (кэш каталога пуст)");
    process.exit(2);
  }
  const files = sourceFiles(source);
  const picked = new Map();
  const skipped = [];
  for (const [rel, text] of [...files].sort()) {
    const name = basename(rel);
    if (name in SKIP) {
      skipped.push(name);
      continue;
    }
    if (INCLUDE_DIRS.some((dir) => rel.startsWith(dir)) || INCLUDE_FILES.includes(rel)) picked.set(rel, text);
  }

  const written = [];
  const unchanged = [];
  const removed = [];
  for (const [rel, text] of picked) {
    const target = flatName(rel);
    const body = [
      `<!-- источник: comol/ai_rules_1c @ ${PIN} · ${rel} · дословно, без правок -->`,
      "",
      text.replace(/\r\n/gu, "\n").replace(/\n*$/u, "\n"),
    ].join("\n");
    const file = join(OUT_DIR, target);
    if (existsSync(file) && readFileSync(file, "utf8") === body) unchanged.push(target);
    else {
      written.push(target);
      if (!check) {
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(file, body, "utf8");
      }
    }
  }
  if (existsSync(OUT_DIR)) {
    const known = new Set([...picked].map(([rel]) => flatName(rel)));
    for (const name of readdirSync(OUT_DIR)) {
      if (!known.has(name)) {
        removed.push(name);
        if (!check) unlinkSync(join(OUT_DIR, name));
      }
    }
  }

  const lines = picked.size ? [...picked.values()].map((text) => text.split("\n").length) : [0];
  const digest = createHash("sha256");
  for (const [rel, text] of picked) digest.update(rel).update(text);

  console.log(`источник: ${source}`);
  console.log(`взято: ${picked.size} файлов, ${lines.reduce((a, b) => a + b, 0)} строк, ${new Set([...picked.values()].map((t) => createHash("sha256").update(t).digest("hex"))).size} уникальных`);
  console.log(`записано: ${written.length}, без изменений: ${unchanged.length}, удалено: ${removed.length}`);
  if (removed.length) console.log("  удалено: " + removed.join(", "));
  console.log(`исключено по списку: ${skipped.length} — ${[...new Set(Object.values(SKIP))].join(", ")}`);
  console.log(`отпечаток набора: ${digest.digest("hex").slice(0, 16)}`);
  const unknown = [...files.keys()].filter(
    (rel) => rel.startsWith("content/rules/") && !(basename(rel) in SKIP) && !picked.has(rel),
  );
  console.log(unknown.length ? "новые файлы в content/rules (решить, брать ли): " + unknown.join(", ") : "новых файлов в content/rules нет");
  console.log(check ? "режим --check: ничего не записано" : `записано в ${OUT_DIR}`);
}

main();
