# stcn52 fork of dsh-team

Base: [huxint/dsh-team](https://github.com/huxint/dsh-team) @ `3ac6985` (0.2.11).

## Why

DSH **0.2.1-rc.3** replaced `ctx.subagents.startContinuable(spec)` with
`ctx.subagents.startActivation(spec)`, which additionally requires a `delivery`
policy (`'parent'` notifies the parent's model, `'caller'` only returns the
result). Upstream 0.2.11 still calls the removed method, so `team_spawn` fails
with `this.ctx.subagents.startContinuable is not a function`.

## Patch

- `src/service.ts`, `dist/index.js`: `startContinuable` → `startActivation`,
  passing `delivery: 'parent'` (matches the pre-0.2.1 continuable behaviour:
  the leader's model is notified when a teammate settles).
- `package.json`: version `0.2.12`, `@deepseek-ai/dsh-*` peers `^0.2.1-rc.1`.

`dist/` is committed, so installing straight from git needs no build step.

## Install

```bash
dsh plugin --profile web add github:stcn52/dsh-team --config.auto-install-peers=false
```

The `--config.auto-install-peers=false` matters on pnpm < 9.15: the profile's
`autoInstallPeers: false` lives in `pnpm-workspace.yaml`, which older pnpm
ignores, so pnpm otherwise tries to install the prerelease-only
`@deepseek-ai/*` peers and fails on `No matching version found`.
