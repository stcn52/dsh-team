/**
 * The model-facing tools: what the model may ask for, what the conversation
 * card shows, and — the one that matters durably — that every mutating result
 * projects a fact the fold can read back.
 *
 * @module dsh-team/tests/tools
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readFact } from '../src/fold.ts'
import { TeamError } from '../src/errors.ts'
import { dismissTool, listTool, relationTool, sendTool, spawnTool, taskTool } from '../src/tools.ts'
import { fakeAgent, fakeExec, type FakeAgent } from './harness.ts'

/** Every call the tool layer made into the service. */
interface Recorded {
  readonly op: string
  readonly args: readonly unknown[]
}

/** The `ctx.team` double: records the call and answers with a fixed value. */
class FakeTeam {
  readonly calls: Recorded[] = []

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args })
  }

  spawn(...args: unknown[]): Promise<unknown> {
    this.record('spawn', ...args)
    return Promise.resolve({ memberId: 'child-1', name: 'Alice', role: 'reviewer', relation: 'peer', model: 'reasoner' })
  }

  send(...args: unknown[]): Promise<unknown> {
    this.record('send', ...args)
    return Promise.resolve({
      messageId: 'm1',
      recipient: { kind: 'member', id: 'child-1', name: 'Alice' },
      chain: { chainId: 'c1', hop: 0 },
    })
  }

  upsertTask(...args: unknown[]): unknown {
    this.record('upsertTask', ...args)
    return { taskId: 't1', title: 'ship it', status: 'active', assigneeId: 'child-1' }
  }

  setRelation(...args: unknown[]): unknown {
    this.record('setRelation', ...args)
    return { memberId: 'child-1', name: 'Alice', relation: 'managed' }
  }

  dismiss(...args: unknown[]): unknown {
    this.record('dismiss', ...args)
    return args[1] === undefined ? { ended: true } : { ended: false, memberId: 'child-1' }
  }

  list(...args: unknown[]): unknown {
    this.record('list', ...args)
    return {
      active: true,
      members: [{ memberId: 'child-1', name: 'Alice', relation: 'peer', status: 'running' }],
      tasks: [{ taskId: 't1', title: 'ship it', status: 'pending' }],
      messages: [{ messageId: 'm1', to: 'child-1', kind: 'message', text: 'go', time: 1 }],
    }
  }
}

/** Run one tool the way the registry does: validated args, live exec context. */
async function run(tool: ToolDefinition, args: unknown, agent: FakeAgent): Promise<JsonValue> {
  return await tool.execute(args, fakeExec(agent) as unknown as ToolRunContext) as JsonValue
}

/** The result shape a presenter receives for a successful call. */
function ok(): ToolResult {
  return { content: [{ type: 'text', text: 'done' }] } as unknown as ToolResult
}

/** The result shape a presenter receives for a refused call. */
function failed(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] } as unknown as ToolResult
}

let ctx: Context
let team: FakeTeam
let leader: FakeAgent

beforeEach(() => {
  ctx = new Context()
  team = new FakeTeam()
  ctx.provide('team', team)
  leader = fakeAgent('leader-1')
})

describe('team_spawn', () => {
  it('passes the whole request through and returns the roster row', async () => {
    const tool = spawnTool(ctx)
    const value = await run(tool, {
      name: 'Alice', task: 'review the diff', relation: 'peer', role: 'reviewer',
      persona: 'terse', provider: 'qwen-local', model: 'qwen3.8', reasoning_effort: 'high',
    }, leader)

    expect(team.calls[0]?.op).toBe('spawn')
    expect(team.calls[0]?.args[1]).toEqual({
      name: 'Alice', task: 'review the diff', relation: 'peer', role: 'reviewer',
      persona: 'terse', provider: 'qwen-local', model: 'qwen3.8', reasoningEffort: 'high',
    })
    expect(value).toEqual({
      memberId: 'child-1', name: 'Alice', role: 'reviewer', relation: 'peer', model: 'reasoner',
    })
  })

  it('projects a durable fact the fold reads back whole', async () => {
    const tool = spawnTool(ctx)
    const args = { name: 'Alice', task: 'x', relation: 'peer' as const }
    const value = await run(tool, args, leader)
    const meta = tool.output.presentationMeta?.(args, value)
    expect(readFact(meta)).toEqual({
      team: 'member-added',
      member: { memberId: 'child-1', name: 'Alice', role: 'reviewer', relation: 'peer', model: 'reasoner' },
    })
  })

  it('declares the provider route a local model needs', () => {
    const properties = (spawnTool(ctx).parameters?.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toContain('provider')
    expect(JSON.stringify(properties['provider'])).toContain('qwen-local')
  })

  it('rejects arguments the model got wrong before reaching the service', async () => {
    await expect(run(spawnTool(ctx), { name: 'Alice', task: 'x' }, leader)).rejects.toThrow()
    await expect(run(spawnTool(ctx), { name: 'Alice', task: 'x', relation: 'boss' }, leader)).rejects.toThrow()
    expect(team.calls).toHaveLength(0)
  })

  it('titles both cards from the teammate, and says so when the spawn failed', () => {
    const tool = spawnTool(ctx)
    const args = { name: 'Alice', task: 'x', relation: 'peer' as const, role: 'reviewer' }
    expect(tool.presentCall?.(args)).toMatchObject({ card: 'generic', title: 'Spawn teammate Alice' })
    expect(tool.presentResult?.(args, ok())).toMatchObject({ title: 'Alice joined the team' })
    expect(JSON.stringify(tool.presentResult?.(args, failed('the team is full')))).toContain('the team is full')
  })

  it('never joins a parallel group: a roster write is not concurrency safe', () => {
    expect(spawnTool(ctx).isConcurrencySafe?.({ name: 'A', task: 'x', relation: 'peer' })).toBe(false)
  })
})

describe('team_send', () => {
  it('records the delivered text as the durable fact, not the tool value', async () => {
    const tool = sendTool(ctx, 'leader')
    const args = { to: 'Alice', message: 'please review' }
    const value = await run(tool, args, leader)
    expect(value).toEqual({ messageId: 'm1', to: 'child-1', name: 'Alice', hop: 0 })
    expect(readFact(tool.output.presentationMeta?.(args, value))).toEqual({
      team: 'message', messageId: 'm1', to: 'child-1', text: 'please review', hop: 0,
    })
  })

  it('describes itself differently to a leader and to a teammate', () => {
    expect(sendTool(ctx, 'leader').description).toContain('one teammate')
    expect(sendTool(ctx, 'member').description).toContain('"leader"')
  })

  it('shows the recipient on both cards', () => {
    const tool = sendTool(ctx, 'member')
    const args = { to: 'leader', message: 'found a bug' }
    expect(tool.presentCall?.(args)).toMatchObject({ title: 'Message leader', rawInput: 'found a bug' })
    expect(tool.presentResult?.(args, ok())).toMatchObject({ title: 'Message sent to leader' })
  })
})

describe('team_task', () => {
  it('creates and updates through one tool, and folds back as the whole row', async () => {
    const tool = taskTool(ctx)
    const args = { title: 'ship it', assignee: 'Alice', status: 'active' as const }
    const value = await run(tool, args, leader)
    expect(team.calls[0]?.args[1]).toEqual({ title: 'ship it', assigneeId: 'Alice', status: 'active' })
    expect(readFact(tool.output.presentationMeta?.(args, value))).toEqual({
      team: 'task', task: { taskId: 't1', title: 'ship it', status: 'active', assigneeId: 'child-1' },
    })
  })

  it('titles the card by what the call does', () => {
    const tool = taskTool(ctx)
    expect(tool.presentCall?.({ title: 'ship it' })).toMatchObject({ title: 'New task: ship it' })
    expect(tool.presentCall?.({ task_id: 't1', status: 'done' })).toMatchObject({ title: 'Update task t1' })
    expect(tool.presentResult?.({ title: 'ship it' }, ok())).toMatchObject({ title: 'Task added: ship it' })
    expect(tool.presentResult?.({ task_id: 't1' }, ok())).toMatchObject({ title: 'Task t1 updated' })
  })
})

describe('team_relation and team_dismiss', () => {
  it('folds a widened teammate back as a member update', async () => {
    const tool = relationTool(ctx)
    const args = { member: 'Alice', relation: 'managed' as const }
    const value = await run(tool, args, leader)
    expect(readFact(tool.output.presentationMeta?.(args, value))).toEqual({
      team: 'member-updated',
      member: { memberId: 'child-1', name: 'Alice', relation: 'managed' },
    })
  })

  it('folds one dismissal as a removal and a whole-team dismissal as an end', async () => {
    const tool = dismissTool(ctx)
    const single = await run(tool, { member: 'Alice' }, leader)
    expect(readFact(tool.output.presentationMeta?.({ member: 'Alice' }, single)))
      .toEqual({ team: 'member-removed', memberId: 'child-1' })

    const whole = await run(tool, {}, leader)
    expect(readFact(tool.output.presentationMeta?.({}, whole))).toEqual({ team: 'ended' })
    expect(tool.presentCall?.({})).toMatchObject({ title: 'Disband the team' })
    expect(tool.presentResult?.({}, ok())).toMatchObject({ title: 'Team disbanded' })
  })
})

describe('team_list', () => {
  it('reads the team without writing anything durable', async () => {
    const tool = listTool(ctx)
    const value = await run(tool, {}, leader)
    expect(tool.output.presentationMeta).toBeUndefined()
    expect(value).toEqual({
      active: true,
      members: [{ memberId: 'child-1', name: 'Alice', relation: 'peer', status: 'running' }],
      tasks: [{ taskId: 't1', title: 'ship it', status: 'pending' }],
      messages: [{ from: 'leader', to: 'child-1', text: 'go' }],
    })
    expect(tool.presentCall?.({})).toMatchObject({ kind: 'read', title: 'Read the team' })
  })

  it('summarises the team for the model in one line', async () => {
    const tool = listTool(ctx)
    const value = await run(tool, {}, leader)
    expect(JSON.stringify(tool.output.render({}, value))).toContain('1 teammate(s), 1 open task(s)')
  })
})

describe('acting agent', () => {
  it('fails loud when a team tool runs without one', async () => {
    await expect(listTool(ctx).execute({}, { signal: new AbortController().signal } as unknown as ToolRunContext))
      .rejects.toThrow(/acting agent/)
  })

  it('lets a service refusal reach the model as the tool error', async () => {
    ctx.reflect.set('team', {
      send: () => Promise.reject(new TeamError('UNAUTHORIZED', 'Bob is a managed teammate')),
    })
    await expect(run(sendTool(ctx, 'member'), { to: 'Alice', message: 'hi' }, leader))
      .rejects.toThrow(/managed teammate/)
  })
})
