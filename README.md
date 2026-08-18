# dsh-agent-delegate · 委派 Broker

治理套件 **Phase 3**：在官方 `ctx.subagents` 上加一层委派边界。不提供控制面 UI。

- 按父链真实计数委派深度，超过 `policy.delegation.maxDepth` 的 `subagent` 调用直接拒绝
- 可点名角色（`role` / `[research]` 标签 / `role: reviewer` 提示词）。child = parent ∩ 角色预设；不在 `delegation.roles` 里的角色直接拒绝（developer 默认只能派 `research` / `reviewer`）
- 默认最多 4 个未结束的 child / 并行写入任务；超出 `delegation.maxChildren` 拒绝。handoff 默认截到 64KiB
- Parent 按 task + generation 收结果；同一任务更新一代之后，旧 child 的 `report` / 返回值作废
- child 策略 = parent ∩ child（更紧的赢）；写入型 child 的 `files.write: all` 会收到 `workspace`
- **仅**写入型 child 与后台写入任务分配独立 Git worktree；主会话和前台 bash 继续写项目根。创建时会把父工作区未提交改动和非忽略的未跟踪文件拷进 worktree。结束前把 child 相对种子提交的 diff 写成 `~/.dsh/agent-delegate/handoffs/<id>.patch` 并写进父任务回传，**不会自动 merge**。父任务验收后自行 `git apply`。
- `research` / `reviewer` / `public`（或 `sandbox.requireEnforcement: full`）在 sandbox 报告 `partial` 时拒绝文件动作，不降级放行

卸掉本插件后不再建 worktree、不再做深度/衰减拦截，回落到 DSH 原有子代理行为（以及仍装着的 `dsh-agent-gate`）。

## 安装

```sh
dsh plugin --profile web add github:xingyingyuzhui/dsh-agent-delegate
```

建议同时安装 `dsh-session-permissions` 与 `dsh-agent-gate`。装完重启 `dsh web`。

本地开发：

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-agent-delegate
```

## 卸载

```sh
dsh plugin --profile web remove dsh-agent-delegate
```

## License

MIT
