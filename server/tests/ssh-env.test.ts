import { describe, expect, it } from "vitest";

import { resolveWorkdir, translateSshError } from "../src/agent/tools/ssh.ts";

describe("resolveWorkdir", () => {
  it("defaults to the customer workdir", () => {
    expect(resolveWorkdir(undefined, "/data/install")).toBe("/data/install");
    expect(resolveWorkdir("", "/data/install")).toBe("/data/install");
  });

  it("keeps an absolute workdir", () => {
    expect(resolveWorkdir("/tmp", "/data/install")).toBe("/tmp");
  });

  it("resolves a relative workdir against the customer workdir", () => {
    expect(resolveWorkdir("middleware", "/data/install")).toBe("/data/install/middleware");
  });
});

describe("translateSshError", () => {
  it("maps ssh2 auth failure to Chinese", () => {
    expect(translateSshError(new Error("All configured authentication methods failed"))).toMatch(/公钥认证失败/);
    expect(translateSshError(new Error("connect ECONNREFUSED 10.0.31.121:22"))).toMatch(/连接被拒绝/);
    expect(translateSshError(new Error("公钥认证失败：已说明"))).toBe("公钥认证失败：已说明");
  });
});
