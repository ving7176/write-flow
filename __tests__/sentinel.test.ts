import { describe, expect, it } from "vitest";
import { classifyRemotes, RemoteHash } from "../scripts/sentinel-lib";

const remote = (url: string, hash: string): RemoteHash => ({ url, hash });

describe("sync-sentinel 纯函数", () => {
  it("consistent：本地与全部站点 hash 相同", () => {
    const v = classifyRemotes("abc1234def", [remote("gitee", "abc1234def"), remote("github", "abc1234def")]);
    expect(v.status).toBe("consistent");
    expect(v.message).toContain("2 个站点一致");
    expect(v.message).toContain("abc1234");
  });

  it("fork-remotes：双站 hash 不一致 = 漏推单站特征，最高优先级判定", () => {
    const v = classifyRemotes("abc1234", [remote("gitee", "aaa"), remote("github", "bbb")]);
    expect(v.status).toBe("fork-remotes");
    expect(v.message).toContain("漏推单站特征");
    expect(v.message).toContain("github=bbb");
  });

  it("local-mismatch：远端彼此一致但本地偏离，指引 fetch 确认方向", () => {
    const v = classifyRemotes("ddd", [remote("gitee", "aaa"), remote("github", "aaa")]);
    expect(v.status).toBe("local-mismatch");
    expect(v.message).toContain("ddd".slice(0, 7));
    expect(v.message).toContain("git fetch");
  });

  it("local-mismatch：本地无 main 分支视为失联", () => {
    const v = classifyRemotes(null, [remote("gitee", "aaa")]);
    expect(v.status).toBe("local-mismatch");
    expect(v.message).toContain("无 main");
  });

  it("missing-remote：站点无 main 分支 / 无可达站点", () => {
    expect(classifyRemotes("aaa", [{ url: "gitee", hash: null }]).status).toBe("missing-remote");
    expect(classifyRemotes("aaa", []).status).toBe("missing-remote");
  });

  it("missing-remote：main 缺失判定优先于本地偏离（先修远端再看本地）", () => {
    const v = classifyRemotes("ddd", [{ url: "gitee", hash: null }, remote("github", "aaa")]);
    expect(v.status).toBe("missing-remote");
  });
});
