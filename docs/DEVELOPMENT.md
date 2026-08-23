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
8. Kimi 前台模型 bridge 只使用进程级 `KIMI_MODEL_*` 和 DSH state 下的托管 `KIMI_CODE_HOME`；Codex/Claude 分别使用托管 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。不得改写用户 CLI 的普通配置或混入用户会话目录。
9. bridge token、CLI stderr、环境变量和本机凭据不得进入用户诊断或仓库。
10. 所有进程、临时目录、route、signal 监听器和队列必须可取消且幂等释放。

## Cache invariants

1. `harnessPrompt()` 的固定 Harness 指令、system 与已有消息必须构成逐字节稳定前缀；新增上下文只能追加在尾部。
2. 一轮外部 Harness 可触发多个底层模型请求；bridge route 必须累计所有请求的互斥 `TokenUsage` 桶，再由外层 `runtime.route()` 在 `finish` 前恰好发送一次 `usage`。
3. `inputTokens` 不包含 cache read/write；`reasoningTokens` 已包含在 `outputTokens`，不得重复相加。
4. route 使用 DSH session id 作为 provider affinity 输入；不得使用每回合随机 run id，否则会破坏 Responses prompt cache locality。
5. 外部 wire 的 cache breakpoint 字段只有在 DSH provider-neutral schema 能无损表达时才允许透传；当前 Anthropic breakpoint 由 DSH adapter 的 `cacheRetention` 策略重建。
6. 修改 prompt 顺序、system、tools、bridge usage 或 session affinity 时，必须增加字面前缀/usage 桶测试并报告完整测试结果。

## Native session invariants

1. DSH Session 日志是唯一 canonical history；Claude session、Codex thread 与 Kimi session 只是可丢弃的执行缓存。
2. 原生 lane key 必须是 `DSH session × Harness × provider × model`，四项任意变化都不得读取另一 lane 的 vendor id。
3. fresh/rollover 发送完整 canonical prompt；只有上一成功回合与当前 turn 连续且 version/cwd/policy/system fingerprint 相同时，resume 才能发送最新用户消息增量。禁止向已有 native history 再发送完整历史。
4. vendor id 只在 adapter 返回 `completed` 后通过 revision CAS 提交。error、abort、同 turn 重试或恢复后失败会隔离该 lane；即使 dirty-state 写盘失败，本进程也必须保持 quarantine。
5. 一个 lane 从启动到 `dispose()` 完成必须 singleflight；后续运行不得与尚未释放的 CLI 进程共享同一原生 session。
6. 原生 id 无效时只允许在 prompt 尚未执行的握手阶段回退一次：Codex `thread/resume → thread/start`、Kimi `session/load → session/new`、Claude 精确识别无会话错误后重新 spawn。运行中失败禁止自动重放，避免重复副作用。
7. turn 缺口、fingerprint 变化或 32 个连续成功回合触发安全 rollover；状态最多保留 200 个 lane，淘汰只影响优化，不影响正确性。
8. Kimi `session/load` 的历史 replay update 不得进入当前 DSH stream；成功回合先关闭 ACP stdin 并有界等待进程自然退出以刷盘，超时则丢弃该 vendor id 后终止；Skill watchdog 的 fresh recovery 必须携带完整 canonical history，其新 session 是本回合释放后提交的最终 vendor id。

## Tests

```bash
npm test
node --check lib/index.js
node --check lib/runtime.js
node --check lib/native-session.js
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
