/**
 * dsh-team: agent teams for DeepSeek Harness.
 *
 * One plugin row, four registrations: the `ctx.team` service, the leader tool
 * set on every ordinary session, the teammate world on every continuable child
 * that belongs to a team, and the human `/agent-teams` slash command.
 * Teammates themselves are `ctx.subagents` continuable children — the harness
 * owns their sessions, residency, cold resume, and the `origin: 'subagent'`
 * classification that keeps them out of the session tree.
 *
 * @module dsh-team
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './types.ts'
import { Config, type TeamConfig } from './config.ts'
import { installCommand } from './command.ts'
import { teamProjection } from './projection.ts'
import { TeamService } from './service.ts'
import { installTeammateWorkspace, installTeammateWorld } from './teammate.ts'
import { boardTool, dismissTool, listTool, noteTool, relationTool, sendTool, spawnTool, taskTool } from './tools.ts'
import { installLeaderRouting } from './routing.ts'
import { TeamWorkspace } from './workspace.ts'

export const name = 'team'
/**
 * `tools` and `systemPrompt` are declared although this row registers into
 * agent scopes rather than the root registry: a Loader ordering mistake then
 * fails at load instead of at the next session or teammate.
 */
export const inject = ['agents', 'subagents', 'sessionProjections', 'tools', 'systemPrompt']

export { Config }
export type { TeamConfig }
export { TeamService } from './service.ts'
export { TeamError } from './errors.ts'
export type { TeamErrorCode } from './errors.ts'
export { foldTeam } from './fold.ts'
export type { TeamFact, TeamMemberFact } from './fold.ts'
export { teamProjection } from './projection.ts'
export { TeamWorkspace, WORKSPACE_DOMAIN, SHARED_AREA } from './workspace.ts'
export type { WorkspaceEntry } from './workspace.ts'
export * from './contract.ts'

/** A team leader is any ordinary session; a teammate never leads its own team. */
function leads(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent'
}

/**
 * Install the leader tool set into one session's own agent scope, so an
 * ordinary subagent — which inherits the global registry but not this scope —
 * never sees tools that would fail for it.
 * @param ctx - context carrying the team service.
 * @param agent - the session agent to equip.
 * @returns the disposer for every registration made here.
 */
function installLeaderTools(ctx: Context, config: TeamConfig, agent: Agent): () => void {
  const disposers = [
    installLeaderRouting(ctx, config, agent),
    agent.ctx.tools.register(spawnTool(ctx)),
    agent.ctx.tools.register(sendTool(ctx, 'leader')),
    agent.ctx.tools.register(taskTool(ctx)),
    agent.ctx.tools.register(relationTool(ctx)),
    agent.ctx.tools.register(dismissTool(ctx)),
    agent.ctx.tools.register(listTool(ctx)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Equip every leader session, now and as sessions arrive, with one tool set.
 * @param ctx - the context owning the registrations.
 * @param install - what to register into one leader's own agent scope.
 * @returns the disposer taking the tools off every session that outlives it.
 */
function equipLeaders(ctx: Context, install: (agent: Agent) => () => void): () => void {
  const equipped = new Map<SessionId, () => void>()
  const equip = (agent: Agent): void => {
    if (!leads(agent) || equipped.has(agent.id)) return
    equipped.set(agent.id, install(agent))
  }
  // Subscribe before seeding, so a session published during this pass is
  // equipped exactly once (the id set makes the overlap harmless).
  ctx.on('agent/created', (payload: { agent: Agent }) => { equip(payload.agent) })
  ctx.on('agent/disposed', (payload: { agent: Agent }) => { equipped.delete(payload.agent.id) })
  for (const agent of ctx.agents.list()) equip(agent)
  return () => {
    // The registrations are agent-owned; unloading this row must still take
    // the tools off sessions that outlive it.
    for (const dispose of equipped.values()) dispose()
    equipped.clear()
  }
}

/**
 * The virtual workspaces, when the deployment composed a storage domain form.
 * Without one the team keeps everything else and the workspace tools are never
 * registered — no member sees a tool that has nowhere to write.
 * @param ctx - a context whose `team` service is resolved.
 * @param config - the validated row configuration.
 */
function installWorkspaces(ctx: Context, config: TeamConfig): void {
  ctx.inject(['storageDomain'], (workspaceCtx: Context) => {
    const workspace = new TeamWorkspace(workspaceCtx, config)
    workspaceCtx.effect(() => () => { workspace.dispose() }, 'team: workspace domain')

    // Notes outlive turns, not teams: a disbanded team's board and a dismissed
    // member's private pad have no owner left to read them.
    workspaceCtx.on('team/changed', (payload: {
      leaderId: SessionId
      ended?: boolean
      removedMember?: string
    }) => {
      if (payload.ended === true) void workspace.clear(payload.leaderId)
      else if (payload.removedMember !== undefined) void workspace.clear(payload.leaderId, payload.removedMember)
    })

    workspaceCtx.effect(() => equipLeaders(workspaceCtx, agent => {
      const disposers = [
        agent.ctx.tools.register(noteTool(workspace, 'leader', actor => workspaceCtx.team.seatOf(actor))),
        agent.ctx.tools.register(boardTool(workspace, 'leader', actor => workspaceCtx.team.seatOf(actor))),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }), 'team: leader workspace tools')

    workspaceCtx.effect(
      () => installTeammateWorkspace(workspaceCtx, workspace),
      'team: teammate workspace tools',
    )
  })
}

/**
 * Compose the team capability: the service, the durable projection unit, the
 * teammate world, the per-session leader tools, the virtual workspaces, and
 * the human `/agent-teams` command.
 *
 * `commands` is injected softly rather than declared on the row, like
 * `storageDomain`: UI-less compositions ship no command adapter, and the row
 * must load there with every other capability intact.
 *
 * @param ctx - the row's context.
 * @param config - the validated row configuration.
 */
export function apply(ctx: Context, config: TeamConfig): void {
  ctx.plugin(TeamService, config)
  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.effect(() => installCommand(commandCtx), 'team: /agent-teams command')
  })
  ctx.inject(['team'], (teamCtx: Context) => {
    teamCtx.effect(
      () => teamCtx.sessionProjections.register(teamProjection(config.maxRecentMessages)),
      'team: durable projection unit',
    )
    teamCtx.effect(() => installTeammateWorld(teamCtx), 'team: teammate world')
    teamCtx.effect(
      () => equipLeaders(teamCtx, agent => installLeaderTools(teamCtx, config, agent)),
      'team: leader tools',
    )
    installWorkspaces(teamCtx, config)
  })
}
