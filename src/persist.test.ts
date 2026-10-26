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
import { appendPluginRecord, pluginRecordOf, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { TeamConfig } from './config.ts'
import { EMPTY_TEAM_VIEW } from './contract.ts'
import { foldTeam, TEAM_MEMBER_RECORD, type TeamMemberRecord } from './fold.ts'
import { TeamService } from './service.ts'
import { toolResultEvent, userMessageEvent, FakeSubagents } from '../tests/harness.ts'

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
 */
function durableWorld(): {
  readonly ctx: Context
  readonly sessions: SessionStore
  readonly service: TeamService
  readonly leader: Agent
  readonly log: () => readonly SessionEvent[]
} {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  ctx.provide('agents', { get: () => undefined, list: () => [] })
  ctx.provide('subagents', new FakeSubagents())
  const session = sessions.create(SessionId('leader-1'))
  const leader = {
    id: SessionId('leader-1'),
    status: 'idle',
    session,
    options: {},
  } as unknown as Agent
  const service = new TeamService(ctx, CONFIG)
  return { ctx, sessions, service, leader, log: () => session.snapshotEvents() }
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
