import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureConfigDir = path.resolve("config", "test-fixtures");
for (const fixture of ["test-fixtures.js", "recovery-fixtures.js", "http-security-fixtures.js"]) {
  const result = spawnSync(process.execPath, [path.resolve("dist", fixture)], {
    stdio: "inherit",
    env: { ...process.env, DOUYIN_PRIVATE_CONFIG_DIR: fixtureConfigDir },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const setupConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-setup-fixtures-"));
try {
  const result = spawnSync(process.execPath, [path.resolve("dist", "setup-config-fixtures.js")], {
    stdio: "inherit",
    env: { ...process.env, DOUYIN_PRIVATE_CONFIG_DIR: setupConfigDir },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  fs.rmSync(setupConfigDir, { recursive: true, force: true });
}
