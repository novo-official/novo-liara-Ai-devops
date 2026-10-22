/* npm run demo:zip — packs the repository-owned demo fixture into a ZIP (dist-demo/liara-agent-demo.zip) for the future controlled deployment.
 * Offline, deterministic (sorted entries), reads only fixtures/demo-app, executes nothing. */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildZip } from "../tests/helpers/zip";

const ROOT = path.resolve("fixtures/demo-app");
const SKIP = new Set(["node_modules", ".next"]);
function walk(dir: string, rel = ""): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p, rel ? `${rel}/${n}` : n) : [rel ? `${rel}/${n}` : n];
  });
}
const files = walk(ROOT).sort();
const zip = buildZip(files.map((f) => ({ name: f, data: readFileSync(path.join(ROOT, f)) })));
mkdirSync("dist-demo", { recursive: true });
writeFileSync("dist-demo/liara-agent-demo.zip", zip);
process.stdout.write(`files: ${files.length}\nbytes: ${zip.length}\nsha256: ${createHash("sha256").update(zip).digest("hex")}\n`);
