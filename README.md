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

## 目录

| 路径 | 内容 |
|---|---|
| `src/sse.ts` | SSE 流解析 |
| `docs/plan.md` | 方案、分工、里程碑和参考代码 |
