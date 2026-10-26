/**
 * The durable half of the roster.
 *
 * A teammate spawned through the admin route, a relation change, and a
 * dismissal happen WITHOUT a settled team-tool result, so `team/changed` (a
 * same-process edge) is all that used to carry them: the panel kept its old
 * roster and a refresh rebuilt it from the log, where they were missing.
 * {@link TEAM_MEMBER_RECORD} is the durable half.
 *
 * Two halves are covered here. The first folds recorded events directly, so a
 * failure names the fold's transition. The second drives a REAL `Session` and
 * the REAL service, so the claim "the member is still there after a refresh"
 * is checked against a committed log rather than a synthesized array.
 *
 * @module dsh-team/persist.test
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { appendPluginRecord, pluginRecordOf, SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it } from 'vitest'
import type { TeamConfig } from './config.ts'
import { EMPTY_TEAM_VIEW } from './contract.ts'
import { foldTeam, TEAM_MEMBER_RECORD, TEAM_TASK_RECORD, type TeamMemberRecord } from './fold.ts'
import { TeamService } from './service.ts'
import { taskTool } from './tools.ts'
import { toolResultEvent, userMessageEvent, fakeAgent, FakeSubagents } from '../tests/harness.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 4, maxRecentMessages: 20, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 8, maxNoteChars: 400, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}

/** Mailbox feed ceiling the projection is built with in these tests. */
const BOUND = 5

let seq = 1_700_000_000_000

/**
 * One committed event of the shape the log stores.
 * @param type - the event type.
 * @param data - the payload.
 * @param ignorable - whether the envelope marks the event skippable.
 * @returns the event, as the fold sees it.
 */
function committed(type: string, data: unknown, ignorable?: boolean): SessionEvent {
  seq += 1
  return {
    type,
    seq,
    time: seq,
    data,
    ...ignorable === undefined ? {} : { ignorable },
  } as unknown as SessionEvent
}

/** One plugin record exactly as `publish` writes it. */
function record(data: TeamMemberRecord): SessionEvent {
  return committed(TEAM_MEMBER_RECORD, data, true)
}

/** One member as the durable path carries it. */
function member(overrides: Partial<{ memberId: string; name: string; relation: 'managed' | 'peer' }> = {}) {
  return { memberId: 'child-1', name: 'Alice', relation: 'managed' as const, ...overrides }
}

describe('the roster record in the fold', () => {
  it('adds a member the tool path never saw', () => {
    const view = foldTeam([record({ version: 1, op: 'upsert', member: member() })], BOUND)
    expect(view.active).toBe(true)
    expect(view.members).toEqual([
      { memberId: 'child-1', name: 'Alice', relation: 'managed', joinedAt: seq },
    ])
  })

  it('carries the whole fact, including the fields a route spawn sets', () => {
    const view = foldTeam([record({
      version: 1,
      op: 'upsert',
      member: {
        ...member({ relation: 'peer' }),
        role: 'reviewer',
        provider: 'qwen-local',
        model: 'qwen3',
        effort: 'high',
        skills: ['deep-brief'],
      },
    })], BOUND)
    expect(view.members[0]).toMatchObject({
      memberId: 'child-1',
      name: 'Alice',
      relation: 'peer',
      role: 'reviewer',
      provider: 'qwen-local',
      model: 'qwen3',
      effort: 'high',
      skills: ['deep-brief'],
    })
  })

  it('is idempotent: the same member folded twice yields one identical row', () => {
    const first = record({ version: 1, op: 'upsert', member: member() })
    // A second, later record for the member the tool path or an earlier route
    // spawn already published: the same fact, committed again.
    const again = record({ version: 1, op: 'upsert', member: member() })
    const once = foldTeam([first], BOUND)
    const twice = foldTeam([first, again], BOUND)
    // A refresh re-folds every row, so a repeat MUST NOT duplicate the member
    // and MUST NOT move `joinedAt` forward to the later commit.
    expect(twice.members).toHaveLength(1)
    expect(twice).toEqual(once)
  })

  it('keeps the original joinedAt when the tool path recorded the member first', () => {
    const spawned = toolResultEvent({ team: 'member-added', member: member() })
    const view = foldTeam([
      spawned,
      record({ version: 1, op: 'upsert', member: member({ relation: 'peer' }) }),
    ], BOUND)
    expect(view.members).toHaveLength(1)
    expect(view.members[0]?.joinedAt).toBe(spawned.time)
    expect(view.members[0]?.relation).toBe('peer')
  })

  it('removes the member on a remove record', () => {
    const view = foldTeam([
      record({ version: 1, op: 'upsert', member: member() }),
      record({ version: 1, op: 'remove', memberId: 'child-1' }),
    ], BOUND)
    expect(view.members).toEqual([])
  })

  it('ends the whole team on an ended record', () => {
    const view = foldTeam([
      record({ version: 1, op: 'upsert', member: member() }),
      record({ version: 1, op: 'ended' }),
    ], BOUND)
    expect(view).toMatchObject({ active: false, members: [], tasks: [] })
  })

  it('re-activates a disbanded team when a later record adds a member', () => {
    const view = foldTeam([
      record({ version: 1, op: 'ended' }),
      record({ version: 1, op: 'upsert', member: member() }),
    ], BOUND)
    expect(view.active).toBe(true)
    expect(view.members).toHaveLength(1)
  })

  it('ignores a record a later build of the plugin may write', () => {
    for (const payload of [
      { version: 2, op: 'upsert', member: member() },
      { version: 1, op: 'rename', member: member() },
      { version: 1, op: 'upsert', member: { name: 'Alice', relation: 'managed' } },
      { version: 1, op: 'upsert', member: member({ relation: 'boss' as never }) },
      { version: 1, op: 'remove' },
      undefined,
    ]) {
      expect(foldTeam([committed(TEAM_MEMBER_RECORD, payload, true)], BOUND)).toBe(EMPTY_TEAM_VIEW)
    }
  })

  it('ignores a record from another plugin package', () => {
    const view = foldTeam([committed('plugin:other-plugin/member', {
      version: 1, op: 'upsert', member: member(),
    }, true)], BOUND)
    expect(view).toBe(EMPTY_TEAM_VIEW)
  })

  it('ignores the same type name when the event is not marked ignorable', () => {
    // Only a plugin record is this plugin's vocabulary. A released-looking
    // event of the same name is somebody else's and must not move the roster.
    const view = foldTeam([committed(TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member(),
    })], BOUND)
    expect(view).toBe(EMPTY_TEAM_VIEW)
  })
})

describe('the paths that were already durable', () => {
  it('still folds a settled tool result', () => {
    const view = foldTeam([toolResultEvent({ team: 'member-added', member: member() })], BOUND)
    expect(view.members).toHaveLength(1)
  })

  it('still folds a team delivery once the roster knows the sender', () => {
    const spawned = toolResultEvent({ team: 'member-added', member: member() })
    const delivered = userMessageEvent(
      { kind: 'team-message', senderSessionId: 'child-1', senderName: 'Alice' } as never,
      'ready',
    )
    const view = foldTeam([spawned, delivered], BOUND)
    expect(view.messages).toEqual([
      { messageId: expect.any(String), from: 'child-1', kind: 'message', text: 'ready', time: delivered.time },
    ])
  })
})

/**
 * A real session store plus the service built over it: the leader's log is the
 * only state, which is what a browser refresh reads back.
 * @param seed - committed events to replay into the fresh session, which is how
 *   a restarted host reads a log it did not write.
 */
function durableWorld(seed?: readonly SessionEvent[]): {
  readonly ctx: Context
  readonly sessions: SessionStore
  readonly service: TeamService
  readonly leader: Agent
  readonly log: () => readonly SessionEvent[]
  /** Publish one live agent into `ctx.agents`, as the runtime does for a teammate. */
  readonly register: (agent: Agent) => void
} {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  // The live-agent directory. Empty by default, exactly like a cold host where
  // no teammate is resident; a member-side call needs a resident leader and
  // itself, so the test that makes one registers both.
  const live = new Map<string, Agent>()
  ctx.provide('agents', {
    get: (id: string) => live.get(String(id)),
    list: () => [...live.values()],
  })
  ctx.provide('subagents', new FakeSubagents())
  const session = sessions.create(SessionId('leader-1'), seed === undefined ? undefined : { seed })
  const leader = {
    id: SessionId('leader-1'),
    status: 'idle',
    session,
    options: {},
  } as unknown as Agent
  live.set('leader-1', leader)
  const service = new TeamService(ctx, CONFIG)
  return {
    ctx,
    sessions,
    service,
    leader,
    log: () => session.snapshotEvents(),
    register: (agent: Agent) => { live.set(agent.id, agent) },
  }
}

describe('through a real session log', () => {
  it('records a spawn, which settles no tool result, and a cold read keeps the member', async () => {
    const { service, leader, log } = durableWorld()
    // The admin route calls exactly this: the child comes up and the roster
    // gains a row, with no `tool/result` anywhere to carry the fact.
    const fact = await service.spawn(leader, {
      name: 'Alice',
      task: 'Review the patch',
      relation: 'peer',
      role: 'reviewer',
      skills: ['deep-brief'],
    }, new AbortController().signal)

    expect(fact.memberId).toBe('child-1')
    const records = log().filter(event => pluginRecordOf(event)?.type === TEAM_MEMBER_RECORD)
    expect(records).toHaveLength(1)
    // The whole fact, not just the name: this is what the panel renders.
    expect(pluginRecordOf(records[0]!)?.data).toEqual({
      version: 1,
      op: 'upsert',
      member: {
        memberId: 'child-1',
        name: 'Alice',
        relation: 'peer',
        role: 'reviewer',
        skills: ['deep-brief'],
      },
    })
    // The cold read a refreshed page performs.
    const view = foldTeam(log(), CONFIG.maxRecentMessages)
    expect(view.members.map(row => [row.memberId, row.name, row.relation])).toEqual([
      ['child-1', 'Alice', 'peer'],
    ])
  })

  it('records a relation change as an ignorable plugin record, and a cold read keeps it', () => {
    const { service, leader, log } = durableWorld()
    // Seed the roster the way a tool spawn or a previous route spawn would.
    appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member(),
    })

    service.setRelation(leader, 'child-1', 'peer')

    const records = log().filter(event => pluginRecordOf(event)?.type === TEAM_MEMBER_RECORD)
    expect(records).toHaveLength(2)
    const written = records[1]
    expect(written?.ignorable).toBe(true)
    expect(pluginRecordOf(written!)?.data).toEqual({
      version: 1, op: 'upsert', member: member({ relation: 'peer' }),
    })
    // The cold read a refreshed page performs: fold the committed log.
    const view = foldTeam(log(), CONFIG.maxRecentMessages)
    expect(view.members.map(row => [row.name, row.relation])).toEqual([['Alice', 'peer']])
  })

  it('records a dismissal so a cold read drops the member', () => {
    const { service, leader, log } = durableWorld()
    appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member(),
    })
    expect(service.list(leader).members.map(row => row.name)).toEqual(['Alice'])

    service.dismiss(leader, 'child-1')

    const view = foldTeam(log(), CONFIG.maxRecentMessages)
    expect(view.members).toEqual([])
    expect(service.list(leader).members).toEqual([])
  })

  it('records a whole-team end so a cold read reports an inactive team', () => {
    const { service, leader, log } = durableWorld()
    appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member(),
    })

    service.dismiss(leader)

    const view = foldTeam(log(), CONFIG.maxRecentMessages)
    expect(view).toMatchObject({ active: false, members: [] })
  })

  it('rebuilds the roster from the log alone, which is what a restart does', () => {
    const { service, leader, log } = durableWorld()
    appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member({ relation: 'peer' }),
    })
    // The service holds no in-memory roster for a leader it has not touched,
    // so this read is the log rebuild: the same path a restarted host takes.
    expect(service.list(leader).members.map(row => [row.name, row.relation])).toEqual([['Alice', 'peer']])
    expect(log().filter(event => event.ignorable === true)).toHaveLength(1)
  })
})

/**
 * Run one team tool and commit the `tool/result` the agent loop writes for it,
 * carrying the tool's own `presentationMeta` as `meta`.
 *
 * That is exactly the seam the fold reads — `tool/result` → `event.data.meta` →
 * `readFacts` → `case 'task'` — so the row asserted below comes from what the
 * TOOL produced, not a hand-written fixture. `ToolRuntime` surfaces the same
 * meta on its success value (see `tests/dispatch.spec.ts`); the loop is what
 * commits it alongside the result, and this helper stands in for that commit.
 * @param session - the leader's real session log.
 * @param tool - the team tool to execute.
 * @param args - the tool arguments.
 * @param agent - the acting leader.
 * @param callId - the provider call this result answers.
 * @returns the tool's value, as the model would receive it.
 */
async function settleTeamCall(
  session: Session,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  agent: Agent,
  callId: string,
): Promise<JsonValue> {
  const signal = new AbortController().signal
  const value = await tool.execute(args, { agent, signal } as never) as JsonValue
  const meta = tool.output.presentationMeta?.(args, value)
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: false }),
    ...meta === undefined ? {} : { meta: meta as JsonValue },
  }, { surfaceOp: 'append' })
  return value
}

/**
 * The task list rides the SAME durable half as the roster: `team_task` projects
 * `{ team: 'task', task }` through `presentationMeta`, the harness records it as
 * a `tool/result`, and a cold read folds it back. `ctx.emit('team/changed')` is
 * only the same-process edge; nothing below depends on it.
 */
describe('the task list through a real session log', () => {
  it('keeps a created task because the tool logged a fact, not just a change event', async () => {
    const { ctx, leader, log } = durableWorld()
    await settleTeamCall(leader.session, taskTool(ctx), { title: 'ship it' }, leader, 'call-1')

    // The fact is in the committed log, not only in the emitted event.
    const settled = log().filter(event => event.type === 'tool/result')
    expect(settled).toHaveLength(1)
    expect((settled[0]!.data as { meta?: unknown }).meta).toEqual({
      team: 'task',
      task: { taskId: 't1', title: 'ship it', status: 'pending' },
    })
    // The cold read a refreshed page performs.
    expect(foldTeam(log(), CONFIG.maxRecentMessages).tasks)
      .toEqual([{ taskId: 't1', title: 'ship it', status: 'pending' }])
  })

  it('updates one row in place instead of appending a second row for the same id', async () => {
    const { ctx, leader, log } = durableWorld()
    const tool = taskTool(ctx)
    await settleTeamCall(leader.session, tool, { title: 'ship it' }, leader, 'call-1')
    await settleTeamCall(leader.session, tool, { task_id: 't1', status: 'done', note: 'merged' }, leader, 'call-2')

    const view = foldTeam(log(), CONFIG.maxRecentMessages)
    // Two facts, one row: the fold upserts by taskId and the update carried the
    // whole post-change row, so the title survives a status-only call.
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0]).toEqual({ taskId: 't1', title: 'ship it', status: 'done', note: 'merged' })
  })

  it('rebuilds the whole task list on a restarted host, from the log alone', async () => {
    const first = durableWorld()
    const tool = taskTool(first.ctx)
    await settleTeamCall(first.leader.session, tool, { title: 'ship it' }, first.leader, 'call-1')
    await settleTeamCall(first.leader.session, tool, { title: 'review notes' }, first.leader, 'call-2')
    await settleTeamCall(first.leader.session, tool, { task_id: 't1', status: 'done' }, first.leader, 'call-3')

    // A restarted host: a fresh store seeded with the committed events, and a
    // service that never touched this leader, so no in-memory map can produce
    // the rows below.
    const restarted = durableWorld(first.log())
    expect(restarted.service.list(restarted.leader).tasks).toEqual([
      { taskId: 't1', title: 'ship it', status: 'done' },
      { taskId: 't2', title: 'review notes', status: 'pending' },
    ])
  })

  /**
   * The member-side close is the one task write that does NOT happen inside the
   * leader's session: `team_task_close` runs in the MEMBER's turn, so its tool
   * result is committed to the member's own log, which the leader's fold never
   * reads.
   *
   * That makes this the test that separates a real close from a memory-only one.
   * A close that only mutates the live team reads `done` in `team_list` until the
   * page is refreshed, and then reads the row as still `pending`, because the
   * leader's log never heard about it. The assertion below reads the LEADER's log
   * with nothing else touched — the exact fold a refresh performs.
   */
  it('keeps a MEMBER\'s close in the leader log, so a refresh still reads done', async () => {
    const { ctx, service, leader, log, register } = durableWorld()
    // The roster the close is checked against, and the live agents the
    // member-side call resolves through.
    appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, {
      version: 1, op: 'upsert', member: member(),
    })
    const alice = fakeAgent('child-1', { parent: 'leader-1' })
    register(alice.agent)
    // The leader's own assignment through the real tool, so the row starts in
    // the log exactly as a live session leaves it.
    await settleTeamCall(leader.session, taskTool(ctx), { title: 'ship it', assignee: 'child-1' }, leader, 'call-1')

    expect(service.closeTask(alice.agent, 't1', 'merged'))
      .toMatchObject({ taskId: 't1', status: 'done', note: 'merged' })

    // The wire half: the close landed as ONE ignorable plugin record on the
    // leader's log, carrying the same `{ team: 'task', task }` fact the leader's
    // own `team_task` projects — not a member-log artifact and not a released
    // event type invented for this.
    const closings = log().filter(event => pluginRecordOf(event)?.type === TEAM_TASK_RECORD)
    expect(closings).toHaveLength(1)
    expect(closings[0]?.ignorable).toBe(true)
    expect(pluginRecordOf(closings[0]!)?.data).toEqual({
      team: 'task',
      task: { taskId: 't1', title: 'ship it', status: 'done', assigneeId: 'child-1', note: 'merged' },
    })

    // The durable half, on the LEADER's side: fold the committed log, no RPC,
    // no in-memory team map.
    expect(foldTeam(log(), CONFIG.maxRecentMessages).tasks).toEqual([
      { taskId: 't1', title: 'ship it', assigneeId: 'child-1', status: 'done', note: 'merged' },
    ])

    // And a restarted host seeded with that log alone reads the same row.
    const restarted = durableWorld(log())
    expect(restarted.service.list(restarted.leader).tasks).toEqual([
      { taskId: 't1', title: 'ship it', assigneeId: 'child-1', status: 'done', note: 'merged' },
    ])
  })
})
