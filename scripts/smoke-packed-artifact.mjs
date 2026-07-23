import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const packageDir = path.join(repo, "packages", "agensis-agent");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agensis-agent-pack-"));
const prefix = path.join(temp, "install");

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
    cwd: packageDir,
    encoding: "utf8",
  }));
  const tarball = path.join(temp, packed[0].filename);
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", prefix, tarball], { stdio: "pipe" });
  const binDir = path.join(prefix, "node_modules", ".bin");
  const expected = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
  for (const command of ["agensis", "agensis-agent"]) {
    const bin = path.join(binDir, command);
    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    if (version !== expected) throw new Error(`${command} reported ${version}, expected ${expected}`);
    const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
    if (!help.includes("agensis agent daemon")) throw new Error(`${command} help output was invalid`);
  }
  process.stdout.write(`Packed artifact smoke passed for ${expected}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
