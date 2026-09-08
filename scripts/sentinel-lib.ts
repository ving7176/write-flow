/**
 * sync-sentinel 纯函数（与编排分离）：双站远端一致性判定。
 * 被编排脚本 sync-sentinel.mts 与 __tests__/sentinel.test.ts 引用，
 * 经由测试文件进入 tsc include 闭包做类型检查（与 sync-engine-lib 同机制）。
 */

export type RemoteStatus = "consistent" | "fork-remotes" | "missing-remote" | "local-mismatch";

export interface RemoteHash {
  url: string;
  /** 远端 main hash；null = 站点可达但无 main 分支 */
  hash: string | null;
}

export interface RemoteVerdict {
  status: RemoteStatus;
  /** 人读结论，含处置指引 */
  message: string;
}

/**
 * 判定本地 main 与各推送站点的一致性。remotes 只传入探测成功的站点；
 * 探测失败（网络/凭据）由编排单独处理为环境异常，不进入本判定。
 */
export function classifyRemotes(localMain: string | null, remotes: RemoteHash[]): RemoteVerdict {
  if (remotes.length === 0) {
    return { status: "missing-remote", message: "无任何可达站点，无法判定" };
  }
  if (remotes.some((r) => r.hash === null)) {
    const detail = remotes.filter((r) => r.hash === null).map((r) => r.url).join("、");
    return { status: "missing-remote", message: `站点 main 分支缺失：${detail}` };
  }
  const distinct = [...new Set(remotes.map((r) => r.hash as string))];
  if (distinct.length > 1) {
    const detail = remotes.map((r) => `${r.url}=${(r.hash as string).slice(0, 7)}`).join("，");
    return { status: "fork-remotes", message: `双站 hash 不一致（漏推单站特征）：${detail}` };
  }
  const remoteHash = distinct[0];
  if (localMain === null) {
    return { status: "local-mismatch", message: `引擎仓本地无 main 分支，与远端(${remoteHash.slice(0, 7)})失联` };
  }
  if (localMain !== remoteHash) {
    return {
      status: "local-mismatch",
      message: `本地 main(${localMain.slice(0, 7)}) 与远端(${remoteHash.slice(0, 7)}) 不一致：引擎仓先 git fetch + git status 确认领先/落后`,
    };
  }
  return { status: "consistent", message: `本地与 ${remotes.length} 个站点一致（${remoteHash.slice(0, 7)}）` };
}
