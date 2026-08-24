# Harness联盟模式（DSH Agent Preset）

<img width="1450" height="540" alt="image" src="https://github.com/user-attachments/assets/9735076f-7507-4653-b5f0-fe7c329c3270" />

让 DeepSeek Harness、Claude Code、Codex 和 Kimi Code 共享同一个 DSH 会话生命周期，并与 DSH 原生模型选择器自由组合。

- **模型**仍由 DSH 原生模型选择器决定，自动使用当前已配置的全部 provider/model。
- **Harness**由独立的「选择Harness」控件决定，每个回合可切换 DeepSeek Harness、Claude Code、Codex 或 Kimi Code。
- DSH 始终拥有 history、turn、step、checkpoint、权限、取消和最终结果；外部 CLI 只负责执行当前 Agent 模型步骤。

## 功能

- **不替换原生 composer/model selector**：模型目录与现有 DSH 配置保持单一真源。
- **严格模式隔离**：Harness 选择器只在「Harness联盟模式」出现，Standard 模式完全不显示。
- **真实外部执行**：选择 Claude Code、Codex 或 Kimi Code 后，由对应 CLI 实际执行；提示会明确区分外部执行 Harness 与 DSH 宿主。
- **用户可见内容实时输出**：Claude Code 使用 partial messages，Codex 使用 app-server，Kimi Code 使用 ACP `session/update`；正文不再等待进程结束后一次性出现。provider-private bridge reasoning、Kimi replay update 与敏感诊断仍会按安全边界过滤。
- **可见执行过程**：外部回合立即显示对应的 `Harness · 正在执行`；可公开的 thinking/reasoning summary、`Bash`、文件修改、WebSearch、MCP 等活动实时显示在只读 `Think` 过程区。
- **不会重复执行工具**：外部活动绝不伪装成 DSH tool call，因此 Standard Agent 不会把同一命令再执行一次。
- **CLI 自动检测与托管安装**：优先使用 `PATH` 中的全局 CLI；缺失时在 Harness 菜单内显示「安装」，安装到 DSH 自有目录，不使用 sudo。
- **并行委派**：preset 同时提供 `subagent_claude_code`、`subagent_codex` 与 `subagent_kimi_code`。
- **缓存可观测**：外部 Harness 的 uncached/cache-read/cache-write/reasoning token 会回到 DSH 原生 token meter，不再显示为零；同一 DSH session 同时作为 provider prompt-cache affinity key。
- **有条件的原生会话停泊与续接**：每个 DSH session 下的 Claude Code、Codex 和 Kimi Code lane 会各自停泊原生 session/thread；证明连续性后，连续使用只发送本轮请求，跨 Harness 切回只补交离开期间的已完成 canonical history。它是可丢弃的缓存优化而非事实源；证明失败、运行失败、配置变化或达到 32 个成功回合时自动安全 rollover。
- **耐久工作台账**：干净完成且未取消的外部 run 会把结构化 activity 收敛为有界、版本化的改动文件、最近命令/结果和失败尝试；命令中的常见凭据形态会先脱敏，原始 stdout、reasoning 与完整 tool payload 不落盘。fresh/rollover 会带全局最近台账，停泊 lane 切回只带离开期间台账。

## 环境要求

- DSH（DeepSeek Harness）Web 部署
- Node.js 与 pnpm（DSH Web Profile 已使用 pnpm）
- Claude Code / Codex / Kimi Code CLI 均为可选：可以预先全局安装，也可以在「选择Harness」菜单中按需安装
- macOS、Linux、Windows

## 安装

```bash
# 1. 克隆到固定 preset id（Host 的隔离规则依赖 harness-ally）
git clone https://github.com/BaronCyrus/dsh-harness-ally.git ~/.dsh/.agent-presets/harness-ally
# Windows PowerShell:
# git clone https://github.com/BaronCyrus/dsh-harness-ally.git "$env:USERPROFILE\.dsh\.agent-presets\harness-ally"

# 2. 把同一仓库以 link 方式注册到 Web Profile
node ~/.dsh/.agent-presets/harness-ally/setup/install.mjs
```

如果设置了 `DSH_HOME`，将上面的 `~/.dsh` 替换为对应目录。

安装后重启现有 `dsh web` 进程，然后新建「Harness联盟模式」会话。不要另起替代 Web server；已经打开的 GUI 只会连接原来的 DSH 进程。

## 使用

1. 继续使用 DSH 原生模型选择器选择 provider/model。
2. 打开「选择Harness」，选择 DeepSeek Harness、Claude Code、Codex 或 Kimi Code。
3. 正常发送消息。回合进行中 Harness 会锁定，停止仍由原生 composer 控制。
4. 外部回合会先出现 `Think · Harness · 正在执行`；后续 thinking 和工具活动实时更新。
5. 最终消息下方显示 `Harness · model` 徽标。

缺失的 Claude Code、Codex 或 Kimi Code 不可直接选择，只会显示「安装」按钮；安装完成后即可选择。CLI 解析顺序是“全局 `PATH` 优先，DSH 托管目录兜底”。

## 架构

| 平面 | 职责 |
| --- | --- |
| Host bundle | Harness selection、CLI 检测/托管安装、LLM waterfall router、本地模型协议 bridge、Claude partial/Codex app-server/Kimi ACP adapters、有界 work ledger、DSH sandbox、provider registry |
| Agent preset | 联盟提示、标准编码工具、三个外部 Harness 的 one-shot subagent；不发布跨会话 Service |
| Client bundle | Harness chip、菜单内安装、回合锁定与 additive `Harness · model` 徽标；不替换 composer/model selector |

### 模型桥

每次前台外部运行都会创建短期、带随机凭据的 loopback route：

- Claude Code 使用 Anthropic Messages；
- Codex 使用 OpenAI Responses；
- Kimi Code 通过 `KIMI_MODEL_*` 临时进程变量连接同一条 Anthropic Messages route，不修改用户的 `config.toml`；
- bridge 把请求转换成 DSH `llm.stream`，保留当前模型选择器给出的精确 `provider + model` 及 reasoning/sampling 参数；
- 运行结束立即撤销 route，Host 停止时关闭 loopback server。

外部 Harness 不需要复制 DSH provider key，也不需要维护第二份模型列表。

### 缓存治理

- 外部 prompt 固定以 Harness 指令和 DSH system prompt 开头，后续历史只向尾部增长；不再把固定 Harness 指令放在每轮易变尾部。
- bridge 把 DSH `TokenUsage` 的互斥桶完整映射回 Anthropic Messages / OpenAI Responses，再按一轮外部 Harness 内的所有原生模型请求累计；最终只向外层 DSH stream 发送一次 `usage`。
- `inputTokens` 只表示累计未缓存输入，`cacheReadTokens` / `cacheWriteTokens` 独立累计，`reasoningTokens` 是累计 output 子集；额外的 `contextInputTokens` / `contextOutputTokens` 只保留末次内部模型调用，避免多次调用的累计计费量把上下文占用率错误推到 100%。
- DSH 原生 token meter 用累计桶计算总用量与缓存命中率，用末次调用样本计算 context pressure；两种口径共用原生 UI，不新增第二套统计界面。
- bridge 将 DSH session id 传给模型 route；支持 OpenAI Responses 的 DSH adapter 可据此派生稳定 `prompt_cache_key`。
- Anthropic 的 per-block `cache_control` 无法进入 DSH provider-neutral message schema，因此由当前 DSH provider adapter 按其 `cacheRetention` 配置重新放置 system / last-tool / last-user cache breakpoint，而不是复制外部 CLI 的 wire 字段。
- 第一次运行或安全 rollover 会发送 DSH 当前模型可见的 canonical surface；它可能包含 compaction checkpoint，而不保证等于原始全量日志。每条 canonical message 会标注其 DSH turn 与当时的执行 Harness，避免另一个 Harness 把历史回答里的第一人称身份、代号或私有记忆当成自己的。连续使用同一 lane 时恢复原生 session/thread 并只发送当前请求；切换到别的 Harness 后再切回时恢复停泊的 vendor id，并发送带 identity-isolation 约束的 `HARNESS HANDOFF`：只包含该 lane 离开后的已完成消息、对应 work ledger 与当前请求，绝不把完整历史再次注入已有 native history。
- 原生会话 lane 严格按 `DSH session × Harness × provider × model` 隔离。每次干净完成后仅持久化稳定 conversation spine 的消息数与 SHA-256 摘要，不保存第二份 transcript；spine 包含 user/model/tool 与持久 notice/relay/recall，排除会被 surface projection 替换的 snapshot/catalog/instructions。work ledger 是独立的有界派生状态，不参与水位线摘要。切回时必须用当前 DSH canonical messages 证明旧 spine 前缀未被编辑、压缩或清除，且 Session 事件证明缺口内每个 turn 都干净完成。
- 状态采用带 revision 的 CAS 更新，同一 lane 在完整运行与释放结束前保持 singleflight；过期失败不能删除或覆盖更新的 vendor id。恢复前先以 CAS 持久化 `vendorId: null` 的 consume claim，进程异常退出也不会重复发送同一 handoff；resume id 和新水位线只在干净的 `completed` 回合及进程释放后一起重新提交。claim 或最终提交失败都会在当前进程内隔离旧 lane。这里的 CAS、singleflight 与 quarantine 只承诺单个 DSH Host 进程；不承诺多个进程共享 `DSH_HOME` 时的文件锁、断电 fsync 或跨进程 ABA 防护。
- fingerprint 变化、canonical 水位线不匹配、历史收缩、Session 事件缺失/未完成、同 turn 重试、原生 id 失效或 32 个该 lane 的成功回合都会回到“新原生会话 + 当前 canonical surface + 最近 work ledger”。动态 snapshot/catalog/instructions 只随 fresh/full 更新，避免其频繁变化破坏停泊恢复；最迟在 32 次 lane 使用后刷新。无效 resume 最多在确认 prompt 尚未执行时透明回退一次；error/abort 会丢弃正在运行的 vendor lane。
- 状态文件 v3 最多保留 200 个原生 lane，并懒迁移 v2 记录；每个 session 的 dispatch 同时最多保留 400 个 turn，其中可带 v1 work ledger（20 个文件、10 条命令、10 条失败尝试）。旧 resume 记录仍可做一次连续恢复，成功后补齐水位线。Claude、Codex 与 Kimi 的持久化数据位于 DSH state 下的托管目录，不进入用户 CLI 的普通会话列表。vendor session 是可丢弃缓存，DSH Session 日志始终是唯一 canonical history。

双口径上下文修复需要 DSH 的 `TokenUsage` 与 token-meter 支持 `contextInputTokens` / `contextOutputTokens`。较旧的 DSH 构建会忽略新增字段：累计用量和缓存命中率仍正确，但上下文占用仍会按聚合输入计算。使用 v0.9.1 的上下文修复前，应先升级到包含该可选字段支持的 DSH 构建。

### 实时过程与安全边界

- Claude `thinking_delta`、Codex reasoning summary 和 Kimi ACP `agent_thought_chunk` 中可公开的当前回合过程映射为标准 DSH reasoning；provider-private bridge reasoning、Kimi 历史 replay update 与敏感诊断不会透传。
- Codex 在思考模型的一轮工具循环内必须回传 provider-private reasoning。bridge 将原文用持久 AES-256-GCM key 封装为标准 Responses `reasoning.encrypted_content`：Codex 托管会话和 wire 只看到不透明密文，下一次模型调用前才在 Host 内解封并与同批 assistant text/tool call 重组；密文无效时在调用 provider 前 fail closed。key 以 `0600` 位于 DSH state，仅用于避免 reasoning 明文进入原生日志，不构成能抵御同时读取 key 与托管状态的独立安全边界。
- 通过 DSH bridge 运行 Codex 时，app-server 使用固定的原生 capability model 身份生成工具目录，实际推理由用户选择的 DSH provider/model 负责；自定义模型名不会再让 Codex 静默丢失 `exec_command` 等原生工具。
- Kimi ACP `tool_call*` 与其他外部工具活动都映射为 reasoning 中的只读状态行，不产生 `tool-call-delta`。
- Kimi 默认不调用已知会卡住的原生 `Skill` 工具：adapter 在任务尾部追加稳定执行策略，让 Kimi 直接用 Read/Bash 打开 `.agents/skills/<name>/SKILL.md` 并遵循其内容。若模型仍意外调用原生 Skill，则保留兼容 watchdog：连续 30 秒无后续 ACP 活动时取消旧 prompt、创建新 ACP session 并直接读 Skill 文件恢复一次；新 session 完成首个非 Skill 原生工具后只关闭 watchdog，仍要求最终回答，避免长任务被误杀或工具完成被误报为答案。
- Kimi 工具型任务使用一个从用户输出中剥离的完成标记确认最终回答；若 ACP 在工具完成后以普通 `end_turn` 只返回检查预告，adapter 会在同 session 内追加一次有界 finalization prompt，而不是把预告误报为完成。
- Agent signal 会终止整个外部进程树；Codex 先尝试 `turn/interrupt`，Kimi Code 先发送 `session/cancel`。
- 非 `danger-full-access` 模式由 DSH 外层 `sandbox.confine()` 包裹。
- prompt 通过 stdin、app-server RPC 或 ACP JSON-RPC 传输，不出现在 argv。
- Kimi ACP 不声明文件 reverse-RPC 能力，文件与命令仍由受 DSH 外层 sandbox 包裹的 Kimi 子进程本地执行；原生恢复使用 DSH state 下的托管 `KIMI_CODE_HOME`。Codex 使用托管 `CODEX_HOME`，Claude 使用托管 `CLAUDE_CONFIG_DIR`，不会改写用户的普通 CLI 会话目录。
- bridge 仅监听 `127.0.0.1`，每个 route 使用随机 bearer token。
- 错误诊断不会回传 CLI 原始 stderr、route token 或环境变量。
- 当前前台外部 Harness 只接受文本请求：最新顶层用户消息含图片时会在 dispatch 前明确提示切回 DeepSeek Harness；历史图片及嵌套 tool-result 图片只保留稳定的省略占位符，不会伪装成已理解视觉内容。

## 目录结构

```text
├── preset.yml / agent.cordis.yml  # preset 元数据与 agent-plane composition
├── ally-prompt.mjs                # 联盟会话提示 section
├── cordis.patch.yml               # Web Profile 的 Host bundle patch
├── lib/
│   ├── index.js                   # Host wiring、transport 与 teardown
│   ├── runtime.js                 # Agent-loop router、全量/增量 prompt、实时过程与最终校准
│   ├── work-ledger.js             # activity 归一化、有界持久格式与 handoff 投影
│   ├── native-session.js          # 原生 lane 停泊、handoff、singleflight、CAS 与 rollover 编排
│   ├── harness.js                 # Claude partial messages、session persistence/resume
│   ├── codex-app-server.js        # Codex app-server、persistent thread/resume、interrupt
│   ├── kimi-acp.js                # Kimi ACP、durable session/load、恢复与 finalization
│   ├── bridge.js                  # Messages/Responses → DSH LLM loopback bridge
│   ├── reasoning-codec.js         # Codex 私有 reasoning 的 AES-GCM opaque replay
│   ├── cli-manager.js             # 全局优先/托管兜底的 CLI 生命周期
│   ├── state.js                   # Session 日志外的选择、badge 与原生 lane v3 水位线状态
│   └── client.js                  # Harness selector、安装按钮与徽标
├── test/                          # Node 回归测试
├── setup/install.mjs              # 跨平台、幂等的 Web Profile link 安装器
└── docs/DEVELOPMENT.md            # 开发、安全边界与版本约定
```

## 开发

仓库通过 `link:` 接入 Web Profile，因此同事可以直接在 clone 内迭代：

```bash
npm test
node --check lib/runtime.js
node --check lib/work-ledger.js
node --check lib/reasoning-codec.js
node --check lib/native-session.js
node --check lib/harness.js
node --check lib/codex-app-server.js
node --check lib/kimi-acp.js
```

Host/preset/client 的生产部署变更都需要重启现有 `dsh web`。只有同时在 DSH checkout 运行 `pnpm run dev:web` 时，client-plugin HMR 才会自动重建。

详细约定见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## 隐私

仓库不包含 API Key、OAuth token、CLI 登录态、DSH state、用户目录、项目路径或运行日志。模型凭据继续由本机 DSH/CLI 管理，不会写入本仓库。

如果贡献 issue/log，请先删除 Authorization header、环境变量、用户名路径、bridge token 和原始 CLI stderr。

## 许可

[MIT](LICENSE) © 2026 BaronCyrus
