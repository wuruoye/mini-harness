# mini-harness

学习用的 coding agent harness。用 TypeScript 实现，直接用 `fetch` 调用 Anthropic Messages 和 OpenAI Chat Completions 两种接口，不依赖厂商 SDK。

## 环境

- Node 24 及以上，直接运行 `.ts` 文件，没有编译步骤
- pnpm

## 命令

```bash
pnpm install
pnpm test        # 跑测试
pnpm typecheck   # 类型检查
pnpm check       # 类型检查加测试
```

## 运行

把 `.env.example` 复制为 `.env`，填上 `ANTHROPIC_API_KEY`，然后运行：

```bash
pnpm start
```

这时工作目录是 mini-harness 本身。要让它操作别的项目，进入那个项目的目录后运行：

```bash
node --env-file=$HOME/Documents/github/mini-harness/.env $HOME/Documents/github/mini-harness/src/main.ts
```

输入 `/exit` 或按 Ctrl-D 退出。

## 观察 API 原始响应

不经过适配器，直接请求 Anthropic API，打印原始的流式事件并保存到 `tmp/`：

```bash
pnpm explore        # 普通问答
pnpm explore tool   # 让模型调用工具
```

把保存的文件交给 `readAnthropicStream` 解析，调试时不用反复请求 API：

```bash
pnpm replay tmp/anthropic-tool-xxx.sse
```

用 VS Code 打开项目后，在「运行和调试」里可以直接选这几个脚本，以及运行 agent、调试当前测试文件，断点可以打在 .ts 文件里。

## 目录

| 路径 | 内容 |
|---|---|
| `src/main.ts` | 命令行入口 |
| `scripts/` | 观察和回放 API 原始响应的脚本 |
| `src/ai/` | 模型接入层：统一消息类型、SSE 解析、Anthropic 适配器、测试用的假模型 |
| `src/agent/` | 主循环和工具接口 |
| `src/tools/` | 各个工具 |
| `docs/plan.md` | 方案、分工、里程碑和参考代码 |
