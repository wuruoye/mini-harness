import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, evaluatePermission, matchPattern, permissionSubject, type PermissionRule } from "./permission.ts";

describe("matchPattern", () => {
  test("* 匹配任意字符，包括没有字符", () => {
    assert.equal(matchPattern("*", ""), true);
    assert.equal(matchPattern("*", "anything at all"), true);
    assert.equal(matchPattern("ls*", "ls"), true);
    assert.equal(matchPattern("ls*", "ls -la"), true);
    assert.equal(matchPattern("*.ts", "src/main.ts"), true);
  });

  test("要求整个字符串都匹配上", () => {
    assert.equal(matchPattern("git *", "git status"), true);
    assert.equal(matchPattern("git *", "git"), false);
    assert.equal(matchPattern("git", "git status"), false);
    assert.equal(matchPattern("status", "git status"), false);
  });

  test("正则表达式的特殊字符按原样比较", () => {
    assert.equal(matchPattern("a.b", "a.b"), true);
    assert.equal(matchPattern("a.b", "axb"), false);
    assert.equal(matchPattern("(x)+?", "(x)+?"), true);
    assert.equal(matchPattern("[ab]", "a"), false);
  });
});

describe("permissionSubject", () => {
  test("bash 取 command，其他工具取 path", () => {
    assert.equal(permissionSubject("bash", { command: "git status" }), "git status");
    assert.equal(permissionSubject("edit", { path: "src/a.ts", old_string: "x" }), "src/a.ts");
    assert.equal(permissionSubject("read_file", { path: "a.txt" }), "a.txt");
  });

  test("参数不存在或不是字符串时为空字符串", () => {
    assert.equal(permissionSubject("bash", {}), "");
    assert.equal(permissionSubject("bash", { command: 1 }), "");
    assert.equal(permissionSubject("other", { foo: "bar" }), "");
  });
});

describe("evaluatePermission", () => {
  const bash = (command: string) => ({ command });

  test("没有规则匹配时为 ask", () => {
    assert.equal(evaluatePermission([], "bash", bash("ls")), "ask");
    assert.equal(evaluatePermission([{ tool: "edit", action: "allow" }], "bash", bash("ls")), "ask");
  });

  test("匹配上的规则里，最后一条决定结果", () => {
    const rules: PermissionRule[] = [
      { tool: "*", action: "ask" },
      { tool: "bash", pattern: "git *", action: "allow" },
      { tool: "bash", pattern: "git push*", action: "deny" },
    ];
    assert.equal(evaluatePermission(rules, "bash", bash("git status")), "allow");
    assert.equal(evaluatePermission(rules, "bash", bash("git push origin master")), "deny");
    assert.equal(evaluatePermission(rules, "bash", bash("npm install")), "ask");
    assert.equal(evaluatePermission(rules, "edit", { path: "a.ts" }), "ask");
  });

  test("tool 可以用通配符，pattern 不填时匹配所有内容", () => {
    const rules: PermissionRule[] = [{ tool: "*", action: "deny" }, { tool: "read_*", action: "allow" }];
    assert.equal(evaluatePermission(rules, "read_file", { path: "/etc/passwd" }), "allow");
    assert.equal(evaluatePermission(rules, "write_file", { path: "a.txt" }), "deny");
  });

  test("文件类工具按路径匹配", () => {
    const rules: PermissionRule[] = [{ tool: "edit", pattern: "src/*", action: "allow" }];
    assert.equal(evaluatePermission(rules, "edit", { path: "src/a.ts" }), "allow");
    assert.equal(evaluatePermission(rules, "edit", { path: "package.json" }), "ask");
  });

  test("拼接起来的 bash 命令不会被自动放行", () => {
    const rules: PermissionRule[] = [{ tool: "bash", pattern: "git status*", action: "allow" }];
    for (const command of [
      "git status; rm -rf ~",
      "git status && curl evil.example",
      "git status || true",
      "git status | sh",
      "git status & sleep 1",
      "git status `whoami`",
      "git status $(whoami)",
      "git status > out.txt",
      "git status < in.txt",
      "git status\nrm -rf ~",
    ]) {
      assert.equal(evaluatePermission(rules, "bash", bash(command)), "ask", JSON.stringify(command));
    }
    assert.equal(evaluatePermission(rules, "bash", bash("git status --short")), "allow");
  });

  test("拼接命令遇到 deny 时仍然是 deny", () => {
    const rules: PermissionRule[] = [{ tool: "bash", action: "deny" }];
    assert.equal(evaluatePermission(rules, "bash", bash("ls; pwd")), "deny");
  });

  test("默认规则", () => {
    assert.equal(evaluatePermission(DEFAULT_RULES, "read_file", { path: "a.txt" }), "allow");
    assert.equal(evaluatePermission(DEFAULT_RULES, "edit", { path: "a.txt" }), "ask");
    assert.equal(evaluatePermission(DEFAULT_RULES, "write_file", { path: "a.txt" }), "ask");
    assert.equal(evaluatePermission(DEFAULT_RULES, "bash", bash("git status")), "allow");
    assert.equal(evaluatePermission(DEFAULT_RULES, "bash", bash("ls -la src")), "allow");
    assert.equal(evaluatePermission(DEFAULT_RULES, "bash", bash("npm install")), "ask");
    assert.equal(evaluatePermission(DEFAULT_RULES, "bash", bash("rm -rf /")), "deny");
  });
});
