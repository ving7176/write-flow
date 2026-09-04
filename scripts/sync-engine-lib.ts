/**
 * sync-engine 纯函数（与编排分离）：本文件进 tsc include 闭包做类型检查；
 * sync-engine.mts（编排 + import.meta）与 cut-engine.mts 同待遇由 tsx 运行，不进 lint。
 */

/** git status --porcelain 空输出 = 工作区干净 */
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
