import fs from "node:fs";

const root = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cli = JSON.parse(fs.readFileSync(new URL("../packages/agensis-cli/package.json", import.meta.url), "utf8"));
const published = JSON.parse(fs.readFileSync(new URL("../packages/agensis-agent/package.json", import.meta.url), "utf8"));
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../packages/agensis-cli/src/agensis.mjs", import.meta.url), "utf8");
const build = fs.readFileSync(new URL("../packages/agensis-agent/build.mjs", import.meta.url), "utf8");

const versions = new Map([
  ["root package", root.version],
  ["CLI package", cli.version],
  ["published package", published.version],
  ["lock root", lock.packages?.[""]?.version],
  ["lock CLI workspace", lock.packages?.["packages/agensis-cli"]?.version],
  ["lock published workspace", lock.packages?.["packages/agensis-agent"]?.version],
  ["AGENSIS_CLI_VERSION", source.match(/AGENSIS_CLI_VERSION\s*=\s*"([^"]+)"/)?.[1]],
  ["SOURCE_VERSION", build.match(/SOURCE_VERSION\s*=\s*["']([^"']+)["']/)?.[1]],
]);

const mismatches = [...versions].filter(([, value]) => value !== root.version);
if (mismatches.length) {
  for (const [name, value] of mismatches) {
    process.stderr.write(`${name}: expected ${root.version}, found ${value ?? "missing"}\n`);
  }
  process.exit(1);
}
process.stdout.write(`All release versions match ${root.version}\n`);
