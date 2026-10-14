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

把 `.env.example` 复制为 `.env`，填上要用的那家的 key，然后运行：

```bash
pnpm start
```

`LLM_PROVIDER` 决定用哪家，默认 `anthropic`，设为 `openai` 时用 OpenAI 格式的接口，改 `OPENAI_BASE_URL` 就能接兼容 OpenAI 的其他服务。

程序启动时会自己读取 mini-harness 根目录下的 `.env`，不管从哪个目录、用什么方式启动都一样；已经在环境里设置过的变量优先，不会被 `.env` 覆盖。

这时工作目录是 mini-harness 本身。要让它操作别的项目，进入那个项目的目录后运行：

```bash
node ~/Documents/github/mini-harness/src/main.ts
```

输入 `/exit` 或按 Ctrl-D 退出。

## 会话

每个会话存成一个 JSONL 文件，放在 `~/.mini-harness/sessions/<项目目录编码>/<会话 id>.jsonl`（可以用 `MH_SESSION_DIR` 换位置）。第一行是会话信息，之后每条消息一行，消息一产生就写入。

```bash
pnpm start --continue          # 接着这个目录上次的会话
pnpm start --resume <会话 id>   # 打开指定会话
```

运行中输入 `/sessions` 列出这个目录的会话，`/new` 开始新会话。

## 上下文压缩

发新问题前估算上下文的大小，超过 `MH_COMPACT_AT`（默认 10 万 token）时，把较早的消息让模型总结成摘要，之后的请求只带「摘要 + 最近大约 `MH_COMPACT_KEEP`（默认 2 万）token 的消息」。也可以输入 `/compact` 手动压缩。

估算方式：最后一次请求返回的用量就是当时上下文的真实大小，再加上之后新增消息的估算值（中日韩字符每个算 1 个 token，其他字符每 4 个算 1 个）。压缩记录追加在会话文件里，完整的消息仍然都保存着。

## 工具和权限

agent 有四个工具：`read_file`、`bash`、`edit`、`write_file`。每次调用工具前按 `src/agent/permission.ts` 里的规则判断：读文件和 `git status`、`ls` 这类只读命令直接放行，`rm -rf` 直接拒绝，其他操作在命令行里询问。回答 `y` 允许，`a` 在本次会话里一直允许同一条命令或同一个文件，`n` 拒绝，也可以直接输入拒绝的理由，理由会交给模型。

权限模式在规则判断之后再做调整，启动时用 `pnpm start --mode bypass` 或 `.env` 里的 `MH_PERMISSION_MODE` 指定，运行中输入 `/mode` 查看、`/mode bypass` 切换：

| 模式 | 效果 |
|---|---|
| `auto`（默认） | 项目里的文件操作不再询问；`bash` 在 macOS 沙箱里执行、不再询问，只能写项目目录和临时目录；项目外的文件和申请在沙箱外执行的命令按规则来 |
| `bypass` | 所有操作都不经确认直接执行，包括规则禁止的，建议只在容器或临时目录里用 |

auto 模式下可以用 `MH_SANDBOX_WRITABLE` 额外放开可写目录（比如 `~/.npm`），用 `MH_SANDBOX_NETWORK=off` 禁止联网。沙箱只限制写文件和联网，不限制读文件；临时目录本身是可写的，放在里面的文件不受保护。

## 观察 API 原始响应

输入问题后直接请求 API，打印原始的流式数据并保存到 `tmp/`，不经过适配器和主循环。每个问题都是独立的一次请求：

```bash
pnpm explore:anthropic --models                    # 列出这个 key 能用的模型
pnpm explore:anthropic                             # 交互模式，逐条输入问题
pnpm explore:anthropic 用一句话介绍你自己            # 只问这一句
pnpm explore:anthropic --tool 读一下 package.json    # 带上 read_file 工具定义
```

`pnpm explore:openai` 的用法相同。

agent 运行时也可以保存原始响应：在 `.env` 里设置 `MH_SAVE_RAW=1`，每次请求的响应都会另存到 `tmp/`。

把保存的文件交给适配器的解析函数，调试时不用反复请求 API。文件名以 `openai-` 开头的交给 OpenAI 适配器，其余交给 Anthropic 适配器：

```bash
pnpm replay tmp/anthropic-xxx.sse
```

用 VS Code 打开项目后，在「运行和调试」里可以直接选这几个脚本，以及运行 agent、调试当前测试文件，断点可以打在 .ts 文件里。

在 VS Code 以外的终端里调试：先用 `pnpm start:debug` 启动，程序会等调试器连上再运行；然后在 VS Code 的「运行和调试」里选「附加到外部终端启动的 agent」，或者在 Chrome 打开 `chrome://inspect` 连接。输入仍然在原来的终端里进行。

## 目录

| 路径 | 内容 |
|---|---|
| `src/main.ts` | 命令行入口 |
| `scripts/` | 观察和回放 API 原始响应的脚本 |
| `src/ai/` | 模型接入层：统一消息类型、SSE 解析、Anthropic 和 OpenAI 适配器、测试用的假模型 |
| `src/agent/` | 主循环、工具接口、权限规则、会话存储、上下文压缩 |
| `src/tools/` | 各个工具 |
| `docs/plan.md` | 方案、分工、里程碑和参考代码 |
