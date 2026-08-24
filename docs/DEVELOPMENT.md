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
4. 外部工具活动在当前回合只映射为 reasoning 中的只读状态，禁止产生 DSH `tool-call-delta`，否则同一工具会被重复执行；干净完成后可从同一结构化 activity 派生 work ledger，但不得从 reasoning 文本反向解析。
5. 非 `danger-full-access` 模式由 DSH 外层 sandbox 包裹整个 CLI 进程树。
6. Prompt 通过 stdin / app-server RPC / ACP JSON-RPC 传输，不进入 argv。
7. Kimi ACP 客户端必须声明 `fs.readTextFile=false` / `fs.writeTextFile=false`，让文件操作留在受 DSH sandbox 约束的 Kimi 子进程内，禁止 Host reverse-RPC 绕过 sandbox。
8. Kimi 前台模型 bridge 只使用进程级 `KIMI_MODEL_*` 和 DSH state 下的托管 `KIMI_CODE_HOME`；Codex/Claude 分别使用托管 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。不得改写用户 CLI 的普通配置或混入用户会话目录。
9. bridge token、CLI stderr、环境变量和本机凭据不得进入用户诊断或仓库；provider-private bridge reasoning、Kimi replay update 与敏感诊断也不得因“完整输出”承诺而透传。
10. Codex 思考模式的工具子回合必须用 Responses `reasoning.encrypted_content` 回传完整 reasoning。bridge 只允许自己用持久 AES-256-GCM key 生成的不透明密文，并在 Host 内解封后与相邻 assistant text/function call 合为同一 provider-neutral message；summary 必须为空，wire/原生日志/key 文件不得出现 reasoning 明文，认证失败必须在调用 provider 前 fail closed。key 只在 DSH state 以 `0600` 持久化，用于同一版本跨 route/Host 重启恢复；它防止偶然明文泄露，不把本机 state 提升为密码学安全边界。
11. 所有进程、临时目录、route、signal 监听器和队列必须可取消且幂等释放。
12. work ledger 只接收归一化后的工具名、状态，以及明确选取的 command/path leaf；常见 token/key/password/auth 形态必须先脱敏，每项有字符上限，集合有数量上限，注入 prompt 时必须标为 untrusted records 而非指令。原始 stdout、reasoning 与完整 tool payload 不得落入状态文件。

## Cache invariants

1. `harnessPrompt()` 的固定 Harness 指令、system 与 canonical message history 必须保持原顺序；work ledger 是 fresh/full 才注入、紧邻当前请求的有界派生尾部，不得进入固定前缀、连续 resume prompt 或 canonical 水位线。
2. 一轮外部 Harness 可触发多个底层模型请求；bridge route 必须累计所有请求的互斥 `TokenUsage` 桶，再由外层 `runtime.route()` 在 `finish` 前恰好发送一次 `usage`。
3. `inputTokens` 不包含 cache read/write；`reasoningTokens` 已包含在 `outputTokens`，不得重复相加。
4. route 使用 DSH session id 作为 provider affinity 输入；不得使用每回合随机 run id，否则会破坏 Responses prompt cache locality。
5. 外部 wire 的 cache breakpoint 字段只有在 DSH provider-neutral schema 能无损表达时才允许透传；当前 Anthropic breakpoint 由 DSH adapter 的 `cacheRetention` 策略重建。
6. 修改 prompt 顺序、system、tools、bridge usage 或 session affinity 时，必须增加字面前缀/usage 桶测试并报告完整测试结果。

## Native session invariants

1. DSH Session 日志是唯一 canonical history；Claude session、Codex thread 与 Kimi session 只是可丢弃的执行缓存。
2. 原生 lane key 必须是 `DSH session × Harness × provider × model`，四项任意变化都不得读取另一 lane 的 vendor id。
3. fresh/rollover 发送 DSH 当前模型可见的 canonical surface（可能已含 compaction checkpoint）和最近 work ledger；规范化消息必须用 Session event 的 message id→turn 与 dispatch 的 turn→Harness 标注来源。历史 `ASSISTANT` 的第一人称身份/代号只属于其标注 Harness，不能污染当前 lane。同一 lane 连续 resume 只发送当前请求；turn 有缺口时允许恢复停泊的 vendor id，但只能发送由 canonical 水位线证明且带 identity isolation 的 `HARNESS HANDOFF`（离开后的已完成消息 + 对应 work ledger + 当前请求）。禁止向已有 native history 再发送完整历史。
4. 水位线只持久化稳定 conversation spine 的规范化消息数与 SHA-256 摘要，不持久化 transcript；验证和 prompt 必须使用同一个 canonical renderer。spine 包含 user/model/tool、plugin notice/relay/recall 与无 source 的普通消息，排除 plugin snapshot/catalog/instructions、无 form 与未知 source；volatile context 和 work ledger 可进入 fresh/full prompt，但不进入 digest，只有停泊缺口对应 ledger 可进入 `HARNESS HANDOFF`。旧 spine 前缀编辑、压缩、清空、收缩、Session `turn/end` 缺失/非 completed、消息形态未完成或没有严格进展时，必须 fail closed 到 fresh/full。
5. resume dispatch 前必须先用 revision CAS 把持久 vendor id 清为 null，形成 durable consume claim；claim 失败则禁止使用该 vendor id。新的 vendor id 与水位线只在 adapter 返回 `completed` 且 `dispose()` 干净结束后一起提交。这样最终提交失败或进程重启也不会重复发送同一 handoff；error、abort、同 turn 重试或恢复后失败继续隔离该 lane。
6. 一个 lane 从启动到 `dispose()` 完成必须 singleflight；后续运行不得与尚未释放的 CLI 进程共享同一原生 session。
7. 原生 id 无效时只允许在 prompt 尚未执行的握手阶段回退一次：Codex `thread/resume → thread/start`、Kimi `session/load → session/new`、Claude 精确识别无会话错误后重新 spawn。运行中失败禁止自动重放，避免重复副作用。
8. fingerprint 变化、无法证明的 turn 缺口或一个 lane 达到 32 个成功回合会触发安全 rollover；状态 v3 最多保留 200 个 lane 与每 session 400 个 dispatch，v2 lane 仅保留连续恢复兼容并在下一次成功后懒迁移，淘汰只影响优化，不影响正确性。每个 dispatch 的 v1 work ledger 最多保留 20 个文件、10 条命令和 10 条失败尝试。
9. 最新顶层用户请求含图片时必须在 dispatch 前硬拒绝；历史图片（包括 tool-result 嵌套图片）降级为占位符，tool result 名称必须通过 `toolCallId` 关联，reasoning 不进入 canonical 水位线，避免易变过程文本破坏可证明前缀。无文本的成功结果不能形成新水位线，后续跨 Harness 切回必须 fresh/full。
10. Kimi `session/load` 的历史 replay update 不得进入当前 DSH stream；成功回合先关闭 ACP stdin并有界等待进程自然退出以刷盘，超时则丢弃该 vendor id 后终止；Skill watchdog 的 fresh recovery 必须携带当前 canonical surface，其新 session 是本回合释放后提交的最终 vendor id。
11. work ledger 只在单次外部 `runtime.route()` run 已干净释放、返回 `completed` 且完成边界上的 signal 未取消时提交；完成边界前已经到达的 error/abort/cancellation 不提交该 run 的半成品台账，边界后的 bookkeeping 期间取消则由已完成结果胜出，避免“已落盘却对外报 aborted”。同一 DSH turn 的后续 step 会与此前干净 step 合并，后续失败不回滚此前已经完成的可观察工作。ledger 是连续性辅助，不是 transcript attestation，不能放宽任何 resume 水位线检查。
12. revision CAS、singleflight 与 quarantine 的威胁模型是单个 DSH Host 进程；当前状态文件不提供多进程锁、显式 fsync、跨进程 ABA 防护或断电一致性承诺。若未来允许多个 Host 共享 `DSH_HOME`，必须先升级持久化协议。

## Tests

```bash
npm test
node --check lib/index.js
node --check lib/runtime.js
node --check lib/work-ledger.js
node --check lib/reasoning-codec.js
node --check lib/native-session.js
node --check lib/harness.js
node --check lib/codex-app-server.js
node --check lib/kimi-acp.js
```

测试覆盖选择隔离、同源写保护、CLI 托管、稳定 prompt 前缀、模型桥 cache usage/多请求累计/session affinity、Codex 私有 reasoning 的密文工具回传/跨 bridge 重启恢复/认证失败闭锁、Claude partial messages、Codex app-server、Kimi ACP 握手/模型注入/实时事件/取消/临时目录清理、三种 adapter 的 command/path/outcome activity、只读 reasoning/activity、work ledger 的有界脱敏持久化/fresh/full/parked handoff/失败与完成-取消竞态裁决、最终文本校准和 Host teardown。

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
