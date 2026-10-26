/**
 * Team mode: the preset-scoped gate that makes the team preset self-starting
 * instead of depending on a `/agent-teams` command.
 *
 * The plugin is mounted here through a real cordis fiber so the two properties
 * that matter are the production ones: `ctx.inject(['team'])` is soft (a
 * composition without dsh-team still loads) and `ctx.effect` owns both
 * registrations (disposing the preset removes the section and the guard).
 *
 * @module dsh-team/tests/team-mode
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  apply, TEAM_MODE_ALLOWED, TEAM_MODE_ALLOWED_PREFIXES, TEAM_MODE_DENIAL, TEAM_MODE_ORDER, TEAM_MODE_SECTION,
} from '../src/team-mode.ts'
import { FakeSystemPrompt, FakeTools, fakeAgent, type FakeAgent } from './harness.ts'

/** The only fact the guard reads from the service: the calling agent's roster. */
class FakeTeam {
  members: Array<{ readonly memberId: string }> = []

  list(_agent: unknown): { members: Array<{ readonly memberId: string }> } {
    return { members: this.members }
  }
}

/** One mounted scene: a root context carrying the three fake seams. */
interface Scene {
  readonly ctx: Context
  readonly tools: FakeTools
  readonly prompt: FakeSystemPrompt
  readonly team: FakeTeam
  readonly leader: FakeAgent
  readonly fork: Fiber
}

/**
 * Mount team-mode on fresh fakes. `withTeam: false` composes the deployment
 * that has no dsh-team row at all — the row must still load.
 * @param options - which services the composition provides.
 * @returns the mounted scene, ready for guard calls.
 */
async function mount(options: { readonly withTeam?: boolean } = {}): Promise<Scene> {
  const ctx = new Context()
  const tools = new FakeTools()
  const prompt = new FakeSystemPrompt()
  const team = new FakeTeam()
  const leader = fakeAgent('leader-1')
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', prompt)
  if (options.withTeam !== false) ctx.provide('team', team)
  const fork = ctx.plugin({ name: 'team-mode', inject: ['tools', 'systemPrompt'], apply })
  await fork
  return { ctx, tools, prompt, team, leader, fork }
}

/**
 * Run every registered guard the way the pipeline does: farthest first, first
 * denial wins.
 * @param scene - the mounted scene.
 * @param tool - the model-requested tool name.
 * @param agent - the calling agent; `null` stands for a context-global call.
 * @returns the denial reason, or `undefined` when the call is allowed.
 */
function guardReason(
  scene: Scene,
  tool: string,
  agent: FakeAgent | null = scene.leader,
): string | undefined {
  const execution = agent === null ? { name: tool } : { name: tool, agent: agent.agent }
  for (const guard of scene.tools.guards) {
    const reason = guard(execution)
    if (reason !== undefined) return reason
  }
  return undefined
}

describe('no-teammate tool gate', () => {
  it('denies self-directed investigation before the first teammate exists', async () => {
    const scene = await mount()
    for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'subagent', 'job_output']) {
      expect(guardReason(scene, tool), tool).toBe(TEAM_MODE_DENIAL)
    }
  })

  it('admits every team_* tool plus the advisory set, so the model can get out of the gate', async () => {
    const scene = await mount()
    const tools = [
      'team_spawn', 'team_send', 'team_task', 'team_relation', 'team_dismiss', 'team_list',
      'team_note', 'team_board', 'team_profile', 'team_review', 'team_forget',
      ...TEAM_MODE_ALLOWED,
    ]
    for (const tool of tools) expect(guardReason(scene, tool), tool).toBeUndefined()
  })

  it('admits the bookkeeping families, so dismissing the last teammate does not strand the record', async () => {
    const scene = await mount()
    expect(TEAM_MODE_ALLOWED_PREFIXES).toEqual(['mnemon_', 'schedule_'])
    const tools = [
      // Memory and dossier accounting: reading and writing the durable stores.
      'mnemon_runtime_memory', 'mnemon_recall', 'mnemon_remember', 'mnemon_forget',
      'mnemon_document_search', 'mnemon_document_create', 'mnemon_document_manage',
      'mnemon_status', 'mnemon_memory_bodies', 'mnemon_memory_body_create',
      // Reminders: session bookkeeping, no repository access.
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    ]
    for (const tool of tools) expect(guardReason(scene, tool), tool).toBeUndefined()
  })

  it('still refuses the investigation and execution surface, including look-alike names', async () => {
    const scene = await mount()
    for (const tool of [
      'bash', 'read', 'write', 'edit', 'glob', 'grep',
      'web_search', 'web_fetch', 'browser_open', 'browser_click',
      'subagent', 'subagent_fork', 'job_output', 'job_kill',
      // Exact names stay exact: sharing a first word with an allowed tool is
      // not a licence, and a prefix family only reaches its own separator.
      'mnemosyne_notes', 'create_goal_now',
    ]) {
      expect(guardReason(scene, tool), tool).toBe(TEAM_MODE_DENIAL)
    }
  })

  it('lifts the gate once a teammate exists', async () => {
    const scene = await mount()
    expect(guardReason(scene, 'bash')).toBe(TEAM_MODE_DENIAL)
    scene.team.members.push({ memberId: 'child-1' })
    expect(guardReason(scene, 'bash')).toBeUndefined()
    expect(guardReason(scene, 'read')).toBeUndefined()
  })

  it('never gates a subagent, which inherits the preset scope through its parent', async () => {
    const scene = await mount()
    const child = fakeAgent('child-1', { parent: 'leader-1' })
    expect(guardReason(scene, 'bash', child)).toBeUndefined()
  })

  it('leaves an execution with no agent alone (the context-global registry view)', async () => {
    const scene = await mount()
    expect(guardReason(scene, 'bash', null)).toBeUndefined()
  })
})

describe('hard-rules section', () => {
  it('registers one section right after the persona and before plan policy', async () => {
    const scene = await mount()
    expect(scene.prompt.sections.map(section => section.name)).toEqual(['team-mode'])
    expect(scene.prompt.sections[0]!.order).toBe(TEAM_MODE_ORDER)
    expect(TEAM_MODE_ORDER).toBeGreaterThan(0)
    expect(TEAM_MODE_ORDER).toBeLessThan(500)
  })

  it('states the first action, the investigation ban, the pure-question exception and the dismissal rule', async () => {
    const scene = await mount()
    const text = scene.prompt.sections[0]!.text()
    expect(text).toBe(TEAM_MODE_SECTION)
    for (const keyword of [
      'team_spawn', 'bash', 'read', 'grep', 'glob', 'edit',
      '纯问答', 'subagent', 'team_dismiss', '复核',
    ]) {
      expect(text, keyword).toContain(keyword)
    }
  })
})

describe('soft team injection', () => {
  it('mounts the prompt and installs no guard when no team service exists', async () => {
    const scene = await mount({ withTeam: false })
    expect(scene.prompt.sections.map(section => section.name)).toEqual(['team-mode'])
    expect(scene.tools.guards).toEqual([])
  })

  it('installs the guard when the team service appears later', async () => {
    const scene = await mount({ withTeam: false })
    scene.ctx.provide('team', scene.team)
    await Promise.resolve()
    expect(scene.tools.guards).toHaveLength(1)
    expect(guardReason(scene, 'bash')).toBe(TEAM_MODE_DENIAL)
  })
})

describe('disposal', () => {
  it('takes the guard and the section back out with the preset scope', async () => {
    const scene = await mount()
    expect(guardReason(scene, 'bash')).toBe(TEAM_MODE_DENIAL)
    expect(scene.prompt.sections).toHaveLength(1)
    await scene.fork.dispose()
    expect(scene.tools.guards).toEqual([])
    expect(scene.prompt.sections).toEqual([])
    expect(guardReason(scene, 'bash')).toBeUndefined()
  })
})
