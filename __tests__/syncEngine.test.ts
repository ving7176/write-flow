import { describe, expect, it } from "vitest";
import { buildCommitMessage, collectPushUrls, isClean, parseLsRemote } from "../scripts/sync-engine-lib";

describe("sync-engine 纯函数", () => {
  it("isClean：空/纯空白输出视为干净，任何条目视为脏", () => {
    expect(isClean("")).toBe(true);
    expect(isClean("\n")).toBe(true);
    expect(isClean("  \n")).toBe(true);
    expect(isClean(" M src/pipeline/stageEngine.ts\n")).toBe(false);
    expect(isClean("?? scripts/sync-engine.mts")).toBe(false);
  });

  it("collectPushUrls：fetch 主源必须入列（Gitee 无 pushurl 配置），pushurl 追加在后并去重", () => {
    expect(collectPushUrls("git@gitee.com:kkje/write-flow.git", ["git@github.com:ving7176/write-flow.git"])).toEqual([
      "git@gitee.com:kkje/write-flow.git",
      "git@github.com:ving7176/write-flow.git",
    ]);
    // pushurl 与 fetch 相同（双 pushurl 都配了 Gitee）时不重复推
    expect(collectPushUrls("git@gitee.com:a/b.git", ["git@gitee.com:a/b.git", "git@github.com:a/b.git"])).toEqual([
      "git@gitee.com:a/b.git",
      "git@github.com:a/b.git",
    ]);
  });

  it("buildCommitMessage：携带主仓短 hash，说明门禁已过", () => {
    const msg = buildCommitMessage("bc6d855");
    expect(msg).toContain("bc6d855");
    expect(msg).toContain("cut + lint + test");
  });

  it("parseLsRemote：从 ls-remote 输出提取 main hash；空输出/无 main 返回 null", () => {
    const full = "b00779933fca4865df29b8fe70299c3080355c87\trefs/heads/main\n0000000000000000000000000000000000000000\trefs/tags/v0.1.0\n";
    expect(parseLsRemote(full)).toBe("b00779933fca4865df29b8fe70299c3080355c87");
    // 只有非 main 分支
    expect(parseLsRemote("abc\trefs/heads/dev\n")).toBeNull();
    expect(parseLsRemote("")).toBeNull();
  });
});
