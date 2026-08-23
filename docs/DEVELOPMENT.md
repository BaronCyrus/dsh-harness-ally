# Development

## Architecture

Harness联盟模式分为两个平面：

- **Host bundle (`lib/`)**：跨会话共享 Harness 选择、CLI 检测/托管安装、Claude/Codex/Kimi Code 进程、DSH 模型协议桥、LLM waterfall router、取消与状态持久化。
- **Agent preset (`agent.cordis.yml`)**：为一个联盟会话提供标准编码工具、联盟提示和三个外部 Harness 的 one-shot subagent。

DSH 始终拥有 turn、step、history、checkpoint、权限和取消。Claude Code、Codex、Kimi Code 只充当外部执行 Harness 和模型适配器。

## Safety invariants

1. Harness 选择器仅在 preset id 为 `harness-ally` 的会话出现。
2. Standard 模式必须完全看不到该选择器。
3. 不复制或替换 DSH 原生模型选择器。
4. 外部工具活动只映射为 reasoning 中的只读状态，禁止产生 DSH `tool-call-delta`，否则同一工具会被重复执行。
5. 非 `danger-full-access` 模式由 DSH 外层 sandbox 包裹整个 CLI 进程树。
6. Prompt 通过 stdin / app-server RPC / ACP JSON-RPC 传输，不进入 argv。
7. Kimi ACP 客户端必须声明 `fs.readTextFile=false` / `fs.writeTextFile=false`，让文件操作留在受 DSH sandbox 约束的 Kimi 子进程内，禁止 Host reverse-RPC 绕过 sandbox。
8. Kimi 前台模型 bridge 只使用进程级 `KIMI_MODEL_*` 和临时 `KIMI_CODE_HOME`，不得改写用户 Kimi 配置或遗留会话数据。
9. bridge token、CLI stderr、环境变量和本机凭据不得进入用户诊断或仓库。
10. 所有进程、临时目录、route、signal 监听器和队列必须可取消且幂等释放。

## Cache invariants

1. `harnessPrompt()` 的固定 Harness 指令、system 与已有消息必须构成逐字节稳定前缀；新增上下文只能追加在尾部。
2. 一轮外部 Harness 可触发多个底层模型请求；bridge route 必须累计所有请求的互斥 `TokenUsage` 桶，再由外层 `runtime.route()` 在 `finish` 前恰好发送一次 `usage`。
3. `inputTokens` 不包含 cache read/write；`reasoningTokens` 已包含在 `outputTokens`，不得重复相加。
4. route 使用 DSH session id 作为 provider affinity 输入；不得使用每回合随机 run id，否则会破坏 Responses prompt cache locality。
5. 外部 wire 的 cache breakpoint 字段只有在 DSH provider-neutral schema 能无损表达时才允许透传；当前 Anthropic breakpoint 由 DSH adapter 的 `cacheRetention` 策略重建。
6. 修改 prompt 顺序、system、tools、bridge usage 或 session affinity 时，必须增加字面前缀/usage 桶测试并报告完整测试结果。

## Tests

```bash
npm test
node --check lib/index.js
node --check lib/runtime.js
node --check lib/harness.js
node --check lib/codex-app-server.js
node --check lib/kimi-acp.js
```

测试覆盖选择隔离、同源写保护、CLI 托管、稳定 prompt 前缀、模型桥 cache usage/多请求累计/session affinity、Claude partial messages、Codex app-server、Kimi ACP 握手/模型注入/实时事件/取消/临时目录清理、只读 reasoning/activity、最终文本校准和 Host teardown。

## Local iteration

仓库应克隆在：

```text
${DSH_HOME:-~/.dsh}/.agent-presets/harness-ally
```

`setup/install.mjs` 会把 Web Profile 的 `dsh-ally` 依赖设置为指向仓库根目录的 `link:`，因此同事可以直接在 clone 内修改代码并运行测试。

- Host/preset 变更：重启现有 `dsh web`。
- Client 变更：生产 Web 也需要重启；只有在 DSH checkout 同时运行 `pnpm run dev:web` 时才有 client-plugin HMR。
- 不要启动另一个替代 Web server；它不会更新已经打开的 DSH GUI。

## Versioning

每次可见行为或协议变更都递增 `package.json` 版本；Codex app-server 与 Kimi ACP 通过 `lib/version.js` 读取同一个版本。发布前运行完整测试、`npm pack --dry-run --json` 和隐私扫描。
