/**
 * 闭包漂移硬检查（ci-check 兜底）：逐文件比对主仓 app/src 与引擎仓 src 的 MANIFEST 闭包。
 * 不依赖工作区干净——sync-sentinel 的闭包检查在主仓脏时跳过，此脚本兜底该盲区
 * （历史教训：2026-09-17 漏同步事故；2026-09-29 八包批次漏 cut，手工比对才发现）。
 *
 * 用法：npx tsx scripts/closure-diff.mts
 * 退出码：0 一致 / 1 漂移（提示须当轮 cut → engine lint/test → sync）
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainAppSrc = path.resolve(engineRoot, "../../app/src");
const engineSrc = path.resolve(engineRoot, "src");

const cutSrc = fs.readFileSync(path.join(engineRoot, "scripts", "cut-engine.mts"), "utf-8");
const manifestStart = cutSrc.indexOf("const MANIFEST");
const manifestBlock = cutSrc.slice(manifestStart, cutSrc.indexOf("];", manifestStart));
const manifest = [...manifestBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
// OVERRIDES 键（如 utils/db.ts 注入层）：引擎侧重写文件，不参与比对
const overrides = [...cutSrc.slice(cutSrc.indexOf("const OVERRIDES")).matchAll(/^\s*"([^"]+)":\s*`/gm)].map((m) => m[1]);

const drift: string[] = [];
let checked = 0;
for (const rel of manifest) {
  if (overrides.includes(rel)) continue;
  const a = path.join(mainAppSrc, rel);
  const b = path.join(engineSrc, rel);
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    drift.push(`${rel}: 缺文件（主仓 ${fs.existsSync(a) ? "有" : "无"} / 引擎 ${fs.existsSync(b) ? "有" : "无"}）`);
    continue;
  }
  checked++;
  if (fs.readFileSync(a, "utf-8") !== fs.readFileSync(b, "utf-8")) drift.push(rel);
}

if (drift.length) {
  console.error(`[closure-diff] 闭包漂移 ${drift.length} 处（须当轮 cut → engine lint/test → sync）:`);
  drift.forEach((d) => console.error(`  - ${d}`));
  process.exit(1);
}
console.log(`[closure-diff] 闭包一致（比对 ${checked}/${manifest.length} 文件，OVERRIDES 跳过 ${overrides.length}）`);
