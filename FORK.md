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
- `package.json`: version `0.2.13`, `@deepseek-ai/dsh-*` peers `^0.2.1-rc.1`.
- `0.2.13` — local-model routing for teammates:
  - `team_spawn` takes an optional `provider` (`AgentOptions.provider` already
    exists in DSH; `resolveChildAgentOptions()` overrides the parent route and
    drops the parent's route-owned effort), so one teammate can run on a
    locally served model while the leader stays on `deepseek-official`.
  - the spawn refuses an unregistered provider (`UNKNOWN_PROVIDER`, listing the
    registered routes) and a route change without a model id
    (`MODEL_REQUIRED`, because model ids are provider-scoped).
  - the route is recorded on the roster row (`provider`/`model`) and shown on
    the stage as `provider/model`.
  - new deployment knobs `teammateProvider` / `teammateModel` default every
    teammate route (empty = inherit the leader's), which is what makes "the
    whole team works on the local model" a two-line profile patch.

`dist/` is committed, so installing straight from git needs no build step.

## Install

```bash
dsh plugin --profile web add github:stcn52/dsh-team --config.auto-install-peers=false
```

The `--config.auto-install-peers=false` matters on pnpm < 9.15: the profile's
`autoInstallPeers: false` lives in `pnpm-workspace.yaml`, which older pnpm
ignores, so pnpm otherwise tries to install the prerelease-only
`@deepseek-ai/*` peers and fails on `No matching version found`.

## Building

`pnpm typecheck`, `pnpm test` and `pnpm build` all run against `0.2.1-rc.3`:

- `devDependencies` are on `0.2.1-rc.3`, and `pnpm-workspace.yaml` pins the
  whole `@deepseek-ai/*` family to the same line through `overrides`
  (`packages: ['.']` is declared explicitly because pnpm 9 rejects a
  workspace file without it).
- `unrun`, `zustand`, `immer` and `@testing-library/dom` are explicit dev
  dependencies; upstream relied on pnpm auto-installing peers, which a
  profile-style `auto-install-peers=false` install does not do.
- The test doubles were moved to `ctx.subagents.startActivation` (and
  `workingDirectory` is stubbed for `run_code`); the PTC test now builds a
  separate `ptc` registry because 0.2.1 made native/PTC presentation
  exclusive.

## Known limits
- The client bundle is unchanged from upstream; it was built against the 0.1.7
  client packages and happens to keep working on 0.2.1-rc.3 (verified: the
  「微型世界」 view, header presence, composer dock and tool cards all render).
