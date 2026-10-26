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
import { foldTeam, readFact } from '../src/fold.ts'
import { TeamError } from '../src/errors.ts'
import { REPORT_LINE_MAX_CHARS, dismissTool, listTool, relationTool, sendTool, spawnTool, taskCloseTool, taskTool, waitTool } from '../src/tools.ts'
import { waitReport } from '../src/client/toolResult.ts'
import { fakeAgent, fakeExec, toolResultEvent, type FakeAgent } from './harness.ts'

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

  closeTask(...args: unknown[]): unknown {
    this.record('closeTask', ...args)
    return { taskId: 't1', title: 'ship it', status: 'done', assigneeId: 'child-1', note: 'merged' }
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
    return this.teamRead()
  }

  async listWithBoard(...args: unknown[]): Promise<unknown> {
    this.record('listWithBoard', ...args)
    return {
      ...this.teamRead(),
      board: [
        { key: 'plan', authorId: 'child-1', authorName: 'Alice', updatedAt: 200, preview: 'we keep v1' },
        { key: 'risks', authorId: 'child-1', authorName: 'Alice', updatedAt: 100, preview: 'db migration first' },
      ],
    }
  }

  /** The roster read both list methods start from. */
  private teamRead(): Record<string, unknown> {
    return {
      active: true,
      members: [{ memberId: 'child-1', name: 'Alice', relation: 'peer', status: 'running' }],
      tasks: [{ taskId: 't1', title: 'ship it', status: 'pending' }],
      messages: [{ messageId: 'm1', to: 'child-1', kind: 'message', text: 'go', time: 1 }],
    }
  }

  async wait(...args: unknown[]): Promise<unknown> {
    this.record('wait', ...args)
    return {
      done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true,
      reports: [{ member: 'Alice', text: 'reviewed the diff: no findings' }],
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
      persona: 'terse', provider: 'qwen-local', model: 'qwen3.8', reasoning_effort: 'high', skills: ['deep-brief'],
    }, leader)

    expect(team.calls[0]?.op).toBe('spawn')
    expect(team.calls[0]?.args[1]).toEqual({
      name: 'Alice', task: 'review the diff', relation: 'peer', role: 'reviewer',
      persona: 'terse', provider: 'qwen-local', model: 'qwen3.8', reasoningEffort: 'high', skills: ['deep-brief'],
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

  it('declares the per-member skill assignment', () => {
    const properties = (spawnTool(ctx).parameters?.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toContain('skills')
    expect(JSON.stringify(properties['skills'])).toContain('deep-brief')
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

  it('accepts one address, a list, or the wildcard, and refuses anything else', async () => {
    const tool = sendTool(ctx, 'leader')
    await expect(run(tool, { to: 'Alice', message: 'x' }, leader)).resolves.toMatchObject({ messageId: 'm1' })
    await expect(run(tool, { to: ['Alice', 'Bob'], message: 'x' }, leader)).resolves.toBeDefined()
    await expect(run(tool, { to: '*', message: 'x' }, leader)).resolves.toBeDefined()
    expect(team.calls.at(-1)?.args[1]).toBe('*')
    await expect(tool.execute({ to: 42, message: 'x' }, fakeExec(leader) as unknown as ToolRunContext))
      .rejects.toThrow(/invalid arguments/)
    // The address parameter is one exact-one union, so the model is told it may
    // pass either form rather than having to guess at a separator.
    expect(tool.parameters).toMatchObject({
      properties: { to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
    })
  })

  it('broadcasts through one call and reports one fact per recipient', async () => {
    const tool = sendTool(ctx, 'leader')
    ctx.reflect.set('team', {
      send: () => Promise.resolve({
        deliveries: [
          { messageId: 'm1', recipient: { kind: 'member', id: 'child-1', name: 'Alice' }, chain: { chainId: 'c1', hop: 0 } },
          { messageId: 'm2', recipient: { kind: 'member', id: 'child-2', name: 'Bob' }, chain: { chainId: 'c1', hop: 0 } },
        ],
      }),
    })
    const args = { to: ['Alice', 'Bob'], message: 'stand up' }
    const value = await run(tool, args, leader)
    expect(value).toEqual({
      count: 2,
      deliveries: [
        { messageId: 'm1', to: 'child-1', name: 'Alice', hop: 0 },
        { messageId: 'm2', to: 'child-2', name: 'Bob', hop: 0 },
      ],
    })
    // The projection is single-valued, so a broadcast reports a LIST of facts.
    expect(tool.output.presentationMeta?.(args, value)).toEqual([
      { team: 'message', messageId: 'm1', to: 'child-1', text: 'stand up', hop: 0 },
      { team: 'message', messageId: 'm2', to: 'child-2', text: 'stand up', hop: 0 },
    ])
    expect(JSON.stringify(tool.output.render(args, value))).toContain('Alice, Bob')
    expect(tool.presentCall?.(args)).toMatchObject({ title: 'Message Alice, Bob' })
  })

  it('puts three rows in the message stream for a three-recipient broadcast', async () => {
    // The whole chain in one assertion — tool value, projection, fold — because
    // each part looking right on its own is exactly how a broadcast loses rows.
    const tool = sendTool(ctx, 'leader')
    ctx.reflect.set('team', {
      send: () => Promise.resolve({
        deliveries: ['child-1', 'child-2', 'child-3'].map((id, index) => ({
          messageId: `m${index + 1}`,
          recipient: { kind: 'member', id, name: ['Alice', 'Bob', 'Carol'][index] },
          chain: { chainId: 'c1', hop: 0 },
        })),
      }),
    })
    const args = { to: '*', message: 'all hands' }
    const value = await run(tool, args, leader)
    const meta = tool.output.presentationMeta?.(args, value)
    expect(Array.isArray(meta)).toBe(true)
    const view = foldTeam([toolResultEvent(meta, { time: 9 })], 50)
    expect(view.messages).toEqual([
      { messageId: 'm1', to: 'child-1', kind: 'message', text: 'all hands', time: 9, hop: 0 },
      { messageId: 'm2', to: 'child-2', kind: 'message', text: 'all hands', time: 9, hop: 0 },
      { messageId: 'm3', to: 'child-3', kind: 'message', text: 'all hands', time: 9, hop: 0 },
    ])
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

describe('team_task_close', () => {
  /** The member whose own row is being closed. */
  const alice = fakeAgent('child-1', { parent: 'leader-1' })

  it('closes through closeTask — never through the leader write — and folds back as the whole row', async () => {
    const tool = taskCloseTool(ctx)
    const args = { task_id: 't1', note: 'merged' }
    const value = await run(tool, args, alice)
    expect(team.calls).toEqual([{ op: 'closeTask', args: [alice.agent, 't1', 'merged'] }])
    // The same fact shape `team_task` projects: one vocabulary, two audiences.
    expect(readFact(tool.output.presentationMeta?.(args, value))).toEqual({
      team: 'task',
      task: { taskId: 't1', title: 'ship it', status: 'done', assigneeId: 'child-1', note: 'merged' },
    })
  })

  it('carries only the two fields a close needs', () => {
    const tool = taskCloseTool(ctx)
    const schema = tool.parameters as unknown as {
      properties?: Record<string, unknown>
      required?: readonly string[]
    }
    // Everything the leader's `team_task` can reach that a member must not:
    // creation, renaming, reassignment.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['note', 'task_id'])
    expect(schema.required).toEqual(['task_id'])
  })

  it('titles the card by what the call does', () => {
    const tool = taskCloseTool(ctx)
    expect(tool.presentCall?.({ task_id: 't1' })).toMatchObject({ title: 'Close task t1' })
    expect(tool.presentResult?.({ task_id: 't1' }, ok())).toMatchObject({ title: 'Task t1 closed' })
    expect(tool.presentResult?.({ task_id: 't1' }, failed('UNAUTHORIZED'))).toMatchObject({
      title: 'Close task t1', content: [{ type: 'text', text: 'failed: UNAUTHORIZED' }],
    })
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
      board: [
        { key: 'plan', author: 'Alice', updatedAt: 200, preview: 'we keep v1' },
        { key: 'risks', author: 'Alice', updatedAt: 100, preview: 'db migration first' },
      ],
    })
    expect(tool.presentCall?.({})).toMatchObject({ kind: 'read', title: 'Read the team' })
  })

  it('carries the shared board the team left behind, with author and preview', async () => {
    const tool = listTool(ctx)
    const value = await run(tool, {}, leader) as { board: unknown }
    expect(value.board).toEqual([
      { key: 'plan', author: 'Alice', updatedAt: 200, preview: 'we keep v1' },
      { key: 'risks', author: 'Alice', updatedAt: 100, preview: 'db migration first' },
    ])
    // `list` is the synchronous roster; only the tool asks for the live board.
    expect(team.calls.map(call => call.op)).toEqual(['listWithBoard'])
    expect(tool.description).toContain('the shared board as it is right now')
    expect(tool.description).toContain('not the snapshot in your projection')
  })

  it('renders board rows below the roster, newest first', async () => {
    const tool = listTool(ctx)
    const value = await run(tool, {}, leader)
    const text = (tool.output.render({}, value)[0] as { text: string }).text
    expect(text).toContain('1 teammate(s), 1 open task(s)')
    expect(text).toContain('shared board (newest first):')
    expect(text).toContain('plan — Alice — we keep v1')
    expect(text.indexOf('plan — Alice')).toBeLessThan(text.indexOf('risks — Alice'))
  })

  it('bounds the rendered board at ten rows and counts the rest', () => {
    const tool = listTool(ctx)
    const board = Array.from({ length: 12 }, (_, index) => ({
      key: `k${index}`, author: 'Alice', updatedAt: 1_000 - index, preview: `p${index}`,
    }))
    const text = (tool.output.render({}, {
      active: true, members: [], tasks: [], messages: [], board,
    })[0] as { text: string }).text
    expect(text).toContain('k9 — Alice — p9')
    expect(text).not.toContain('k10')
    expect(text).toContain('+2 more')
  })

  it('renders no board section when the team left nothing', () => {
    const tool = listTool(ctx)
    const text = (tool.output.render({}, {
      active: true, members: [], tasks: [], messages: [], board: [],
    })[0] as { text: string }).text
    expect(text).not.toContain('shared board')
  })

  it('summarises the team for the model in one line', async () => {
    const tool = listTool(ctx)
    const value = await run(tool, {}, leader)
    expect(JSON.stringify(tool.output.render({}, value))).toContain('1 teammate(s), 1 open task(s)')
  })
})

describe('team_wait', () => {
  it('forwards the selection, the budget and the caller signal, and writes no durable fact', async () => {
    const tool = waitTool(ctx)
    const controller = new AbortController()
    const args = { members: ['Alice'], timeout_ms: 500 }
    const value = await tool.execute(
      args,
      { agent: leader.agent, signal: controller.signal } as unknown as ToolRunContext,
    )
    // All four buckets cross the seam: `cold` is the one that must not be lost,
    // because dropping it turns "no live session" back into silence. The reports
    // cross with them, because a bucket alone does not say what came back.
    expect(value).toEqual({
      done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true,
      reports: [{ member: 'Alice', text: 'reviewed the diff: no findings' }],
    })
    expect(team.calls).toEqual([{
      op: 'wait',
      args: [leader.agent, { members: ['Alice'], timeoutMs: 500, signal: controller.signal }],
    }])
    expect(tool.output.presentationMeta).toBeUndefined()
  })

  it('omits what the caller omitted, so the service default decides', async () => {
    const tool = waitTool(ctx)
    await run(tool, {}, leader)
    expect(team.calls).toEqual([{ op: 'wait', args: [leader.agent, { signal: expect.anything() }] }])
    expect(tool.presentCall?.({})).toMatchObject({ kind: 'read', title: 'Wait for the team' })
  })

  it('sells waiting as the alternative to polling, and reports a timeout as a result not a failure', () => {
    const tool = waitTool(ctx)
    expect(tool.description).toContain('team_list')
    expect(tool.description).toContain('timeout_ms')
    // The boundary the model must not misread: quiescence is not a received reply.
    expect(tool.description).toContain('has been answered')
    // The bug's contract, stated where the model reads it.
    expect(tool.description).toContain('cold')
    expect(tool.description).toContain('NOT finished')
    // The added half of the contract: the closing report comes back with the names.
    expect(tool.description).toContain('closing report')
    expect(JSON.stringify(tool.output.render({}, { done: ['Alice'], busy: ['Bob'], cold: [], timedOut: true, reports: [] })))
      .toContain('still busy: Bob')
    expect(tool.presentResult?.({}, ok())).toMatchObject({ title: 'Waited for the team' })
  })

  /**
   * The prose is the only place a reader can tell the three states apart, so each
   * gets its own clause, and a wait that ended on the deadline must never read as
   * "all finished".
   *
   * `cold` reads "no live session": the wait saw no live agent and no report, and
   * those two are produced by a member that has not been woken yet AND by one
   * that finished without writing back. "Never started" asserts the first, which
   * the observation cannot know.
   */
  it('reports cold as "no live session" and never claims "never started"', () => {
    const tool = waitTool(ctx)
    const coldOnly = JSON.stringify(tool.output.render({}, {
      done: [], busy: [], cold: ['Carol'], timedOut: true, reports: [],
    }))
    expect(coldOnly).toContain('no live session: Carol')
    expect(coldOnly).not.toContain('never started')
    expect(coldOnly).not.toContain('all finished')

    const mixed = JSON.stringify(tool.output.render({}, {
      done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true, reports: [],
    }))
    expect(mixed).toContain('still busy: Bob')
    expect(mixed).toContain('no live session: Carol')
    expect(mixed).not.toContain('never started')
    expect(mixed).toContain('finished: Alice')

    const complete = JSON.stringify(tool.output.render({}, {
      done: ['Alice'], busy: [], cold: [], timedOut: false, reports: [],
    }))
    expect(complete).toContain('all finished: Alice')
    expect(JSON.stringify(tool.output.render({}, { done: [], busy: [], cold: [], timedOut: false, reports: [] })))
      .toContain('nothing to wait for')
  })

  /**
   * The half the schema cannot deliver on its own: a caller reading the rendered
   * text — which is what the model reads — must see the reports too. One
   * `name: text` line each, in the order the members are done, with a report's own
   * newlines flattened so a multi-line answer stays one row.
   */
  it('appends one "name: text" line per finished member', () => {
    const tool = waitTool(ctx)
    const text = (tool.output.render({}, {
      done: ['Alice', 'Bob'], busy: [], cold: [], timedOut: false,
      reports: [
        { member: 'Alice', text: 'line one\nline two' },
        { member: 'Bob', text: 'reviewed' },
      ],
    })[0] as { text: string }).text

    expect(text.split('\n')).toEqual([
      'all finished: Alice, Bob;',
      'Alice: line one line two',
      'Bob: reviewed',
    ])
  })

  /**
   * Five verbose members must not push the state sentence out of sight: the schema
   * bound is the ceiling for the field, while the rendered line has its own, and
   * the cut is marked so a reader knows there is more in `reports`.
   */
  it('bounds one rendered report line instead of letting it run on', () => {
    const tool = waitTool(ctx)
    const long = 'x'.repeat(REPORT_LINE_MAX_CHARS + 100)
    const text = (tool.output.render({}, {
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: long }],
    })[0] as { text: string }).text

    const line = text.split('\n')[1]!
    expect(line.startsWith('Alice: ')).toBe(true)
    expect(line.endsWith('\u2026')).toBe(true)
    expect(line).toHaveLength('Alice: '.length + REPORT_LINE_MAX_CHARS)
  })

  /**
   * The lock for the card that would otherwise silently go wrong.
   *
   * The conversation view reads this very text with `waitReport()`, whose bucket
   * reader takes everything from `label: ` to the next `;`. Appending reports is
   * therefore a parsing hazard, not a formatting choice: the negative control below
   * is the same append done naively, and it puts the report INSIDE the done list.
   * The real render survives it — including a report that quotes the marker words —
   * because the sentence is closed with `;` first and the markers are defused.
   */
  it('keeps the card parser reading the same buckets once the reports are appended', () => {
    const tool = waitTool(ctx)
    const buckets = { done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true }
    const text = (tool.output.render({}, {
      ...buckets,
      reports: [{ member: 'Alice', text: 'I found no live session: for Carol, and finished: nothing' }],
    })[0] as { text: string }).text

    // The three buckets still parse as the wait reported them.
    expect(waitReport(undefined, text)).toEqual(buckets)
    // The report is readable, with its markers turned into plain words.
    expect(text).toContain('Alice: I found no live session — for Carol, and finished — nothing')

    // The control: no separating `;`, and the card invents a member.
    expect(waitReport(undefined, 'timed out — still busy: Bob; no live session: Carol; finished: Alice\nAlice: OK'))
      .toEqual({ done: ['Alice\nAlice: OK'], busy: ['Bob'], cold: ['Carol'], timedOut: true })
  })

  it('puts the same three-state sentence on the card as in the tool result', () => {
    const tool = waitTool(ctx)
    const value = { done: ['Alice'], busy: [], cold: ['Carol'], timedOut: true, reports: [] }
    const text = (tool.output.render({}, value)[0] as { text: string }).text
    const card = tool.presentResult?.({}, {
      content: [{ type: 'text', text }],
    } as unknown as ToolResult)
    expect(card).toMatchObject({ title: 'Waited for the team', content: [{ type: 'text', text }] })
    expect(text).toContain('no live session: Carol')
    expect(text).not.toContain('never started')
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
