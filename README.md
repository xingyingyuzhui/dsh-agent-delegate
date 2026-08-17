# dsh-agent-delegate · 委派 Broker

治理套件 **Phase 3**：在官方 `ctx.subagents` 上加一层委派边界。不提供控制面 UI。

- 按父链真实计数委派深度，超过 `policy.delegation.maxDepth` 的 `subagent` 调用直接拒绝
- child 策略 = parent ∩ child（更紧的赢）；写入型 child 的 `files.write: all` 会收到 `workspace`
- **仅**写入型 child / 并行写入任务分配独立 Git worktree，并把它钉成该 child 的 cwd；主会话继续写项目根
- `research` / `reviewer` / `public`（或 `sandbox.requireEnforcement: full`）在 sandbox 报告 `partial` 时拒绝文件动作，不降级放行

卸掉本插件后不再建 worktree、不再做深度/衰减拦截，回落到 DSH 原有子代理行为（以及仍装着的 `dsh-agent-gate`）。

## 安装

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-agent-delegate
```

建议同时安装 `dsh-session-permissions` 与 `dsh-agent-gate`。装完重启 `dsh web`。

## 卸载

```sh
dsh plugin --profile web remove dsh-agent-delegate
```

## License

MIT
