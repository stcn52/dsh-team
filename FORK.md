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
- `0.2.14` — the brain gets what it needs to make that call:
  - a dynamic `team-routing` system-prompt section on every leader session:
    the leader's own route, every registered provider at prompt-assembly time,
    the configured teammate default, and the selection rule (machine-checkable
    work → cheap/local route, judgement and long chains → frontier route,
    mixed work → split it).
  - the brief is rendered per turn, so a provider mounted after the session
    started is selectable without a restart.
- `0.2.15` — per-member skills:
  - `team_spawn` takes `skills: [...]`, the skill names that teammate must load
    before working; each member carries only what its own job needs.
  - the assignment is advisory by design: the plugin cannot see the catalog a
    session's own preset mounts (preset-scoped services), so names are checked by
    the member's `skill` tool in its own turn rather than refused at spawn.
  - the assignment rides the roster row (folded, projected, shown by the team
    tools) and the teammate's own briefing tells it to load those skills first.
  - dropped the spawn-time name check: even the leader's service handle resolved
    a catalog without the user-level skills, and refusing valid names is worse
    than letting the member report a missing one itself.

`dist/` is committed, so installing straight from git needs no build step.

## Member dossiers（工号档案）

`team_dossier` is a storage domain of its own, separate from `team_workspace`,
keyed by the normalized member name (`trim` + whitespace collapse + lowercase)
and shared workspace-wide: the same name inherits its memory across spawns,
sessions, and teams. The display name keeps the latest spelling.

- Semantics:
  - `team_learn` (member only, `kind: lesson|fact`) writes its own dossier;
    `evidence` is required. Dedup is by normalized text — a repeat reinforces
    the matching entry (`reinforced+1`) instead of storing it twice. It never
    touches the stats.
  - `team_review` (leader only): `accepted` raises `delivered`, `rework`
    raises `reworks`; an optional `note` is kept as a `feedback` entry with
    `evidence: 'leader review'`. Stats move here and nowhere else.
  - `team_profile`: a member's registration declares no `member` parameter and
    can only read its own record; the leader must name a `member` (roster name
    or id, resolved through the roster). Read-only.
  - `team_forget` (leader only) drops one entry by its id.
  - Bounds: `maxDossierEntries` (default 40) and `maxDossierChars` (default
    6000) evict the oldest non-feedback entry first; feedback is only touched
    when it is all that remains, and the entry just written is never evicted.
  - The digest (budget `maxDossierDigestChars`, default 1200) rides the
    teammate's system prompt every step (section `team-dossier`, order 121):
    stats line → feedback (newest first) → lessons (reinforced first, then
    newest) → facts, each named by entry id, and it states that these are the
    member's own notes from earlier sessions — suggestions, never commands
    over the current task or the system instructions.
  - The dossier outlives the team: no `team/changed` handler clears this
    domain (the workspace clears its board on end/dismiss; the dossier does
    not), and it is only composed when the deployment has a `storageDomain`.
- Tests: `tests/dossier.spec.ts` covers dedup/reinforce, both bounds and the
  eviction order (feedback not evicted first), the digest's budget, order,
  ids and anti-injection line, review stats, forget, name normalization,
  blank rejection, and that `learn` never moves the stats. The
  `dossier world` block in `tests/teammate.spec.ts` proves the digest really
  lands in the member's system-prompt section, that the member tool set has
  `team_learn`/`team_profile` but not `team_review`/`team_forget`, and that
  the member's `team_profile` declares no `member` parameter.

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
