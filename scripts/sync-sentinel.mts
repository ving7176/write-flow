/**
 * 引擎双站同步哨兵（漂移巡检，与 sync 的写操作编排互补）：
 * ① 双站远端 main hash 一致性（漏推单站 / 本地与远端分叉）——git ls-remote 只读探测，不 fetch；
 * ② 主仓引擎闭包 vs 引擎仓切割产物漂移——仅主仓+引擎仓都干净时执行 yarn cut 检测，
 *    检测完按 cut 写入范围还原（与 sync-engine 同一安全论证：起点干净，还原不覆盖手工改动）；
 * ③ --notify 时告警走 macOS 本地通知（osascript），默认仅控制台输出。
 *
 * 用法：yarn sentinel [--notify]（packages/qiflow-engine 目录内执行）
 * 退出码：0 一致无漂移；1 存在漂移；2 环境异常（站点不可达，检测不完整）
 */
import { execFileSync } from "child_process";
import path from "path";
import { collectPushUrls, isClean, parseLsRemote } from "./sync-engine-lib";
import { classifyRemotes, RemoteHash } from "./sentinel-lib";

const HERE = import.meta.dirname ?? ".";
const ENGINE_ROOT = path.resolve(HERE, "..");
const MAIN_REPO = path.resolve(HERE, "../..");
/** cut 的全部写入路径（与 sync-engine 一致；检测后按此范围还原） */
const CUT_PATHS = "src data/skills sql";
/** 单站点探测超时：无人值守运行不能被挂起的 ssh 卡死 */
const PROBE_TIMEOUT_MS = 30_000;

function run(cmd: string, cwd: string): string {
  return execFileSync(cmd, {
    shell: true,
    cwd,
    encoding: "utf-8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runLive(cmd: string, cwd: string): void {
  execFileSync(cmd, { shell: true, cwd, stdio: "inherit" });
}

/** 失败返回 null 并附原因（远端探测、未配置 pushurl 等属预期失败，不中断哨兵） */
function tryRun(cmd: string, cwd: string): string | null {
  try {
    return run(cmd, cwd).trim();
  } catch (err) {
    return null;
  }
}

function probeRemote(url: string): { hash: string | null; error?: string } {
  try {
    const out = execFileSync("git", ["ls-remote", url, "main"], {
      encoding: "utf-8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { hash: parseLsRemote(out) };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { hash: null, error: msg };
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

function notifyMacOS(message: string): void {
  try {
    execFileSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title "WriteFlow sync 哨兵"`,
    ]);
  } catch {
    console.error("[sentinel] 本地通知发送失败（不影响退出码）");
  }
}

function main(): void {
  const notify = process.argv.includes("--notify");
  const alarms: string[] = [];
  const notes: string[] = [];

  // ① 双站远端一致性
  const localMain = tryRun("git rev-parse main", ENGINE_ROOT);
  const fetchUrl = tryRun("git remote get-url origin", ENGINE_ROOT);
  const pushUrls = tryRun("git config --get-all remote.origin.pushurl", ENGINE_ROOT)
    ?.split("\n")
    .filter(Boolean) ?? [];
  if (!fetchUrl) {
    console.error("[sentinel] 环境异常：引擎仓 origin 未配置（exit 2）");
    process.exit(2);
  }
  const urls = collectPushUrls(fetchUrl, pushUrls);

  const probed: RemoteHash[] = [];
  const unreachables: string[] = [];
  for (const url of urls) {
    const r = probeRemote(url);
    if (r.error) unreachables.push(`${url}（${r.error}）`);
    else probed.push({ url, hash: r.hash });
  }
  if (unreachables.length) {
    console.error(`[sentinel] 环境异常，站点探测不完整（exit 2）：\n${indent(unreachables.join("\n"))}`);
    process.exit(2);
  }
  const verdict = classifyRemotes(localMain, probed);
  console.log(`[sentinel] ① 双站一致性：${verdict.message}`);
  if (verdict.status !== "consistent") alarms.push(`双站一致性：${verdict.message}`);

  // ② 主仓引擎闭包漂移（仅双仓干净时执行 cut）
  const mainClean = isClean(tryRun("git status --porcelain", MAIN_REPO) ?? "dirty");
  const engineClean = isClean(tryRun("git status --porcelain", ENGINE_ROOT) ?? "dirty");
  if (!mainClean || !engineClean) {
    notes.push("② 闭包漂移检查跳过：主仓/引擎仓工作区非干净（开发常态，非漂移）");
  } else {
    runLive("yarn cut", ENGINE_ROOT);
    const afterCut = run("git status --porcelain", ENGINE_ROOT);
    if (isClean(afterCut)) {
      notes.push("② 闭包无漂移：主仓引擎闭包与引擎仓切割产物一致");
    } else {
      alarms.push(`主仓引擎闭包有未同步变更（待执行 yarn sync）：\n${indent(afterCut.trim())}`);
      run(`git checkout -- ${CUT_PATHS}`, ENGINE_ROOT);
      notes.push("② 切割产物已还原，引擎仓保持干净");
    }
  }

  for (const n of notes) console.log(`[sentinel] ${n}`);
  if (alarms.length) {
    console.error(`[sentinel] 结论：发现 ${alarms.length} 项漂移（exit 1）\n- ${alarms.join("\n- ")}`);
    if (notify) notifyMacOS(`发现 ${alarms.length} 项漂移待处理`);
    process.exit(1);
  }
  console.log("[sentinel] 结论：无漂移");
}

main();
