import { describe, expect, it, vi } from "vitest";
import { readonlyRoute } from "../src/agent/tools/readonly-route.ts";
import { createSshEnvTools } from "../src/agent/tools/ssh.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";

describe("bounded read-only routing", () => {
  it("routes the reported directory command and common reads without executing shell", () => {
    expect(readonlyRoute("ls -la /data/install-pkg-8.3/7-cai/ 2>&1 | head -50")).toEqual({ operation: "list", path: "/data/install-pkg-8.3/7-cai/" });
    expect(readonlyRoute("ls -lah", "/opt/app")).toEqual({ operation: "list", path: "/opt/app/." });
    expect(readonlyRoute("cat '/opt/app config/.env' | head -n 80")).toEqual({ operation: "read", path: "/opt/app config/.env", limit: 80 });
    expect(readonlyRoute("head -n 20 application.yml", "/opt/app")).toEqual({ operation: "read", path: "/opt/app/application.yml", limit: 20 });
    expect(readonlyRoute("head -50 /opt/app.env")).toEqual({ operation: "read", path: "/opt/app.env", limit: 50 });
    expect(readonlyRoute("docker ps")).toEqual({ operation: "containers" });
    expect(readonlyRoute("docker inspect kb-api")).toEqual({ operation: "inspect", container: "kb-api" });
    expect(readonlyRoute("docker logs --tail 50 kb-api")).toEqual({ operation: "logs", container: "kb-api", limit: 50 });
  });
  it.each([
    "ls /opt; rm /opt/x", "ls /opt && touch /tmp/x", "ls /opt || reboot", "ls /opt\nreboot",
    "cat $(touch /tmp/x)", "cat `/usr/bin/id`", 'cat "$HOME/.env"', "cat /opt/*",
    "ls /opt > /tmp/x", "ls /opt 2>/tmp/x", "ls /opt | bash", "ls /opt | head -50; reboot",
    "cat /proc/1/mem", "cat /dev/sda", "ls /sys/kernel", "cat /opt/../proc/1/mem",
    "docker restart kb-api", "docker exec kb-api sh", "docker logs --tail 50 kb-api; reboot",
    "head -n 0 /opt/file", "head -n 1001 /opt/file", "ls /opt | head -0", "ls /opt | head -1001",
    "cat relative.env", "find /opt -exec sh {} ;", "curl http://localhost:9200/_count",
  ])("keeps unsupported or unsafe syntax behind approval: %s", (command) => {
    expect(readonlyRoute(command)).toBeUndefined();
  });
  it("bypasses approval only by calling the structured tool, never the original command", async () => {
    const readOnly = vi.fn(async () => ({ status: "success" as const, summary: "files" }));
    const approve = vi.fn(async () => false), run = vi.fn();
    const tool = createSshEnvTools({ target: { host: "fixture", port: 22, username: "fixture" }, artifacts: new ArtifactStore("/tmp/readonly-route-test"), customerId: "fixture", readOnly, approve, run })[0];
    const result = await tool.execute({ command: "ls -la /opt/app 2>&1 | head -50" }, { signal: new AbortController().signal, inject() {} });
    expect(result.status).toBe("success");
    expect(result.data?.routedTool).toBe("remote_read");
    expect(readOnly).toHaveBeenCalledWith({ operation: "list", path: "/opt/app" }, expect.anything());
    expect(approve).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    await tool.execute({ command: "docker restart kb-api" }, { signal: new AbortController().signal, inject() {} });
    expect(approve).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
    await tool.execute({ command: "cat /opt/file", credentialEnv: [] }, { signal: new AbortController().signal, inject() {} });
    expect(approve).toHaveBeenCalledTimes(2); expect(readOnly).toHaveBeenCalledTimes(1);
  });
});
