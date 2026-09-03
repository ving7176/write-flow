/**
 * 引擎包同步工具（主仓 → 引擎仓 → 双站）：
 * 主仓 app/src 引擎闭包变更后，一条命令完成 切割 → 门禁验证 → 提交 → 双站推送。
 *
 * 用法：yarn sync [--dry-run]
 *
 * 流程与约束：
 *  1. 前置检查：主仓/引擎仓工作区必须干净（cut 读的是文件系统，同步点必须是提交点）；
 *     引擎仓本地 main 必须等于 origin/main（fetch 后比对）且与两站远端 main 一致
 *  2. cut 幂等重建 src 与 data/skills
 *  3. 切割产物无变更 → 直接退出，不产生空提交
 *  4. 有变更 → lint + test 门禁；失败自动还原切割产物（git checkout -- src data/skills，
 *     还原范围 = cut 写入范围，起点已保证干净，不会覆盖任何手工改动）
 *  5. 逐 URL 显式推送双站：origin 只配了 GitHub 一条 pushurl，`git push origin` 会静默
 *     漏掉 Gitee 主源，必须按 URL 枚举推送，推后逐站核验远端 hash
 */
import { execSync } from "child_process";
import path from "path";
import { pathToFileURL } from "url";

const HERE = import.meta.dirname ?? ".";
const ENGINE_ROOT = path.resolve(HERE, "..");
const MAIN_REPO = path.resolve(HERE, "../../..");
/** cut 的全部写入路径（变更检测与失败还原的范围） */
const CUT_PATHS = "src data/skills";

// —— 纯函数（导出供单测） ——

export function isClean(statusPorcelain: string): boolean {
  return statusPorcelain.trim() === "";
}

/** 推送目标 = fetch 主源 + 全部 pushurl（去重保序）：Gitee 无 pushurl 配置，漏掉 fetch 源 = 漏推主站 */
export function collectPushUrls(fetchUrl: string, pushUrls: string[]): string[] {
  return [...new Set([fetchUrl, ...pushUrls])];
}

export function buildCommitMessage(mainShortHash: string): string {
  return `sync: 同步主仓 ${mainShortHash} 的引擎闭包变更（cut + lint + test 通过）`;
}

/** git ls-remote 输出取 main 分支 hash：`<hash>\trefs/heads/main`；无则 null */
export function parseLsRemote(output: string): string | null {
  const line = output.split("\n").find((l) => l.trim().endsWith("refs/heads/main"));
  return line ? line.split("\t")[0].trim() : null;
}

// —— 编排 ——

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] });
}

function runLive(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "inherit" });
}

function die(msg: string): never {
  console.error(`[sync] 中止：${msg}`);
  process.exit(1);
}

function assertCleanRepo(name: string, cwd: string): void {
  const status = run("git status --porcelain", cwd);
  if (!isClean(status)) die(`${name}工作区有未提交改动，请先提交（同步点必须是提交点）：\n${status}`);
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  // 1. 前置检查：同步点 = 提交点 + 双站无分叉
  const mainHead = run("git rev-parse --short HEAD", MAIN_REPO).trim();
  assertCleanRepo("主仓", MAIN_REPO);
  assertCleanRepo("引擎仓", ENGINE_ROOT);

  const localMain = run("git rev-parse main", ENGINE_ROOT).trim();
  runLive("git fetch origin main", ENGINE_ROOT);
  const originMain = run("git rev-parse origin/main", ENGINE_ROOT).trim();
  if (localMain !== originMain) {
    die(`引擎仓本地 main(${localMain.slice(0, 7)}) 偏离 origin/main(${originMain.slice(0, 7)})，先 pull 处理再同步`);
  }

  const fetchUrl = run("git remote get-url origin", ENGINE_ROOT).trim();
  const pushUrls = run("git config --get-all remote.origin.pushurl", ENGINE_ROOT)
    .trim()
    .split("\n")
    .filter(Boolean);
  const urls = collectPushUrls(fetchUrl, pushUrls);
  for (const url of urls) {
    const remote = parseLsRemote(run(`git ls-remote "${url}" main`, ENGINE_ROOT));
    if (remote !== localMain) {
      die(`远端 ${url} main=${remote?.slice(0, 7) ?? "无"} ≠ 本地 ${localMain.slice(0, 7)}，先处理分叉再同步`);
    }
  }
  console.log(`[sync] 前置检查通过：主仓 ${mainHead} · 引擎仓 ${localMain.slice(0, 7)} · 推送目标 ${urls.length} 站`);

  // 2. 切割
  runLive("yarn cut", ENGINE_ROOT);

  // 3. 变更检测：起点已干净，porcelain 非空必然来自 cut
  const after = run("git status --porcelain", ENGINE_ROOT);
  if (isClean(after)) {
    console.log("[sync] 切割产物与主仓完全一致，无需同步");
    return;
  }
  console.log(`[sync] 检测到切割产物变更：\n${after}`);

  // 4. 门禁：lint + test 不过则还原切割产物
  try {
    runLive("yarn lint", ENGINE_ROOT);
    runLive("yarn test", ENGINE_ROOT);
  } catch {
    run(`git checkout -- ${CUT_PATHS}`, ENGINE_ROOT);
    die("lint/test 未通过，已还原切割产物；请先在主仓修复");
  }
  if (dryRun) {
    console.log("[dry-run] 门禁通过，跳过提交与推送");
    return;
  }

  // 5. 提交 + 逐 URL 推送 + 推后核验
  run("git add -A", ENGINE_ROOT);
  run(`git commit -m ${JSON.stringify(buildCommitMessage(mainHead))}`, ENGINE_ROOT);
  const newHash = run("git rev-parse main", ENGINE_ROOT).trim();
  for (const url of urls) {
    runLive(`git push "${url}" main`, ENGINE_ROOT);
  }
  let allOk = true;
  for (const url of urls) {
    const remote = parseLsRemote(run(`git ls-remote "${url}" main`, ENGINE_ROOT));
    const ok = remote === newHash;
    console.log(`[sync] 核验 ${url}: ${ok ? "OK" : `MISMATCH(remote=${remote?.slice(0, 7) ?? "无"})`}`);
    if (!ok) allOk = false;
  }
  console.log(allOk ? `[sync] 完成：${newHash.slice(0, 7)} 已同步 ${urls.length} 站` : "[sync] 推送完成但部分站点核验未过，请人工检查");
  if (!allOk) process.exit(1);
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
