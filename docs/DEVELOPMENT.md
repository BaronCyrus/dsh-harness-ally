# Development

## Architecture

Harness联盟模式分为两个平面：

- **Host bundle (`lib/`)**：跨会话共享 Harness 选择、CLI 检测/托管安装、Claude/Codex 进程、DSH 模型协议桥、LLM waterfall router、取消与状态持久化。
- **Agent preset (`agent.cordis.yml`)**：为一个联盟会话提供标准编码工具、联盟提示和 `subagent_claude_code` / `subagent_codex`。

DSH 始终拥有 turn、step、history、checkpoint、权限和取消。Claude Code/Codex 只充当外部执行 Harness 和模型适配器。

## Safety invariants

1. Harness 选择器仅在 preset id 为 `harness-ally` 的会话出现。
2. Standard 模式必须完全看不到该选择器。
3. 不复制或替换 DSH 原生模型选择器。
4. 外部工具活动只映射为 reasoning 中的只读状态，禁止产生 DSH `tool-call-delta`，否则同一工具会被重复执行。
5. 非 `danger-full-access` 模式由 DSH 外层 sandbox 包裹整个 CLI 进程树。
6. Prompt 通过 stdin / app-server RPC 传输，不进入 argv。
7. bridge token、CLI stderr、环境变量和本机凭据不得进入用户诊断或仓库。
8. 所有进程、route、signal 监听器和队列必须可取消且幂等释放。

## Tests

```bash
npm test
node --check lib/index.js
node --check lib/runtime.js
node --check lib/harness.js
node --check lib/codex-app-server.js
```

测试覆盖选择隔离、同源写保护、CLI 托管、模型桥、Claude partial messages、Codex app-server、实时 reasoning/activity、取消、最终文本校准和 Host teardown。

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

每次可见行为或协议变更都递增 `package.json` 版本，并同步 `lib/codex-app-server.js` 中的 app-server `clientInfo.version`。发布前运行完整测试、`npm pack --dry-run --json` 和隐私扫描。
