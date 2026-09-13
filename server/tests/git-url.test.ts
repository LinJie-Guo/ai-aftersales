import { describe, expect, it } from "vitest";

import { httpsToSshGitUrl } from "../src/http/crud.ts";

describe("httpsToSshGitUrl", () => {
  it("converts https repo urls so SSH keys can be used", () => {
    expect(httpsToSshGitUrl("https://git.example.com/demo/microservice/user.git"))
      .toBe("git@git.example.com:demo/microservice/user.git");
  });

  it("leaves git@ urls unchanged", () => {
    expect(httpsToSshGitUrl("git@git.example.com:demo/platform-services.git"))
      .toBe("git@git.example.com:demo/platform-services.git");
  });
});
