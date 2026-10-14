import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMode,
  DEFAULT_RULES,
  evaluatePermission,
  isInside,
  isPermissionMode,
  matchPattern,
  permissionSubject,
  type PermissionAction,
  type PermissionRule,
} from "./permission.ts";

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

describe("isInside", () => {
  const cwd = "/work/project";

  test("相对路径和工作目录里的绝对路径都算在里面", () => {
    assert.equal(isInside(cwd, "src/a.ts"), true);
    assert.equal(isInside(cwd, "./a.ts"), true);
    assert.equal(isInside(cwd, "/work/project/src/a.ts"), true);
    assert.equal(isInside(cwd, "."), true);
  });

  test("跳出工作目录的路径不算", () => {
    assert.equal(isInside(cwd, "../other/a.ts"), false);
    assert.equal(isInside(cwd, "src/../../a.ts"), false);
    assert.equal(isInside(cwd, "/etc/hosts"), false);
  });

  test("名字以工作目录开头的兄弟目录不算", () => {
    assert.equal(isInside(cwd, "/work/project2/a.ts"), false);
    assert.equal(isInside(cwd, "../project2/a.ts"), false);
  });

  test("文件名以 .. 开头但在工作目录里面的算", () => {
    assert.equal(isInside(cwd, "..notes.txt"), true);
    assert.equal(isInside(cwd, "src/..hidden"), true);
  });

  test("path 不是非空字符串时不算", () => {
    assert.equal(isInside(cwd, ""), false);
    assert.equal(isInside(cwd, undefined), false);
    assert.equal(isInside(cwd, 1), false);
  });
});

describe("applyMode", () => {
  const cwd = "/work/project";
  const ACTIONS: PermissionAction[] = ["allow", "ask", "deny"];

  test("isPermissionMode", () => {
    assert.equal(isPermissionMode("auto"), true);
    assert.equal(isPermissionMode("acceptEdits"), true);
    assert.equal(isPermissionMode("yolo"), false);
    assert.equal(isPermissionMode("toString"), false);
  });

  test("default：原样返回", () => {
    for (const action of ACTIONS) {
      assert.equal(applyMode("default", action, "bash", { command: "ls" }, cwd), action);
      assert.equal(applyMode("default", action, "edit", { path: "a.ts" }, cwd), action);
    }
  });

  test("auto：ask 变成 allow，deny 仍然是 deny", () => {
    assert.equal(applyMode("auto", "ask", "bash", { command: "npm install" }, cwd), "allow");
    assert.equal(applyMode("auto", "allow", "bash", { command: "ls" }, cwd), "allow");
    assert.equal(applyMode("auto", "deny", "bash", { command: "rm -rf /" }, cwd), "deny");
  });

  test("bypass：一律 allow", () => {
    for (const action of ACTIONS) {
      assert.equal(applyMode("bypass", action, "bash", { command: "rm -rf /" }, cwd), "allow");
    }
  });

  test("acceptEdits：工作目录里的 edit、write_file 不再询问", () => {
    assert.equal(applyMode("acceptEdits", "ask", "edit", { path: "src/a.ts" }, cwd), "allow");
    assert.equal(applyMode("acceptEdits", "ask", "write_file", { path: "/work/project/new.ts" }, cwd), "allow");
  });

  test("acceptEdits：工作目录外的文件、规则禁止的修改、其他工具都不变", () => {
    assert.equal(applyMode("acceptEdits", "ask", "edit", { path: "../other.ts" }, cwd), "ask");
    assert.equal(applyMode("acceptEdits", "ask", "write_file", { path: "/etc/hosts" }, cwd), "ask");
    assert.equal(applyMode("acceptEdits", "deny", "edit", { path: "src/a.ts" }, cwd), "deny");
    assert.equal(applyMode("acceptEdits", "ask", "bash", { command: "echo hi > a.txt" }, cwd), "ask");
    assert.equal(applyMode("acceptEdits", "ask", "edit", {}, cwd), "ask");
  });
});
