// Движок проверок берётся из раскатки установщика ($DSH_HOME/bsl-analyzer) раньше кеша
// загрузок — и только после сверки байтов. Проверка держит три вещи, которые тихо ломаются:
// путь в домашнем каталоге, отказ на чужих байтах и приоритет явного пути из настроек.
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(pathToFileURL(join(here, "..", "lib", "bsl-checks", "engine.js")).href);

const asset = engine.assetFor();
if (!asset) {
  console.log("ПРОПУСК: на этой платформе сборка движка не закреплена");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "bsl-engine-"));
process.env.DSH_HOME = root;
process.env.DSH_BSL_CHECKER_DIR = join(root, "cache");
delete process.env.DSH_BSL_CHECKER_BIN;
delete process.env.DSH_BSL_CHECKER_NO_DOWNLOAD;

let failed = 0;
const check = (name, ok, extra) => {
  if (!ok) {
    failed += 1;
    console.log("FAIL  " + name + (extra ? "  — " + extra : ""));
  } else {
    console.log("PASS  " + name);
  }
};

try {
  check("без файлов движка нет", engine.resolveBinary() === "");
  check("состояние это подтверждает", engine.engineStatus().downloaded === false);

  mkdirSync(join(root, "bsl-analyzer"), { recursive: true });
  const shipped = join(root, "bsl-analyzer", asset.name);
  writeFileSync(shipped, "не тот файл");
  check("чужие байты в поставке отвергаются", engine.resolveBinary() === "");
  check("поставка не считается готовой", engine.engineStatus().shipped === false);

  const explicit = join(root, "explicit.exe");
  writeFileSync(explicit, "явный путь");
  process.env.DSH_BSL_CHECKER_BIN = explicit;
  check("явный путь из настроек главнее", engine.resolveBinary() === explicit);
  delete process.env.DSH_BSL_CHECKER_BIN;

  // Настоящий закреплённый бинарник: если он уже лежит в кеше машины, сверяем приоритет.
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, asset.binary), "мусор в кеше");
  check("мусор в кеше тоже отвергается", engine.resolveBinary() === "");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.log("провалено проверок: " + failed);
  process.exit(1);
}
console.log("все проверки пройдены");
