import { describe, it, expect } from "vitest";
import { classifyPushFailure, pushFailureReason } from "../src/git.js";

describe("classifyPushFailure", () => {
  it("GitLab 保护分支：denied 优先于 rejected（同时含两类关键词）", () => {
    const out = [
      "remote: GitLab: You are not allowed to push code to this project.",
      "To https://gitlab.example.com/org/kb.git",
      " ! [remote rejected] HEAD -> main (pre-receive hook declined)",
      "error: failed to push some refs to 'https://gitlab.example.com/org/kb.git'",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("GitHub SSH 无写权限", () => {
    const out = [
      "ERROR: Permission to org/kb.git denied to alice.",
      "fatal: Could not read from remote repository.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("SSH key 未配置", () => {
    const out = [
      "git@gitlab.example.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 无凭证（terminal prompts disabled）", () => {
    const out =
      "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled";
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 403", () => {
    const out =
      "fatal: unable to access 'https://gitlab.example.com/org/kb.git/': The requested URL returned error: 403";
    expect(classifyPushFailure(out)).toBe("denied");
  });

  it("HTTPS 凭证失效", () => {
    expect(classifyPushFailure("remote: HTTP Basic: Access denied")).toBe("denied");
    expect(classifyPushFailure("fatal: Authentication failed for 'https://x/'")).toBe("denied");
  });

  it("GitHub 对无权限私有库返回伪装 404", () => {
    expect(classifyPushFailure("remote: Repository not found.")).toBe("denied");
  });

  it("并发竞争的 non-fast-forward 是 rejected，不是 denied", () => {
    const out = [
      "To /tmp/origin.git",
      " ! [rejected]        HEAD -> main (fetch first)",
      "error: failed to push some refs to '/tmp/origin.git'",
      "hint: Updates were rejected because the remote contains work that you do not have locally.",
    ].join("\n");
    expect(classifyPushFailure(out)).toBe("rejected");
  });

  it("网络类失败既非 denied 也非 rejected", () => {
    const out =
      "fatal: unable to access 'https://gitlab.example.com/org/kb.git/': Could not resolve host: gitlab.example.com";
    expect(classifyPushFailure(out)).toBe("transient");
  });

  it("不把成功输出里的 delta 数字误判成 HTTP 403", () => {
    // 只有失败才会调用分类，但输出里带 403/401 数字的情况必须不误伤
    expect(classifyPushFailure("Total 12 (delta 403), reused 0")).toBe("transient");
  });
});

describe("pushFailureReason", () => {
  it("优先取服务端 remote: 原文并去掉前缀", () => {
    const r = {
      code: 1,
      stdout: "",
      stderr: [
        "remote: GitLab: You are not allowed to push code to this project.",
        "error: failed to push some refs",
      ].join("\n"),
    };
    expect(pushFailureReason(r)).toBe(
      "GitLab: You are not allowed to push code to this project."
    );
  });

  it("无 remote: 行时退回第一条 fatal/error", () => {
    const r = {
      code: 1,
      stdout: "",
      stderr: "Cloning...\nfatal: Could not read from remote repository.\n",
    };
    expect(pushFailureReason(r)).toBe("fatal: Could not read from remote repository.");
  });

  it("空输出有兜底文案", () => {
    expect(pushFailureReason({ code: 1, stdout: "", stderr: "" })).toBe("未知原因");
  });
});
