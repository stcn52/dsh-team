/**
 * The team service: roster lifecycle, the relation-based delivery matrix, the
 * shared task list, and hydration from a leader's own log.
 *
 * @module dsh-team/tests/service
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it } from 'vitest'
import { TeamError } from '../src/errors.ts'
import { TeamService, WAIT_REPORT_MAX_CHARS } from '../src/service.ts'
import { SHARED_AREA, TeamWorkspace, type WorkspaceEntry } from '../src/workspace.ts'
import type { TeamConfig } from '../src/config.ts'
import {
  FakeAgents, FakeLlm, FakeSubagents, fakeAgent, inboxSplicedEvent, toolResultEvent, userMessageEvent,
  type FakeAgent,
} from './harness.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 2, maxRecentMessages: 20, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 8, maxNoteChars: 400, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}

/** One assembled world: the service plus the doubles it was built on. */
interface World {
  readonly ctx: Context
  readonly service: TeamService
  readonly agents: FakeAgents
  readonly subagents: FakeSubagents
  readonly leader: FakeAgent
  /** The provider directory and model-info double, when the world mounted one. */
  readonly llm?: FakeLlm
}

const signal = new AbortController().signal

/**
 * Run one synchronous operation expected to refuse.
 * @param run - the operation.
 * @returns the refusal code, or `no-throw` when it was accepted.
 */
function refusal(run: () => unknown): string {
  try {
    run()
    return 'no-throw'
  } catch (error: unknown) {
    return error instanceof TeamError ? error.code : `other: ${String(error)}`
  }
}

/**
 * Assemble the service over its doubles.
 * @param options - leader log seed, route, and the efforts the model offers.
 * @returns the world under test.
 */
function world(options: {
  readonly config?: TeamConfig
  readonly leader?: FakeAgent
  readonly efforts?: readonly string[]
  readonly providers?: readonly string[]
} = {}): World {
  const ctx = new Context()
  const agents = new FakeAgents(ctx)
  const subagents = new FakeSubagents()
  subagents.publishChild = (childId, parentId, options) => {
    agents.add(fakeAgent(String(childId), {
      parent: String(parentId),
      ...typeof options?.provider === 'string' ? { provider: options.provider } : {},
      ...typeof options?.model === 'string' ? { model: options.model } : {},
      ...typeof options?.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {},
    }))
  }
  ctx.provide('agents', agents)
  ctx.provide('subagents', subagents)
  ctx.provide('sessions', {})
  const llm = options.efforts === undefined && options.providers === undefined
    ? undefined
    : new FakeLlm(options.efforts ?? [], options.providers)
  if (llm !== undefined) ctx.provide('llm', llm)
  const service = new TeamService(ctx, options.config ?? CONFIG)
  const leader = agents.add(options.leader ?? fakeAgent('leader-1', { provider: 'deepseek', model: 'chat' }))
  return { ctx, service, agents, subagents, leader, ...llm !== undefined ? { llm } : {} }
}

/** Spawn one teammate and register its live agent double. */
async function spawn(scene: World, name: string, options: {
  readonly relation?: 'managed' | 'peer'
  readonly childId?: string
  readonly role?: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly skills?: readonly string[]
} = {}): Promise<FakeAgent> {
  scene.subagents.nextChildId = options.childId ?? `child-${scene.subagents.started.length + 1}`
  const member = await scene.service.spawn(scene.leader.agent, {
    name,
    task: `do ${name}'s work`,
    relation: options.relation ?? 'managed',
    ...options.role !== undefined ? { role: options.role } : {},
    ...options.provider !== undefined ? { provider: options.provider } : {},
    ...options.model !== undefined ? { model: options.model } : {},
    ...options.effort !== undefined ? { reasoningEffort: options.effort } : {},
    ...options.skills !== undefined ? { skills: options.skills } : {},
  }, signal)
  const child = scene.agents.getFake(member.memberId)
  if (child === undefined) throw new Error(`published child ${member.memberId} is missing`)
  return child
}

/**
 * Build one leader-inbox message the way the runtime's continuation manager
 * does when a teammate's turn ends: the settlement notice, which lands on
 * `next-step` and is spliced into the log only at the next step boundary.
 * @param memberId - the child session that settled.
 * @param summary - the one-line account the notice carries.
 * @returns the queued message.
 */
function settlementNotice(memberId: string, summary = 'Alice finished.'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: SessionId(memberId) },
  })
}

/**
 * The runtime's opening line, reproduced arm for arm from the producer.
 *
 * `settlementSummary()` in
 * `@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js` is not a public
 * export (neither it nor `createSettlementMessage()` reaches the package index),
 * so its wording is mirrored here in the producer's own order. A case that
 * proves the template is not mistaken for a member's answer has to be built from
 * the sentences the runtime really writes: a phrase a test author guessed would
 * pass against a detector that guesses the same phrase, and both would be wrong.
 *
 * The mirror is not free — it is the coupling the detector carries. Two producer
 * properties matter to it and are reproduced here rather than assumed:
 * every arm starts with the same subject (`Background subagent <childId>`), and
 * a `completed` child has TWO endings depending on `continuable`.
 * @param childId - the settled child's durable session id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @param continuable - whether the child accepts a later message.
 * @returns the notice's opening line, exactly as the runtime writes it.
 */
function settlementSummaryOf(
  childId: string,
  stopReason = 'completed',
  continuable = true,
): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return continuable
        ? `${subject} finished and will do no further work unless you send it more.`
        : `${subject} finished. It cannot receive follow-up messages.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    default:
      return `${subject} ended abnormally (${stopReason}) before it finished.`
  }
}

/**
 * Build the settlement notice exactly as the harness builds it.
 *
 * `createSettlementMessage()` in
 * `@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js` is not a public
 * export, so its shape is mirrored here: the runtime's one-line summary (see
 * {@link settlementSummaryOf}), then the literal marker `Its closing message:`,
 * then the child's own text — or, for a silent child, `It left no closing
 * message.` That template is exactly what the wait must strip: a report that
 * carried it would attribute a sentence the runtime wrote about the member to
 * the member itself.
 * @param memberId - the child session that settled.
 * @param closing - the child's closing text blocks; empty for a silent child.
 * @param summary - the one-line account the notice carries, when a case wants its own.
 * @returns the queued message.
 */
function settlementWithClosing(
  memberId: string,
  closing: readonly string[],
  summary?: string,
): UserMessage {
  const line = summary ?? settlementSummaryOf(memberId)
  return createUserMessage({
    content: [
      { type: 'text', text: line },
      { type: 'text', text: 'Its closing message:' },
      ...closing.length === 0
        ? [{ type: 'text' as const, text: 'It left no closing message.' }]
        : closing.map(text => ({ type: 'text' as const, text })),
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: line, senderSessionId: SessionId(memberId) },
  })
}

/**
 * Build one queued `team_send` reply from a teammate into the leader's inbox.
 * @param memberId - the sending member's session id.
 * @param name - the sender's display name.
 * @param text - the reply body.
 * @returns the queued message.
 */
function queuedReply(memberId: string, name: string, text = 'OK'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'team-message', form: 'relay', senderSessionId: memberId, senderName: name, chainId: 'c1', hop: 0,
    },
  })
}

/**
 * Commit one spliced report into the leader's log the way the runtime does, and
 * announce it on `session/event`.
 *
 * The announcement is the whole point: `Session.append()` publishes
 * `session/event` post-commit, and that feed — not a poll — is what tells a
 * waiting `team_wait` that a report may have become readable. A row pushed into
 * the events array without this emit is a log the runtime could never have
 * produced in that moment: invisible to a live wait.
 * @param scene - the world whose leader log receives the row.
 * @param message - the report to splice.
 * @returns the committed event.
 */
function spliceReport(scene: World, message: UserMessage): ReturnType<typeof inboxSplicedEvent> {
  const event = inboxSplicedEvent([message])
  scene.leader.session.events.push(event)
  scene.ctx.emit('session/event', scene.leader.session as never, event as never)
  return event
}

describe('spawn', () => {
  let scene: World

  beforeEach(() => {
    scene = world()
  })

  it('starts a continuable child under the leader and returns the roster row', async () => {
    const member = await scene.service.spawn(scene.leader.agent, {
      name: 'Alice',
      role: 'reviewer',
      relation: 'peer',
      task: 'review the diff',
      persona: 'terse',
      model: 'reasoner',
    }, signal)

    expect(member).toEqual({
      memberId: 'child-1',
      name: 'Alice',
      role: 'reviewer',
      relation: 'peer',
      model: 'reasoner',
    })
    expect(scene.subagents.started).toHaveLength(1)
    const started = scene.subagents.started[0]!
    expect(started.provider).toBe('spawn')
    expect(started.label).toBe('Alice (reviewer)')
    expect(started.parent.id).toBe(scene.leader.id)
    expect(started.persona).toBe('terse')
    expect(started.agentOptions).toEqual({ model: 'reasoner' })
    expect(JSON.stringify(started.prompt)).toContain('review the diff')
  })

  it('passes a requested reasoning effort to the child runtime', async () => {
    await scene.service.spawn(scene.leader.agent, {
      name: 'Alice',
      relation: 'managed',
      task: 'reason carefully',
      reasoningEffort: 'high',
    }, signal)

    expect(scene.subagents.started[0]?.agentOptions).toEqual({ reasoningEffort: 'high' })
  })

  it('refuses a teammate that tries to lead its own team', async () => {
    const teammate = scene.agents.add(fakeAgent('child-9', { parent: scene.leader.id }))
    await expect(scene.service.spawn(teammate.agent, {
      name: 'Nested', relation: 'peer', task: 'x',
    }, signal)).rejects.toThrow(TeamError)
  })

  it('refuses a duplicate name whatever its case, and a full roster', async () => {
    await spawn(scene, 'Alice')
    await expect(scene.service.spawn(scene.leader.agent, {
      name: 'alice', relation: 'peer', task: 'x',
    }, signal)).rejects.toMatchObject({ code: 'DUPLICATE_NAME' })

    await spawn(scene, 'Bob')
    await expect(scene.service.spawn(scene.leader.agent, {
      name: 'Carol', relation: 'peer', task: 'x',
    }, signal)).rejects.toMatchObject({ code: 'MAX_TEAMMATES' })
  })

  it('adopts the child inside its composition window and rolls the row back when the start fails', async () => {
    let adopted: unknown
    scene.subagents.onStart = (childId) => {
      const child = fakeAgent(childId, { parent: scene.leader.id })
      adopted = scene.service.adopt(child.agent)
    }
    await spawn(scene, 'Alice', { relation: 'peer', role: 'reviewer' })
    expect(adopted).toEqual({ memberId: 'child-1', name: 'Alice', role: 'reviewer', relation: 'peer' })

    scene.subagents.onStart = undefined
    scene.subagents.failStart = new Error('provider refused')
    await expect(scene.service.spawn(scene.leader.agent, {
      name: 'Bob', relation: 'peer', task: 'x',
    }, signal)).rejects.toThrow('provider refused')
    expect(scene.service.list(scene.leader.agent).members.map(member => member.name)).toEqual(['Alice'])
  })

  it('adopts nothing for a child outside any team', () => {
    const stranger = fakeAgent('other-child', { parent: 'unknown-leader' })
    expect(scene.service.adopt(stranger.agent)).toBeUndefined()
    const orphan = fakeAgent('top-level')
    expect(scene.service.adopt(orphan.agent)).toBeUndefined()
  })

  it('keeps a teammate resumed mid-spawn out of the pending identity', async () => {
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    // Bob wakes from cold while Alice is still being created: his composition
    // window must find his own row, not the identity Alice is waiting for.
    scene.subagents.onStart = () => { scene.service.adopt(bob.agent) }
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })

    expect(scene.service.adopt(bob.agent)).toMatchObject({ memberId: 'child-2', name: 'Bob' })
    expect(scene.service.adopt(alice.agent)).toMatchObject({ memberId: 'child-1', name: 'Alice' })
    expect(scene.service.list(scene.leader.agent).members.map(member => member.name)).toEqual(['Bob', 'Alice'])
  })
})

describe('provider routing', () => {
  it('runs one teammate on another provider route, and records the route', async () => {
    const scene = world({ providers: ['deepseek', 'qwen-local'] })
    const alice = await spawn(scene, 'Alice', { provider: 'qwen-local', model: 'qwen3.8-flash-next-iq3_s' })

    expect(scene.subagents.started[0]?.agentOptions).toEqual({
      provider: 'qwen-local',
      model: 'qwen3.8-flash-next-iq3_s',
    })
    expect(alice.options).toMatchObject({ provider: 'qwen-local', model: 'qwen3.8-flash-next-iq3_s' })
    expect(scene.service.list(scene.leader.agent).members[0]).toMatchObject({
      provider: 'qwen-local',
      model: 'qwen3.8-flash-next-iq3_s',
    })
  })

  it('refuses a provider this deployment never registered, naming the ones it has', async () => {
    const scene = world({ providers: ['deepseek', 'qwen-local'] })
    await expect(spawn(scene, 'Alice', { provider: 'ollama', model: 'x' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER' })
    await expect(spawn(scene, 'Alice', { provider: 'ollama', model: 'x' }))
      .rejects.toThrow(/registered: deepseek, qwen-local/)
    expect(scene.subagents.started).toHaveLength(0)
  })

  it('requires a model id when the route changes, because model ids are provider-scoped', async () => {
    const scene = world({ providers: ['deepseek', 'qwen-local'] })
    await expect(spawn(scene, 'Alice', { provider: 'qwen-local' }))
      .rejects.toMatchObject({ code: 'MODEL_REQUIRED' })
    expect(scene.subagents.started).toHaveLength(0)
  })

  it('stays on the leader route when the spawn leaves the provider alone', async () => {
    const scene = world({ providers: ['deepseek', 'qwen-local'] })
    await spawn(scene, 'Alice', { model: 'reasoner' })
    expect(scene.subagents.started[0]?.agentOptions).toEqual({ model: 'reasoner' })
    expect(scene.service.list(scene.leader.agent).members[0]?.provider).toBeUndefined()
  })

  it('routes every teammate by default when the deployment configures a teammate route', async () => {
    const scene = world({
      config: { ...CONFIG, teammateProvider: 'qwen-local', teammateModel: 'qwen3.8-flash-next-iq3_s' },
      providers: ['deepseek', 'qwen-local'],
    })
    await spawn(scene, 'Alice')
    await spawn(scene, 'Bob')
    expect(scene.subagents.started.map(started => started.agentOptions)).toEqual([
      { provider: 'qwen-local', model: 'qwen3.8-flash-next-iq3_s' },
      { provider: 'qwen-local', model: 'qwen3.8-flash-next-iq3_s' },
    ])
  })

  it('validates a requested effort against the requested route, not the leader route', async () => {
    const scene = world({ efforts: ['low'], providers: ['deepseek', 'qwen-local'] })
    await spawn(scene, 'Alice', { provider: 'qwen-local', model: 'qwen3.8', effort: 'low' })
    expect(scene.llm?.resolved).toEqual([{ provider: 'qwen-local', model: 'qwen3.8' }])
  })
})

describe('assigned skills', () => {
  it('records the skills a leader assigned, per member', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { skills: ['deep-brief'] })
    await spawn(scene, 'Bob', { skills: ['requirements', 'design'] })

    const members = scene.service.list(scene.leader.agent).members
    expect(members.map(member => member.skills)).toEqual([
      ['deep-brief'],
      ['requirements', 'design'],
    ])
  })

  it('keeps the names as given, so the member can check them with its own skill tool', async () => {
    const scene = world()
    await expect(spawn(scene, 'Alice', { skills: ['no-such-skill'] })).resolves.toBeDefined()
    expect(scene.service.list(scene.leader.agent).members[0]?.skills).toEqual(['no-such-skill'])
  })

  it('keeps a plain spawn free of skills, so nothing implies an assignment', async () => {
    const scene = world()
    await spawn(scene, 'Alice')
    expect(scene.service.list(scene.leader.agent).members[0]?.skills).toBeUndefined()
  })
})

describe('lifecycle', () => {
  it('drops a leader live team with its agent, so a resumed session rereads its log', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    expect(scene.service.list(scene.leader.agent).members).toHaveLength(1)

    // The leader session ended: nothing durable was logged by these doubles, so
    // the rebuilt team is the empty fold rather than the previous lifecycle.
    scene.ctx.emit('agent/disposed', { agent: scene.leader.agent } as never)
    expect(scene.service.list(scene.leader.agent).members).toEqual([])
  })
})

describe('reasoning effort', () => {
  it('rejects an effort the selected model does not offer', async () => {
    const scene = world({ efforts: ['low', 'high'] })
    await expect(spawn(scene, 'Alice', { effort: 'ultra' })).rejects.toMatchObject({ code: 'UNKNOWN_EFFORT' })
    expect(scene.subagents.started).toHaveLength(0)
  })

  it('records an offered effort on the roster row', async () => {
    const scene = world({ efforts: ['low', 'high'] })
    await spawn(scene, 'Alice', { effort: 'high' })
    expect(scene.service.list(scene.leader.agent).members[0]).toMatchObject({ effort: 'high' })
  })

  it('leaves the adapter as the authority when no model route is resolvable', async () => {
    const scene = world({ efforts: ['low'], leader: fakeAgent('leader-1') })
    await expect(spawn(scene, 'Alice', { effort: 'anything' })).resolves.toBeDefined()
  })
})

describe('mailbox', () => {
  let scene: World
  let alice: FakeAgent
  let bob: FakeAgent

  beforeEach(async () => {
    scene = world()
    alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    bob = await spawn(scene, 'Bob', { relation: 'managed', childId: 'child-2' })
  })

  it('delivers a leader message to the teammate through its durable parent', async () => {
    const sent = await scene.service.send(scene.leader.agent, 'Alice', 'please review', signal)
    expect(sent.recipient).toMatchObject({ kind: 'member', id: 'child-1', name: 'Alice' })
    expect(scene.subagents.followups).toHaveLength(1)
    const delivery = scene.subagents.followups[0]!
    expect(delivery.parentId).toBe(scene.leader.id)
    expect(delivery.childId).toBe('child-1')
    expect(delivery.source).toEqual({
      kind: 'team-message',
      form: 'relay',
      senderSessionId: scene.leader.id,
      senderName: 'leader',
      chainId: 'c1',
      hop: 0,
    })
  })

  it('addresses a teammate by member id as well as by name', async () => {
    await scene.service.send(scene.leader.agent, 'child-2', 'status?', signal)
    expect(scene.subagents.followups[0]!.childId).toBe('child-2')
  })

  it('delivers a teammate message to the leader inbox with the sender named', async () => {
    await scene.service.send(alice.agent, 'leader', 'found a bug', signal)
    expect(scene.subagents.followups).toHaveLength(0)
    expect(scene.leader.received).toHaveLength(1)
    const accepted = scene.leader.received[0]!
    expect(accepted.target).toBe('next-turn')
    expect(accepted.wakeup).toBe(true)
    expect(accepted.message.source).toMatchObject({
      kind: 'team-message',
      senderSessionId: 'child-1',
      senderName: 'Alice',
    })
  })

  it('routes peer-to-peer traffic under the leader authority, naming the real sender', async () => {
    await scene.service.send(alice.agent, 'Bob', 'take the second half', signal)
    const delivery = scene.subagents.followups[0]!
    expect(delivery.parentId).toBe(scene.leader.id)
    expect(delivery.childId).toBe('child-2')
    expect(delivery.source).toMatchObject({ senderSessionId: 'child-1', senderName: 'Alice' })
  })

  it('keeps a managed teammate on the leader-only channel', async () => {
    await expect(scene.service.send(bob.agent, 'Alice', 'hi', signal))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(scene.service.send(bob.agent, 'leader', 'hi', signal)).resolves.toBeDefined()
  })

  it('refuses an unknown recipient and a message to oneself', async () => {
    await expect(scene.service.send(scene.leader.agent, 'Nobody', 'hi', signal))
      .rejects.toMatchObject({ code: 'UNKNOWN_MEMBER' })
    await expect(scene.service.send(alice.agent, 'Alice', 'hi', signal))
      .rejects.toMatchObject({ code: 'SELF_MESSAGE' })
  })
})

describe('broadcast delivery', () => {
  /** Two peers and one managed member, so every wildcard expansion is visible. */
  async function trio(): Promise<{
    readonly scene: World
    readonly alice: FakeAgent
    readonly bob: FakeAgent
    readonly carol: FakeAgent
  }> {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { relation: 'peer', childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { relation: 'managed', childId: 'child-3' })
    return { scene, alice, bob, carol }
  }

  /**
   * Run one asynchronous operation expected to refuse, keeping the refusal.
   * @param run - the operation.
   * @returns the refusal, or undefined when it was accepted.
   */
  async function caught(run: () => Promise<unknown>): Promise<TeamError | undefined> {
    try {
      await run()
      return undefined
    } catch (error: unknown) {
      return error instanceof TeamError ? error : undefined
    }
  }

  it('keeps the single-address result shape every existing caller reads', async () => {
    const { scene } = await trio()
    const sent = await scene.service.send(scene.leader.agent, 'Alice', 'please review', signal)
    expect(Object.keys(sent).sort()).toEqual(['chain', 'messageId', 'recipient'])
    expect(sent.recipient).toMatchObject({ kind: 'member', id: 'child-1', name: 'Alice' })
    expect(sent.chain).toEqual({ chainId: 'c1', hop: 0 })
    expect(typeof sent.messageId).toBe('string')
    expect(scene.subagents.followups).toHaveLength(1)
  })

  it('delivers to every address in the list, one message id each', async () => {
    const { scene } = await trio()
    const broadcast = await scene.service.send(scene.leader.agent, ['Alice', 'Bob'], 'sync up', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).toEqual(['child-1', 'child-2'])
    expect(new Set(broadcast.deliveries.map(entry => entry.messageId)).size).toBe(2)
    expect(scene.subagents.followups.map(entry => entry.childId)).toEqual(['child-1', 'child-2'])
  })

  it('expands the wildcard for the leader to the whole roster', async () => {
    const { scene } = await trio()
    const broadcast = await scene.service.send(scene.leader.agent, '*', 'all hands', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).toEqual(['child-1', 'child-2', 'child-3'])
    expect(broadcast.deliveries.map(entry => entry.chain.hop)).toEqual([0, 0, 0])
    expect(scene.subagents.followups).toHaveLength(3)
    // The wildcard works inside a list as well, and the member it repeats is
    // still one mailbox: a mixed list is one call, not two.
    const mixed = await scene.service.send(scene.leader.agent, ['Alice', '*'], 'again', signal)
    expect(mixed.deliveries.map(entry => entry.recipient.id)).toEqual(['child-1', 'child-2', 'child-3'])
  })

  it('expands the wildcard for a peer to the leader plus the other members', async () => {
    const { scene, alice } = await trio()
    const broadcast = await scene.service.send(alice.agent, '*', 'status check', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).toEqual(['leader-1', 'child-2', 'child-3'])
    expect(scene.leader.received).toHaveLength(1)
    expect(scene.subagents.followups.map(entry => entry.childId)).toEqual(['child-2', 'child-3'])
  })

  it('expands the wildcard for a managed member to the leader alone', async () => {
    const { scene, carol } = await trio()
    const broadcast = await scene.service.send(carol.agent, '*', 'only you', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).toEqual(['leader-1'])
    expect(scene.leader.received).toHaveLength(1)
    expect(scene.subagents.followups).toHaveLength(0)
  })

  it('never includes the sender in its own wildcard, and refuses a spelled-out self', async () => {
    const { scene, alice } = await trio()
    const broadcast = await scene.service.send(alice.agent, '*', 'hello all', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).not.toContain('child-1')
    expect((await caught(() => scene.service.send(alice.agent, ['Alice'], 'me?', signal)))?.code)
      .toBe('SELF_MESSAGE')
  })

  it('refuses a wildcard with nobody left to address, and an empty list', async () => {
    const scene = world()
    expect((await caught(() => scene.service.send(scene.leader.agent, '*', 'anyone?', signal)))?.code)
      .toBe('UNKNOWN_MEMBER')
    expect((await caught(() => scene.service.send(scene.leader.agent, [], 'hi', signal)))?.code)
      .toBe('UNKNOWN_MEMBER')
  })

  it('delivers nothing at all when one address is unknown, and names that address', async () => {
    const { scene } = await trio()
    const error = await caught(() => scene.service.send(scene.leader.agent, ['Alice', 'Nobody'], 'hi', signal))
    expect(error).toMatchObject({ code: 'UNKNOWN_MEMBER', detail: 'Nobody' })
    expect(scene.subagents.followups).toHaveLength(0)
    expect(scene.leader.received).toHaveLength(0)
  })

  it('delivers nothing when a later recipient cannot afford the message', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3, maxChainRoundTrips: 1 } })
    const alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { relation: 'peer', childId: 'child-2' })
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'first', signal)
    const delivered = scene.subagents.followups.length
    // The leader is the cheap address and comes first in the list; Bob's pair is
    // spent, so checking every recipient first is what keeps this all-or-nothing.
    const error = await caught(() => scene.service.send(alice.agent, ['leader', 'Bob'], 'again', signal))
    expect(error?.code).toBe('PING_PONG')
    expect(scene.leader.received).toHaveLength(0)
    expect(scene.subagents.followups).toHaveLength(delivered)
  })

  it('delivers once when the same member is addressed twice', async () => {
    const { scene } = await trio()
    const broadcast = await scene.service.send(scene.leader.agent, ['Alice', 'Alice', 'child-1'], 'once', signal)
    expect(broadcast.deliveries.map(entry => entry.recipient.id)).toEqual(['child-1'])
    expect(scene.subagents.followups).toHaveLength(1)
  })

  it('refuses a managed member a list that reaches a teammate, delivering none of it', async () => {
    const { scene, carol } = await trio()
    const error = await caught(() => scene.service.send(carol.agent, ['leader', 'Alice'], 'hi', signal))
    expect(error?.code).toBe('UNAUTHORIZED')
    expect(scene.leader.received).toHaveLength(0)
    expect(scene.subagents.followups).toHaveLength(0)
  })

  it('opens one conversation for the whole broadcast, each recipient deepening its own leg', async () => {
    const { scene, alice } = await trio()
    const broadcast = await scene.service.send(scene.leader.agent, ['Alice', 'Bob'], 'sync up', signal)
    expect(broadcast.deliveries.map(entry => entry.chain)).toEqual([
      { chainId: 'c1', hop: 0 },
      { chainId: 'c1', hop: 0 },
    ])
    // The broadcast did not stack hops on Alice: her first relay is one deeper
    // than the message she is working from, exactly as a single send would be.
    expect((await scene.service.send(alice.agent, 'Bob', 'what do you know?', signal)).chain)
      .toEqual({ chainId: 'c1', hop: 1 })
    // One conversation for the whole broadcast: the chain counter advanced once,
    // not once per recipient.
    expect((await scene.service.send(scene.leader.agent, 'Carol', 'second round', signal)).chain)
      .toEqual({ chainId: 'c2', hop: 0 })
  })

  it('spends one hop on a broadcast, not one per recipient', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3, maxChainHops: 1 } })
    const alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { relation: 'peer', childId: 'child-2' })
    await spawn(scene, 'Carol', { relation: 'peer', childId: 'child-3' })
    // Three recipients against a budget of one relay: only the leader's own
    // message may have cost a hop, so the first relay still fits.
    await scene.service.send(scene.leader.agent, '*', 'kickoff', signal)
    expect((await scene.service.send(alice.agent, 'Bob', 'on it', signal)).chain)
      .toEqual({ chainId: 'c1', hop: 1 })
    // And the broadcast did not reset the depth: the next relay is refused.
    expect((await caught(() => scene.service.send(bob.agent, 'Alice', 'me too', signal)))?.code)
      .toBe('CHAIN_EXHAUSTED')
  })
})

describe('task list', () => {
  let scene: World
  let alice: FakeAgent

  beforeEach(async () => {
    scene = world()
    alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
  })

  it('creates rows with short ids and resolves an assignee by name', () => {
    const first = scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'Alice' })
    expect(first).toEqual({ taskId: 't1', title: 'ship it', status: 'pending', assigneeId: 'child-1' })
    expect(scene.service.upsertTask(scene.leader.agent, { title: 'write the note' }).taskId).toBe('t2')
  })

  it('updates one row in place and keeps the fields the update omits', () => {
    scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'child-1' })
    const updated = scene.service.upsertTask(scene.leader.agent, { taskId: 't1', status: 'done', note: 'merged' })
    expect(updated).toEqual({
      taskId: 't1', title: 'ship it', assigneeId: 'child-1', status: 'done', note: 'merged',
    })
  })

  it('refuses a titleless creation, an unknown row, and a teammate writer', () => {
    expect(refusal(() => scene.service.upsertTask(scene.leader.agent, {}))).toBe('TASK_TITLE_REQUIRED')
    expect(refusal(() => scene.service.upsertTask(scene.leader.agent, { taskId: 'tX', status: 'done' })))
      .toBe('UNKNOWN_TASK')
    expect(refusal(() => scene.service.upsertTask(alice.agent, { title: 'sneaky' }))).toBe('UNAUTHORIZED')
  })

  it('lets a member close the row assigned to itself, and records its note', () => {
    scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'child-1' })
    // The close is the member's ONE write: done plus the note, the rest of the
    // row untouched.
    expect(scene.service.closeTask(alice.agent, 't1', 'merged')).toEqual({
      taskId: 't1', title: 'ship it', assigneeId: 'child-1', status: 'done', note: 'merged',
    })
    // The leader reads the same row: one shared list, not one per side.
    expect(scene.service.list(scene.leader.agent).tasks).toEqual([
      { taskId: 't1', title: 'ship it', assigneeId: 'child-1', status: 'done', note: 'merged' },
    ])
  })

  it('keeps an existing note when the close carries none, so a retry is safe', () => {
    scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'child-1', note: 'on it' })
    expect(scene.service.closeTask(alice.agent, 't1')).toMatchObject({ status: 'done', note: 'on it' })
    expect(scene.service.closeTask(alice.agent, 't1', 'merged')).toMatchObject({ status: 'done', note: 'merged' })
  })

  it('refuses a row that is assigned to somebody else, and leaves it untouched', async () => {
    await spawn(scene, 'Bob', { relation: 'peer', childId: 'child-2' })
    scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'child-2' })
    expect(refusal(() => scene.service.closeTask(alice.agent, 't1', 'mine now'))).toBe('UNAUTHORIZED')
    // The refusal is not a partial write: the peer's row is exactly as it was.
    expect(scene.service.list(scene.leader.agent).tasks).toEqual([
      { taskId: 't1', title: 'ship it', assigneeId: 'child-2', status: 'pending' },
    ])
  })

  it('refuses an unassigned row and an unknown row, each by its own code', () => {
    scene.service.upsertTask(scene.leader.agent, { title: 'unowned' })
    expect(refusal(() => scene.service.closeTask(alice.agent, 't1'))).toBe('UNAUTHORIZED')
    expect(refusal(() => scene.service.closeTask(alice.agent, 'tX'))).toBe('UNKNOWN_TASK')
  })

  it('refuses the leader, which already has the whole row through team_task', () => {
    scene.service.upsertTask(scene.leader.agent, { title: 'ship it', assigneeId: 'child-1' })
    expect(refusal(() => scene.service.closeTask(scene.leader.agent, 't1'))).toBe('UNAUTHORIZED')
  })
})

describe('relations and dismissal', () => {
  let scene: World
  let alice: FakeAgent

  beforeEach(async () => {
    scene = world()
    alice = await spawn(scene, 'Alice', { relation: 'managed', childId: 'child-1' })
    await spawn(scene, 'Bob', { relation: 'managed', childId: 'child-2' })
  })

  it('widens one teammate and lets it reach its peers', async () => {
    expect(scene.service.setRelation(scene.leader.agent, 'Alice', 'peer')).toMatchObject({ relation: 'peer' })
    await expect(scene.service.send(alice.agent, 'Bob', 'hello', signal)).resolves.toBeDefined()
  })

  it('refuses a relation change from a teammate', () => {
    expect(() => scene.service.setRelation(alice.agent, 'Bob', 'peer')).toThrow(TeamError)
  })

  it('dismisses one teammate: it is interrupted and leaves the roster', () => {
    expect(scene.service.dismiss(scene.leader.agent, 'Alice')).toEqual({ ended: false, memberId: 'child-1' })
    expect(scene.subagents.interrupted).toEqual(['child-1'])
    expect(scene.service.list(scene.leader.agent).members.map(member => member.name)).toEqual(['Bob'])
  })

  it('disbands the whole team when nobody is named', () => {
    expect(scene.service.dismiss(scene.leader.agent)).toEqual({ ended: true })
    expect(scene.subagents.interrupted).toEqual(['child-1', 'child-2'])
    const view = scene.service.list(scene.leader.agent)
    expect(view.active).toBe(false)
    expect(view.members).toEqual([])
    expect(view.tasks).toEqual([])
  })
})

describe('team read', () => {
  it('reports each teammate live state: running, idle, or ready to wake', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    await spawn(scene, 'Bob', { childId: 'child-2' })
    alice.status = 'running'
    scene.agents.remove('child-2')

    const view = scene.service.list(scene.leader.agent)
    expect(view.active).toBe(true)
    expect(view.members.map(member => [member.name, member.status])).toEqual([
      ['Alice', 'running'],
      ['Bob', 'ready'],
    ])
  })

  it('is empty for a session that never had a team', () => {
    const scene = world()
    expect(scene.service.list(scene.leader.agent)).toEqual({ active: false, members: [], tasks: [], messages: [] })
  })

  it('gives one teammate the roster it needs for its own briefing', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    await spawn(scene, 'Bob', { childId: 'child-2' })
    const roster = scene.service.rosterFor(alice.agent)
    expect(roster?.self.name).toBe('Alice')
    expect(roster?.others.map(member => member.name)).toEqual(['Bob'])
    expect(scene.service.rosterFor(scene.leader.agent)).toBeUndefined()
  })
})

/**
 * One workspace over a fake storage domain: the real {@link TeamWorkspace}, so
 * the board read under test is the one the composition attaches.
 * @returns the workspace and the table behind it.
 */
function boardWorkspace(): TeamWorkspace {
  const table = new FakeWorkspaceTable()
  const domain = {
    name: 'team_workspace',
    table: () => table,
    close: () => Promise.resolve(),
  }
  const ctx = { storageDomain: { open: () => Promise.resolve(domain) } } as unknown as Context
  return new TeamWorkspace(ctx, CONFIG)
}

/** The one table of the workspace domain, as the storage form would hand it over. */
class FakeWorkspaceTable {
  readonly rows = new Map<string, WorkspaceEntry>()

  get(key: string): WorkspaceEntry | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, WorkspaceEntry]> {
    return [...this.rows.entries()][Symbol.iterator]()
  }

  async put(key: string, value: WorkspaceEntry): Promise<void> {
    this.rows.set(key, value)
    await Promise.resolve()
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve()
    return this.rows.delete(key)
  }
}

describe('the live shared board', () => {
  it('shows what a teammate wrote, with its author and one-line preview', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const workspace = boardWorkspace()
    scene.service.attachWorkspace(workspace)
    await workspace.write(
      String(scene.leader.id), SHARED_AREA, 'api decision', '\nwe keep v1\nmore detail', { id: 'child-1', name: 'Alice' }, 100,
    )

    const view = await scene.service.listWithBoard(scene.leader.agent)
    expect(view.board).toEqual([{
      key: 'api decision',
      authorId: String(alice.id),
      authorName: 'Alice',
      updatedAt: 100,
      preview: 'we keep v1',
    }])
  })

  it('reads an empty board with no workspace attached, and keeps the roster', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    const view = await scene.service.listWithBoard(scene.leader.agent)
    expect(view.board).toEqual([])
    expect(view.members.map(member => member.name)).toEqual(['Alice'])
  })

  it('reads the workspace live: a later write is visible on the next read', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    await spawn(scene, 'Bob', { childId: 'child-2' })
    const workspace = boardWorkspace()
    scene.service.attachWorkspace(workspace)
    const leaderId = String(scene.leader.id)
    await workspace.write(leaderId, SHARED_AREA, 'plan', 'first', { id: 'child-1', name: 'Alice' }, 100)
    expect((await scene.service.listWithBoard(scene.leader.agent)).board.map(entry => entry.preview))
      .toEqual(['first'])

    await workspace.write(leaderId, SHARED_AREA, 'plan', 'second', { id: 'child-2', name: 'Bob' }, 200)
    expect((await scene.service.listWithBoard(scene.leader.agent)).board).toEqual([{
      key: 'plan', authorId: 'child-2', authorName: 'Bob', updatedAt: 200, preview: 'second',
    }])
  })

  it('keeps the roster available when the workspace cannot be read', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    scene.service.attachWorkspace({ index: () => Promise.reject(new Error('domain closed')) })

    const view = await scene.service.listWithBoard(scene.leader.agent)
    expect(view.board).toEqual([])
    expect(view.members).toHaveLength(1)
  })

  it('empties the board once the workspace is detached', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    const workspace = boardWorkspace()
    scene.service.attachWorkspace(workspace)
    await workspace.write(String(scene.leader.id), SHARED_AREA, 'plan', 'ours', { id: 'child-1', name: 'Alice' }, 100)
    expect((await scene.service.listWithBoard(scene.leader.agent)).board).toHaveLength(1)

    scene.service.attachWorkspace(undefined)
    expect((await scene.service.listWithBoard(scene.leader.agent)).board).toEqual([])
  })
})

describe('hydration', () => {
  it('rebuilds the roster and the task list from the leader log on first touch', () => {
    const events = [
      toolResultEvent({
        team: 'member-added',
        member: { memberId: 'child-1', name: 'Alice', relation: 'peer', role: 'reviewer', effort: 'high' },
      }, { time: 500 }),
      toolResultEvent({ team: 'task', task: { taskId: 't1', title: 'ship', status: 'active', assigneeId: 'child-1' } }),
    ]
    const scene = world({ leader: fakeAgent('leader-1', { events }) })
    scene.agents.add(fakeAgent('child-1', { parent: 'leader-1' }))

    const view = scene.service.list(scene.leader.agent)
    expect(view.members).toEqual([{
      memberId: 'child-1', name: 'Alice', role: 'reviewer', relation: 'peer', effort: 'high',
      joinedAt: 500, status: 'idle',
    }])
    expect(view.tasks).toEqual([{ taskId: 't1', title: 'ship', status: 'active', assigneeId: 'child-1' }])
  })

  it('lets a cold-resumed child re-adopt its own membership', () => {
    const events = [toolResultEvent({
      team: 'member-added',
      member: { memberId: 'child-1', name: 'Alice', relation: 'peer' },
    })]
    const scene = world({ leader: fakeAgent('leader-1', { events }) })
    const child = fakeAgent('child-1', { parent: 'leader-1' })
    expect(scene.service.adopt(child.agent)).toMatchObject({ name: 'Alice', relation: 'peer' })
  })
})

describe('conversation chains', () => {
  /**
   * Run one asynchronous operation expected to refuse.
   * @param run - the operation.
   * @returns the refusal code, or `no-throw` when it was accepted.
   */
  async function refusalOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
      return 'no-throw'
    } catch (error: unknown) {
      return error instanceof TeamError ? error.code : `other: ${String(error)}`
    }
  }

  /** A leader with two peers, so a message can relay from one to the other. */
  async function pair(config?: TeamConfig): Promise<{
    readonly scene: World
    readonly alice: FakeAgent
    readonly bob: FakeAgent
  }> {
    const scene = world(config === undefined ? {} : { config })
    const alice = await spawn(scene, 'Alice', { relation: 'peer', childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { relation: 'peer', childId: 'child-2' })
    return { scene, alice, bob }
  }

  it('opens a fresh conversation for every message the leader sends', async () => {
    const { scene } = await pair()
    const first = await scene.service.send(scene.leader.agent, 'Alice', 'start', signal)
    const second = await scene.service.send(scene.leader.agent, 'Alice', 'again', signal)
    expect(first.chain).toEqual({ chainId: 'c1', hop: 0 })
    expect(second.chain).toEqual({ chainId: 'c2', hop: 0 })
  })

  it('continues the conversation a teammate is working from, one relay deeper', async () => {
    const { scene, alice, bob } = await pair()
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    const relayed = await scene.service.send(alice.agent, 'Bob', 'what do you know?', signal)
    expect(relayed.chain).toEqual({ chainId: 'c1', hop: 1 })

    const back = await scene.service.send(bob.agent, 'Alice', 'here is what I know', signal)
    expect(back.chain).toEqual({ chainId: 'c1', hop: 2 })
  })

  it('carries the depth into the durable source the recipient keeps', async () => {
    const { scene, alice } = await pair()
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'what do you know?', signal)
    expect(scene.subagents.followups.at(-1)?.source).toMatchObject({ chainId: 'c1', hop: 1, senderName: 'Alice' })
  })

  it('refuses a peer relay once the conversation has gone as far as it may', async () => {
    const { scene, alice, bob } = await pair({ ...CONFIG, maxChainHops: 2, maxChainRoundTrips: 8 })
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'first', signal)
    await scene.service.send(bob.agent, 'Alice', 'second', signal)

    expect(await refusalOf(() => scene.service.send(alice.agent, 'Bob', 'third', signal)))
      .toBe('CHAIN_EXHAUSTED')
  })

  it('never refuses the way out: the leader stays reachable from a spent conversation', async () => {
    const { scene, alice, bob } = await pair({ ...CONFIG, maxChainHops: 2, maxChainRoundTrips: 8 })
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'first', signal)
    await scene.service.send(bob.agent, 'Alice', 'second', signal)

    const escalated = await scene.service.send(alice.agent, 'leader', 'we cannot settle this', signal)
    expect(escalated.recipient.kind).toBe('leader')
  })

  it('refuses one pair that keeps trading messages inside the same conversation', async () => {
    const { scene, alice, bob } = await pair({ ...CONFIG, maxChainHops: 16, maxChainRoundTrips: 1 })
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'first', signal)
    await scene.service.send(bob.agent, 'Alice', 'second', signal)

    expect(await refusalOf(() => scene.service.send(alice.agent, 'Bob', 'third', signal)))
      .toBe('PING_PONG')
  })

  it('refuses a verbatim repeat, which changes nothing for the recipient', async () => {
    const { scene, alice, bob } = await pair({ ...CONFIG, maxChainHops: 16, maxChainRoundTrips: 8 })
    await scene.service.send(scene.leader.agent, 'Alice', 'look into it', signal)
    await scene.service.send(alice.agent, 'Bob', 'please confirm', signal)
    await scene.service.send(bob.agent, 'Alice', 'confirm what?', signal)

    expect(await refusalOf(() => scene.service.send(alice.agent, 'Bob', 'please confirm', signal)))
      .toBe('REPEATED_MESSAGE')
  })

  it('starts the count over when the leader sends again, so real work is never trapped', async () => {
    const { scene, alice } = await pair({ ...CONFIG, maxChainHops: 1, maxChainRoundTrips: 1 })
    await scene.service.send(scene.leader.agent, 'Alice', 'round one', signal)
    await scene.service.send(alice.agent, 'Bob', 'first', signal)
    expect(await refusalOf(() => scene.service.send(alice.agent, 'Bob', 'again', signal))).toBe('PING_PONG')

    await scene.service.send(scene.leader.agent, 'Alice', 'round two', signal)
    const fresh = await scene.service.send(alice.agent, 'Bob', 'again', signal)
    expect(fresh.chain).toEqual({ chainId: 'c2', hop: 1 })
  })
})

describe('a leader that is not loaded', () => {
  /**
   * Run one operation expected to refuse.
   * @param run - the operation.
   * @returns the refusal code, or `no-throw` when it was accepted.
   */
  async function codeOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
      return 'no-throw'
    } catch (error: unknown) {
      return error instanceof TeamError ? error.code : `other: ${String(error)}`
    }
  }

  it('tells a teammate its leader is away, not that it has no team', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { relation: 'peer' })
    scene.agents.remove(scene.leader.id)

    expect(await codeOf(() => scene.service.send(alice.agent, 'leader', 'here it is', signal)))
      .toBe('LEADER_AWAY')
  })

  it('says no team for a subagent that never belonged to one', async () => {
    const scene = world()
    const stray = scene.agents.add(fakeAgent('stray-1', { parent: scene.leader.id }))

    expect(await codeOf(() => scene.service.send(stray.agent, 'leader', 'hello', signal)))
      .toBe('NO_TEAM')
  })

  it('resolves a top-level session as its own leader, so the refusal names the recipient', async () => {
    const scene = world()
    expect(await codeOf(() => scene.service.send(scene.leader.agent, 'Alice', 'hello', signal)))
      .toBe('UNKNOWN_MEMBER')
  })
})

/**
 * Waiting for the roster to settle. The seam under test is
 * `Agent.whenIdle()` — the double models it as "resolves now while idle,
 * resolves on release while running" — so these cases fix the primitive's
 * contract rather than a polling loop's timing.
 */
describe('wait', () => {
  /**
   * Run one async operation expected to refuse.
   * @param run - the operation.
   * @returns the refusal code, or `no-throw` when it was accepted.
   */
  async function codeOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
      return 'no-throw'
    } catch (error: unknown) {
      return error instanceof TeamError ? error.code : `other: ${String(error)}`
    }
  }

  /**
   * Let wall-clock time pass. Used only to step past the wait's own settle
   * window; every assertion about state stays promise-driven.
   * @param ms - how long to wait.
   * @returns a promise that resolves afterwards.
   */
  async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  }

  /**
   * Count the live subscriptions to the given events for the duration of one
   * case, by wrapping this world's own `on`. Cordis keeps a listener registered
   * until its disposer runs, and a wait gets no automatic cleanup, so the
   * disposers a wait has NOT called are exactly the leak this measures. The
   * service's construction-time `agent/disposed` listener is registered before
   * this wrapper, so it is never counted.
   * @param scene - the world whose context the waits subscribe on.
   * @param names - the event names to count.
   * @returns the live disposers; empty once every subscription was dropped.
   */
  function trackSubscriptions(scene: World, names: readonly string[]): Set<() => void> {
    const live = new Set<() => void>()
    const loose = scene.ctx as unknown as {
      on: (name: string, listener: (payload: { agent: { id: string } }) => void) => () => boolean
    }
    const original = loose.on.bind(loose)
    loose.on = (name, listener) => {
      const dispose = original(name, listener)
      if (!names.includes(name)) return dispose
      const tracked = (): boolean => {
        live.delete(tracked)
        return dispose()
      }
      live.add(tracked)
      return tracked
    }
    return live
  }

  /**
   * Count the live `agent/created` subscriptions through {@link trackSubscriptions}.
   * @param scene - the world whose context the wait subscribes on.
   * @returns the live disposers; empty once every subscription was dropped.
   */
  function trackCreated(scene: World): Set<() => void> {
    return trackSubscriptions(scene, ['agent/created'])
  }

  /**
   * Record EVERY subscription armed in this world, in order — not just the live
   * ones. {@link trackSubscriptions} answers "what is still armed", which cannot
   * tell "never subscribed" from "subscribed and dropped on the way out": a wait
   * that armed a listener and released it before returning leaves it empty too.
   * The precheck claims it arms nothing at all, so this counts the arming.
   * @param scene - the world whose context the waits subscribe on.
   * @returns the event name of each subscription, in the order it was armed.
   */
  function armedSubscriptions(scene: World): string[] {
    const armed: string[] = []
    const loose = scene.ctx as unknown as {
      on: (name: string, listener: (payload: { agent: { id: string } }) => void) => () => boolean
    }
    const original = loose.on.bind(loose)
    loose.on = (name, listener) => {
      armed.push(name)
      return original(name, listener)
    }
    return armed
  }

  /**
   * The all-clear case under the new condition: both members' turns are over AND
   * both reports are already readable, so the answer is immediate and carries
   * what each member said. A member with nothing readable is not done at all —
   * the next case is that half.
   */
  it('returns at once with every member done and its report readable', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.leader.inbox.nextStep.push(
      settlementNotice(alice.id, 'alice done'),
      settlementNotice(bob.id, 'bob done'),
    )

    expect(await scene.service.wait(scene.leader.agent))
      .toEqual({
        done: ['Alice', 'Bob'], busy: [], cold: [], timedOut: false,
        reports: [{ member: 'Alice', text: 'alice done' }, { member: 'Bob', text: 'bob done' }],
      })
  })

  it('blocks while a member runs, and returns as soon as it is idle and reported', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
      .then((value) => { resolved.push(true); return value })
    // Past the settle window, so the wait is now holding a live `whenIdle()`.
    await sleep(80)
    expect(resolved).toEqual([])

    // The turn ends and the runtime hands its closing words over: under the new
    // rule those two are one event as far as the caller is concerned.
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    alice.goIdle()
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
  })

  /**
   * The race the settle window exists for: `team_send` accepts a prompt into the
   * recipient's inbox, and the recipient's driver starts a moment later. Read in
   * the same tick, the member still looks idle and `whenIdle()` answers
   * immediately — so a wait issued straight from the sending turn would report
   * "done" before anyone had begun.
   *
   * The wake is modelled as a queued microtask, which is what makes this a
   * negative control: drop the settle and the read happens before the wake, so
   * `resolved` fills up while the member is still about to start.
   */
  it('does not call a just-delivered member done before its wake lands', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // The delivery was accepted a moment ago; the driver wake is still queued.
    queueMicrotask(() => { alice.status = 'running' })

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
      .then((value) => { resolved.push(true); return value })
    await sleep(80)
    expect(resolved).toEqual([])

    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    alice.goIdle()
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
  })

  it('re-reads the roster after the settle, so a member published meanwhile is still awaited', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // A cold recipient: the roster row exists, no live agent yet. The accepted
    // delivery resumes and publishes it just after the wait begins.
    scene.agents.remove(alice.id)
    alice.status = 'running'
    setTimeout(() => { scene.agents.add(alice) }, 0)

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
      .then((value) => { resolved.push(true); return value })
    await sleep(80)
    expect(resolved).toEqual([])

    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    alice.goIdle()
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
  })

  /**
   * The regression lock for the reported bug: a leader that broadcasts to a cold
   * member and waits straight away used to get "everyone is back" in one tick,
   * because `observeIdle()` released a member with no live agent as if it had
   * finished. A member that was never resident has not finished anything — it
   * has not started — so it must land in `cold`, and never in `done`.
   */
  it('does not count a member that was never resident as done', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // The delivery is accepted but the recipient is still cold: the roster row
    // exists, nothing has been published for it, and nothing will be inside
    // this window.
    scene.agents.remove(alice.id)
    alice.status = 'running'

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.done).toEqual([])
    expect(observed.busy).toEqual([])
    expect(observed.cold).toEqual(['Alice'])
    expect(observed.timedOut).toBe(true)
    // It waited the budget out instead of answering in one tick.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  /**
   * The other half of the cold contract: a cold member that IS woken inside the
   * window must then be waited for properly. The publication turns the target
   * into a normal `whenIdle()` observation instead of an answer.
   */
  it('waits for a cold member that is published inside the window', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    alice.status = 'running'
    // Published after the settle window, so the cold path is the one that runs.
    setTimeout(() => { scene.agents.add(alice) }, 60)

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
      .then((value) => { resolved.push(true); return value })
    await sleep(160)
    // Published and running: observed, not answered.
    expect(resolved).toEqual([])
    // The publication was read, and the wait moved onto the harness's own signal.
    expect(alice.idleCalls).toBe(1)

    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    alice.goIdle()
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
  })

  it('reports the members still running when the budget expires, without hanging', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    alice.status = 'running'
    // Bob is finished already — and finished means his report is readable too.
    scene.leader.inbox.nextStep.push(settlementNotice(bob.id, 'bob done'))

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 20 })
    expect(observed).toEqual({
      done: ['Bob'], busy: ['Alice'], cold: [], timedOut: true,
      reports: [{ member: 'Bob', text: 'bob done' }],
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  /**
   * The reaped case, which the cold bug used to hide inside. A member that WAS
   * resident during the window and is gone at the deadline occupies no turn, so
   * it is done — the deadline is what keeps the wait from hanging on a ghost,
   * not the "no agent means nothing left to do" shortcut that broke cold members.
   * Its disposal is heard as it happens, so the answer arrives without waiting
   * the budget out: `timedOut` reports that an observation actually settled.
   */
  it('counts a member seen resident, then reaped, as done', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'

    const started = Date.now()
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 2_000 })
    await sleep(40)
    // A reaped member still has to have handed something back; disposal is a
    // finish signal, not an answer.
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    scene.agents.remove(alice.id)

    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
    expect(Date.now() - started).toBeLessThan(500)
  })

  /**
   * The reported false alarm, as a lock: a member that finished a whole turn
   * between the spawn and the wait — the host trace showed 1.3 s — has already
   * been reaped by the time the wait runs its first read. "No live agent" then
   * means "nothing of it is left to watch", NOT "never started", and the trace of
   * its work is its own report in the leader's mailbox. Calling that "never
   * started" reports a completed member as missing.
   */
  it('counts a member that finished and was reaped, then reported back, as done', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // The only remaining trace: the leader's own log, exactly the two rows a
    // finished turn leaves in it — the roster fact from the spawn, and the
    // member's report folded into the mailbox. Nothing live is left: the session
    // was reaped after the turn, which is the host trace.
    scene.leader.session.events.push(
      toolResultEvent({
        team: 'member-added',
        member: { memberId: alice.id, name: 'Alice', relation: 'managed' },
      } as never),
      userMessageEvent({
        kind: 'team-message',
        form: 'relay',
        chainId: 'c1',
        hop: 1,
        senderSessionId: alice.id,
        senderName: 'Alice',
      }, 'OK'),
    )
    scene.agents.remove(alice.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: true, reports: [{ member: 'Alice', text: 'OK' }] })
  })

  /**
   * The other side of the same judgement: the mailbox is checked PER MEMBER. A
   * teammate that wrote back does not stand in for one that said nothing, so a
   * roster with one report and one silent member still reports the silent member
   * as cold.
   */
  it('keeps a member cold when the only mailbox rows come from someone else', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.leader.session.events.push(
      toolResultEvent({
        team: 'member-added',
        member: { memberId: bob.id, name: 'Bob', relation: 'managed' },
      } as never),
      userMessageEvent({
        kind: 'team-message',
        form: 'relay',
        chainId: 'c2',
        hop: 1,
        senderSessionId: bob.id,
        senderName: 'Bob',
      }, 'done'),
    )
    // Alice never wrote back and nothing live is left of her.
    scene.agents.remove(alice.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Bob'], busy: [], cold: ['Alice'], timedOut: true, reports: [{ member: 'Bob', text: 'done' }] })
  })

  /**
   * Why the mailbox rule reads the LAST row naming the member instead of any row
   * from it. A report from an earlier round is not evidence about this round: once
   * the leader has addressed the member again, that delivery may simply not have
   * woken it yet — the exact over-claim that made "no live agent means done" wrong
   * the first time. The newer outbound row therefore outranks the older report.
   */
  it('does not count an older report as done once the member has been addressed again', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(
      toolResultEvent({
        team: 'member-added',
        member: { memberId: alice.id, name: 'Alice', relation: 'managed' },
      } as never),
      // Its report from the previous round...
      userMessageEvent({
        kind: 'team-message',
        form: 'relay',
        chainId: 'c1',
        hop: 1,
        senderSessionId: alice.id,
        senderName: 'Alice',
      }, 'OK'),
      // ...and a delivery the leader accepted after it, not yet woken.
      toolResultEvent({
        team: 'message',
        messageId: 'm-2',
        to: alice.id,
        text: 'next round',
        hop: 0,
      } as never),
    )
    scene.agents.remove(alice.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
  })

  /**
   * The reported bug, as a lock. A member that was sent "just reply OK" answers
   * and its whole turn fits between the delivery and the wait — so when the wait
   * reads the registry the member is already reaped, and its report has not
   * reached the log yet either: the runtime parks the settlement notice in the
   * LEADER'S INBOX, and the log only sees it at the next step boundary. The
   * session log alone therefore said "no live session, no report" and the leader
   * was told `cold` about a member that had already answered.
   */
  it('counts a member whose settlement notice is queued in the leader inbox as done', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    // Exact shape the harness's continuation manager queues on next-step.
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id))

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: true, reports: [{ member: 'Alice', text: 'Alice finished.' }] })
  })

  /**
   * The same member, one moment later — and the case the inbox rule cannot see.
   *
   * The settlement notice is consumed at the next step boundary: a second
   * `agent/inbox/spliced` removes it with nothing inserted. When the turn is
   * interrupted before that boundary delivers the notice as model-visible input,
   * no `user/message` is ever written, so the durable mailbox never learns that
   * the member answered. The insertion row stays in the log for good, and it
   * names the child in `source.senderSessionId`. That row is the evidence, so a
   * reader that only looks at the live queue reports `cold` for a member that
   * has already finished.
   */
  it('counts a member whose notice was consumed, leaving only the spliced log row', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // 1. The manager inserted the notice on the next-step boundary...
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    // 2. ...and the boundary consumed it, with no `user/message` behind it.
    scene.leader.session.events.push(inboxSplicedEvent([], { removed: 1 }))
    scene.agents.remove(alice.id)
    // Nothing is queued: the evidence exists only in the log.
    expect(scene.leader.inbox.nextStep).toEqual([])

    // Answered from the log BEFORE the clock starts, so the same member is
    // `done` without spending the budget — the deadline no longer decides it.
    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: false, reports: [{ member: 'Alice', text: 'Alice finished.' }] })
  })

  /**
   * The spliced row is read PER MEMBER, exactly as the queued one is: Bob's
   * completion says nothing about Alice, who never wrote back.
   */
  it('does not credit a member with another member\u2019s spliced report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.leader.session.events.push(
      inboxSplicedEvent([settlementNotice(bob.id, 'Bob finished.')]),
      inboxSplicedEvent([], { removed: 1 }),
    )
    scene.agents.remove(alice.id)
    scene.agents.remove(bob.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Bob'], busy: [], cold: ['Alice'], timedOut: true, reports: [{ member: 'Bob', text: 'Bob finished.' }] })
  })

  /**
   * The kind is narrowed BEFORE any sender field is read, on the log side too.
   * The same boundary carries the leader's own user input and runtime notices;
   * a source that is not a teammate report must be skipped, not credited to
   * whoever happens to be waiting.
   */
  it('ignores a spliced inbox row whose source is not a teammate report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(inboxSplicedEvent([
      createUserMessage({
        content: [{ type: 'text', text: 'an ordinary user line' }],
        source: { kind: 'user' },
      }),
    ]))
    scene.agents.remove(alice.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
  })

  /**
   * The over-claim the log rule must not introduce, and the reason its freshness
   * boundary is the DELIVERY rather than the wait.
   *
   * A finished member's spliced row sits BEFORE the wait that reads it — the
   * member finished while the leader was still writing the tool call — so a
   * boundary taken at wait start would discard the very evidence it needs. What
   * must not be read as this round's answer is a row from before the task being
   * waited on: round one's report, then round two delivered, and the member not
   * woken yet. The row that answers round two has to sit after the delivery, and
   * then it counts.
   */
  it('reads spliced reports from this round only, not from before the delivery', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // Round one's answer, already spliced into the log...
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    scene.agents.remove(alice.id)
    // ...and round two's task, accepted after it.
    await scene.service.send(scene.leader.agent, 'Alice', 'one more thing', signal)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })

    // Round two's answer, spliced after the delivery, is the one that counts —
    // and it is counted before the wait arms anything, so this one does not time
    // out either. The watermark, not the clock, is what separates the two halves.
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: false, reports: [{ member: 'Alice', text: 'Alice finished.' }] })
  })

  /**
   * The same judgement for the other queued shape: a member that answered
   * through `team_send` leaves the delivery itself parked on `next-turn`.
   */
  it('counts a member whose queued team_send reply has not been consumed yet as done', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    scene.leader.inbox.nextTurn.push(queuedReply(alice.id, 'Alice'))

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: true, reports: [{ member: 'Alice', text: 'OK' }] })
  })

  /**
   * The inbox rule is per member, not "somebody reported": Bob's queued reply
   * says nothing about Alice, so Alice stays cold.
   */
  it('does not credit a member with another member\u2019s queued report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.agents.remove(alice.id)
    scene.agents.remove(bob.id)
    scene.leader.inbox.nextStep.push(settlementNotice(bob.id, 'Bob finished.'))

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: ['Bob'], busy: [], cold: ['Alice'], timedOut: true, reports: [{ member: 'Bob', text: 'Bob finished.' }] })
  })

  /**
   * The kind is narrowed BEFORE any sender field is read. The leader's inbox
   * holds messages from many producers (its own user input, runtime notices),
   * and a source with no `senderSessionId` at all must be skipped, not thrown
   * on and not credited to whoever happens to be waiting.
   */
  it('ignores a queued inbox message whose source is not a teammate report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    scene.leader.inbox.nextStep.push(createUserMessage({
      content: [{ type: 'text', text: 'an ordinary user line' }],
      source: { kind: 'user' },
    }))

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
  })

  /**
   * "Something is queued" is not "a member reported". The leader's own
   * deliveries are `team-message` sources too; only a sender that is one of
   * THIS wait's targets may be credited, or the leader's own outbound rows
   * would read as answers from the members it is waiting for.
   */
  it('does not count a queued message the leader itself sent as any member\u2019s reply', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.agents.remove(alice.id)
    scene.agents.remove(bob.id)
    // Queued on the leader's own boundary, attributed to the leader.
    scene.leader.inbox.nextTurn.push(queuedReply(String(scene.leader.id), 'leader', 'rebroadcast'))

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice', 'Bob'], timedOut: true, reports: [] })
  })

  /**
   * The over-claim the inbox rule must not introduce. A reply from the previous
   * round may still be queued, because nothing has consumed it yet; once the
   * leader delivers a NEW task to that member, the old reply is no evidence
   * about the new one, which may simply not have been woken. The delivery
   * therefore freezes whatever was already queued, and only a message that
   * arrives after it can count.
   */
  it('does not count a queued reply from an earlier round once a new delivery is pending', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // Round one's answer, still sitting in the queue...
    scene.leader.inbox.nextTurn.push(queuedReply(alice.id, 'Alice'))
    scene.agents.remove(alice.id)
    // ...and round two's task, accepted but not woken yet.
    await scene.service.send(scene.leader.agent, 'Alice', 'one more thing', signal)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 40 }))
      .toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
  })

  /**
   * The queue is read per target and still lands each member in exactly one
   * bucket: one running, one finished with its notice queued, one silent.
   */
  it('keeps the three buckets disjoint when a member reports through the inbox', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { childId: 'child-3' })
    alice.status = 'running'
    scene.agents.remove(bob.id)
    scene.agents.remove(carol.id)
    scene.leader.inbox.nextStep.push(settlementNotice(bob.id, 'Bob finished.'))

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed).toEqual({ done: ['Bob'], busy: ['Alice'], cold: ['Carol'], timedOut: true, reports: [{ member: 'Bob', text: 'Bob finished.' }] })

    const flat = [...observed.done, ...observed.busy, ...observed.cold]
    expect(new Set(flat).size).toBe(flat.length)
    expect([...flat].sort()).toEqual(['Alice', 'Bob', 'Carol'])
  })

  /**
   * The whole point of the split, in one scene: a hot member that finishes, a hot
   * member that does not, and a cold member that never appears. Asserting the
   * union and the disjointness, not three separate lists, because the failure this
   * guards against is a member landing in two buckets — or in none.
   */
  it('splits a mixed roster into three disjoint buckets covering every target', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { childId: 'child-3' })
    alice.status = 'running'
    bob.status = 'running'
    // Carol is the cold one: the roster row exists, no live session does.
    scene.agents.remove(carol.id)
    carol.status = 'running'
    // Alice finishes inside the window and hands her words back with the finish;
    // Bob never does either.
    setTimeout(() => {
      scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
      alice.goIdle()
    }, 40)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 150 })
    expect(observed).toEqual({
      done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })

    const flat = [...observed.done, ...observed.busy, ...observed.cold]
    // Disjoint: no name twice.
    expect(new Set(flat).size).toBe(flat.length)
    // Union: every target named exactly once.
    expect([...flat].sort()).toEqual(['Alice', 'Bob', 'Carol'])
  })

  /**
   * A cold member is watched through one `agent/created` subscription, and a wait
   * that ends must drop it: a listener that outlived its wait would wake a dead
   * closure on every later publication of that session, one leak per timeout.
   */
  it('drops its agent/created subscription when the wait times out', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    const live = trackCreated(scene)

    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 60 })
    await sleep(40)
    // Armed while the cold member is still being waited for...
    expect(live.size).toBe(1)

    expect(await waiting).toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
    // ...and gone the moment the budget ended.
    expect(live.size).toBe(0)
  })

  it('drops it when the caller cancels a wait over a cold member', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    const live = trackCreated(scene)
    const controller = new AbortController()

    const waiting = scene.service.wait(scene.leader.agent, {
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    await sleep(40)
    expect(live.size).toBe(1)

    controller.abort()
    expect(await codeOf(() => waiting)).toBe('ABORTED')
    expect(live.size).toBe(0)
  })

  it('drops it as soon as the member it was waiting for is published', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.agents.remove(alice.id)
    const live = trackCreated(scene)

    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
    await sleep(40)
    expect(live.size).toBe(1)

    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    scene.agents.add(alice)
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
    expect(live.size).toBe(0)
  })

  it('refuses with ABORTED instead of reporting half a roster', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    const controller = new AbortController()

    const waiting = scene.service.wait(scene.leader.agent, { signal: controller.signal, timeoutMs: 5_000 })
    controller.abort()

    expect(await codeOf(() => waiting)).toBe('ABORTED')
    // A refused wait is an observation abandoned, not a member disturbed.
    expect(alice.status).toBe('running')
  })

  it('refuses an already-aborted call before it observes anyone', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    const controller = new AbortController()
    controller.abort()

    expect(await codeOf(() => scene.service.wait(scene.leader.agent, { signal: controller.signal })))
      .toBe('ABORTED')
    expect(alice.idleCalls).toBe(0)
  })

  it('refuses an address the roster cannot place, the leader itself included', async () => {
    const scene = world()
    await spawn(scene, 'Alice')

    expect(await codeOf(() => scene.service.wait(scene.leader.agent, { members: ['Nobody'] })))
      .toBe('UNKNOWN_MEMBER')
    expect(await codeOf(() => scene.service.wait(scene.leader.agent, { members: ['leader'] })))
      .toBe('UNKNOWN_MEMBER')
  })

  it('answers an empty team, and an empty selection, without arming a wait', async () => {
    const scene = world()
    expect(await scene.service.wait(scene.leader.agent))
      .toEqual({ done: [], busy: [], cold: [], timedOut: false, reports: [] })

    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    expect(await scene.service.wait(scene.leader.agent, { members: [], timeoutMs: 60_000 }))
      .toEqual({ done: [], busy: [], cold: [], timedOut: false, reports: [] })
    expect(alice.idleCalls).toBe(0)
  })

  it('names each member once, however it was addressed', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))

    expect(await scene.service.wait(scene.leader.agent, { members: ['Alice', 'alice', alice.id] }))
      .toEqual({
        done: ['Alice'], busy: [], cold: [], timedOut: false,
        reports: [{ member: 'Alice', text: 'alice done' }],
      })
  })

  /**
   * The latency lock for the reported bug. A member that is reaped while it is
   * being observed takes its `whenIdle()` promise with it: the disposed agent
   * never settles it, so a wait that raced only the idle signal sat out its whole
   * budget and THEN classified the member correctly from the registry. The
   * answer was right — `all finished: a, b` — and the latency was the defect:
   * 20 041 ms against a 20 000 ms budget, in the host trace that found this.
   *
   * Disposal is a finish signal of its own — a reaped agent occupies no turn —
   * so the wait must return on it, far inside the budget.
   */
  it('returns as soon as a running member is reaped, instead of sitting out the budget', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'

    const started = Date.now()
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 2_000 })
    // Past the settle window, so the wait is holding a live `whenIdle()`.
    await sleep(80)
    // Its closing words were delivered before the reaping, as the runtime does
    // while the parent is mid-turn.
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    scene.agents.remove(alice.id)

    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
    // Seconds, not the budget: the bug returned after ~2 000 ms here.
    expect(Date.now() - started).toBeLessThan(500)
  })

  /**
   * The negative control for the disposal signal. A listener that released on
   * ANY `agent/disposed` would answer "done" for a member that is still working
   * the moment a different member is reaped — the same false "everyone is back"
   * the cold rules exist to prevent, only arriving early. Only the disposal of
   * the very agent an observation follows may settle it.
   */
  it('does not finish a running member because a different agent was reaped', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    alice.status = 'running'

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { members: ['Alice'], timeoutMs: 150 })
      .then((value) => { resolved.push(true); return value })
    // Past the settle window: Alice is being observed, Bob is not a target.
    await sleep(60)
    expect(resolved).toEqual([])

    scene.agents.remove(bob.id)
    await sleep(50)
    // Bob's disposal is not news about Alice's turn.
    expect(resolved).toEqual([])

    expect(await waiting).toEqual({ done: [], busy: ['Alice'], cold: [], timedOut: true, reports: [] })
  })

  /**
   * The disposal subscription lives exactly as long as the observation it feeds.
   * Dropped when the member settles.
   */
  it('drops its agent/disposed subscription when the member settles', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    const live = trackSubscriptions(scene, ['agent/created', 'agent/disposed'])

    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
    await sleep(60)
    // One live observation, one live subscription.
    expect(live.size).toBe(1)

    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice done'))
    alice.goIdle()
    expect(await waiting).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }],
    })
    expect(live.size).toBe(0)
  })

  /** The same lifetime on the deadline path, where the budget ends the wait. */
  it('drops its agent/disposed subscription when the wait times out', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    const live = trackSubscriptions(scene, ['agent/created', 'agent/disposed'])

    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 60 })
    await sleep(40)
    expect(live.size).toBe(1)

    expect(await waiting).toEqual({ done: [], busy: ['Alice'], cold: [], timedOut: true, reports: [] })
    expect(live.size).toBe(0)
  })

  /** And on cancellation, where the caller's signal ends it. */
  it('drops its agent/disposed subscription when the caller cancels', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    const live = trackSubscriptions(scene, ['agent/created', 'agent/disposed'])
    const controller = new AbortController()

    const waiting = scene.service.wait(scene.leader.agent, { signal: controller.signal, timeoutMs: 5_000 })
    await sleep(40)
    expect(live.size).toBe(1)

    controller.abort()
    expect(await codeOf(() => waiting)).toBe('ABORTED')
    expect(live.size).toBe(0)
  })

  /**
   * The reported scenario end to end: two members answer "just reply OK" and
   * both are reaped while the leader waits. The answer is `all finished` and the
   * latency is seconds — the host trace returned the same answer after its full
   * 20 000 ms budget, which is the defect this locks out. The budget here is
   * scaled down to 2 000 ms so a regression reports the wait's own timeout rather
   * than the test runner's.
   */
  it('answers a two-member round with both done, in seconds rather than the budget', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    alice.status = 'running'
    bob.status = 'running'

    const started = Date.now()
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 2_000 })
    await sleep(100)
    scene.leader.inbox.nextStep.push(
      settlementNotice(alice.id, 'alice done'),
      settlementNotice(bob.id, 'bob done'),
    )
    scene.agents.remove(alice.id)
    scene.agents.remove(bob.id)

    expect(await waiting).toEqual({
      done: ['Alice', 'Bob'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'alice done' }, { member: 'Bob', text: 'bob done' }],
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  /**
   * The reported trace, one clock tick later — the case the disposal race cannot
   * reach. Both members finished and were reaped BEFORE the wait was called, so
   * at wait start there is no live agent to race and no `agent/disposed` still to
   * come: `observeIdle` takes its cold path, subscribes to an `agent/created`
   * that will never fire for a dead session, and sits out the whole budget before
   * `bucketOf` finally reads the spliced rows that were there from the start
   * (20 037 ms against a 20 000 ms budget in the host trace).
   *
   * The evidence that the round happened is durable and already in the log, so
   * the wait owes an answer at once — not the right answer at the deadline.
   */
  it('returns at once when the whole round finished and was reaped before the wait began', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    // What a finished "just reply OK" turn leaves behind: the settlement row the
    // runtime spliced on the leader's inbox boundary, and the consumption that
    // removed it with nothing inserted.
    scene.leader.session.events.push(
      inboxSplicedEvent([settlementNotice(alice.id, 'Alice finished.')]),
      inboxSplicedEvent([settlementNotice(bob.id, 'Bob finished.')]),
      inboxSplicedEvent([], { removed: 2 }),
    )
    scene.agents.remove(alice.id)
    scene.agents.remove(bob.id)

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 2_000 })
    const elapsed = Date.now() - started

    // Seconds, not the budget: the answer was already in the log when the wait
    // began, so there was nothing left to watch.
    expect(elapsed).toBeLessThan(1_000)
    expect(observed).toEqual({ done: ['Alice', 'Bob'], busy: [], cold: [], timedOut: false, reports: [{ member: 'Alice', text: 'Alice finished.' }, { member: 'Bob', text: 'Bob finished.' }] })
  })

  /**
   * The economy of the precheck, not just its verdict: a member settled from the
   * log must arm NOTHING. `observeIdle`'s cold path buys a publication
   * subscription, and for a session that is already gone there is no publication
   * to hear — arming one is pure leftovers. Counted at the arming, because a
   * listener dropped on the way out is invisible to a "still live" count.
   */
  it('arms no subscription for a member it settles from the log', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    scene.agents.remove(alice.id)
    const armed = armedSubscriptions(scene)
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 2_000 })

    // Not one listener: no `agent/created` to wait for, no `agent/disposed` to
    // race — the member was already answered before the window opened. Asserted
    // first, because this is the claim that is specific to the precheck.
    expect(armed).toEqual([])
    expect(observed).toEqual({ done: ['Alice'], busy: [], cold: [], timedOut: false, reports: [{ member: 'Alice', text: 'Alice finished.' }] })
  })

  /**
   * The line the precheck must not cross, and the reason it reuses the DELIVERY
   * watermark instead of "does this member have a report at all".
   *
   * Round one answered and its spliced row is in the log; round two was delivered
   * after it and has not been woken yet. An unbounded precheck would read that
   * old row as this round's answer and report a cold member as done in one tick —
   * the exact over-claim the bounded rule exists to stop. With the watermark, the
   * row sits before `deliveredAt` and settles nothing, so the wait takes the
   * normal cold path: one publication subscription, and the full budget.
   */
  it('does not pre-settle a member whose only report predates its delivery', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    // Round one's answer, already spliced and consumed in the log...
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    scene.agents.remove(alice.id)
    // ...and round two's task, accepted after it, whose answer has not come.
    await scene.service.send(scene.leader.agent, 'Alice', 'one more thing', signal)
    const live = trackCreated(scene)

    const started = Date.now()
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 120 })
    await sleep(50)
    // Precheck missed: the cold observation is armed exactly as before.
    expect(live.size).toBe(1)

    expect(await waiting).toEqual({ done: [], busy: [], cold: ['Alice'], timedOut: true, reports: [] })
    // It really waited the budget out rather than answering early.
    expect(Date.now() - started).toBeGreaterThanOrEqual(120)
    expect(live.size).toBe(0)
  })

  /**
   * All three states in one window, which is where a precheck could go wrong: a
   * member whose round is over (no live agent, report in the log), one still
   * working (live and running), and one that never started (no live agent, no
   * report). Only the first may be settled without watching; the other two keep
   * their old rules, and every target lands in exactly one bucket.
   */
  it('settles the finished member and still watches the running and the silent one', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { childId: 'child-3' })
    // Alice answered and was reaped before the wait: her round is over.
    scene.leader.session.events.push(inboxSplicedEvent([settlementNotice(alice.id)]))
    scene.agents.remove(alice.id)
    // Bob is still working. Carol was never started and never reports.
    bob.status = 'running'
    scene.agents.remove(carol.id)
    carol.status = 'running'
    const armed = armedSubscriptions(scene)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 150 })

    // Exactly one publication subscription: Carol's. Alice was settled from the
    // log without watching, Bob was already resident. Two `agent/created` here
    // would mean the precheck left Alice on the cold path.
    expect(armed.filter(name => name === 'agent/created')).toEqual(['agent/created'])
    expect(observed).toEqual({ done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true, reports: [{ member: 'Alice', text: 'Alice finished.' }] })

    const flat = [...observed.done, ...observed.busy, ...observed.cold]
    // Disjoint: no name twice. Union: every target named exactly once.
    expect(new Set(flat).size).toBe(flat.length)
    expect([...flat].sort()).toEqual(['Alice', 'Bob', 'Carol'])
  })

  /**
   * The extension's reason to exist: a wait that answered only "Alice is done"
   * makes the leader ask again to learn what Alice said, which is one more round
   * trip for a fact the wait already held. The spliced row is the durable shape of
   * a report — what remains after a boundary consumed the queued notice — so this
   * is the read that had all the content and used none of it.
   */
  it('brings back the text a finished member reported, not only its name', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(inboxSplicedEvent([queuedReply(alice.id, 'Alice', 'OK')]))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.done).toEqual(['Alice'])
    expect(observed.reports).toEqual([{ member: 'Alice', text: 'OK' }])
  })

  /**
   * The same report, in the shape the runtime actually writes it: the settlement
   * notice is a template ("Background subagent … finished…", "Its closing
   * message:") wrapped around the member's text. Handing that back verbatim would
   * put the runtime's sentence in the member's mouth, which is worse than no
   * report at all — a leader quoting it believes the teammate said it.
   */
  it('strips the settlement template, leaving only what the member said', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.inbox.nextStep.push(settlementWithClosing(alice.id, ['shipped the parser fix']))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.reports).toEqual([{ member: 'Alice', text: 'shipped the parser fix' }])
  })

  /**
   * The regression lock for the host trace that found the defect.
   *
   * `reportTextOf()` stripped the template out of the notice's BODY and then fell
   * back to `source.summary` whenever nothing was left — but for a settlement
   * notice the summary IS the template (`settlementSummary()`), so a member whose
   * words had not arrived yet was handed back as
   * `Background subagent … finished and will do no further work unless you send
   * it more.` and counted in `done`. The host answered
   * `all finished: a, b` with that sentence as a's report while a had said
   * nothing at all. A wait that returns the runtime's own sentence as the
   * member's answer is worse than one that returns nothing: the leader believes
   * the teammate said it.
   *
   * No readable words must therefore mean what it means everywhere else in the
   * wait — finished, report not observed: `busy`, with no `done` entry and no
   * `reports` entry.
   */
  it('does not hand the settlement template back as a member’s report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    // Exactly what the runtime delivers for a child that ended before it wrote
    // anything: its template, then `It left no closing message.`
    scene.leader.inbox.nextStep.push(settlementWithClosing(alice.id, []))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 60 })

    expect(observed.done).toEqual([])
    expect(observed.busy).toEqual(['Alice'])
    expect(observed.cold).toEqual([])
    expect(observed.reports).toEqual([])
    // The acceptance criterion, stated as the thing that must never appear.
    for (const report of observed.reports) expect(report.text).not.toContain('Background subagent')
  })

  /**
   * The host trace that reported this, reproduced as one round: two members, one
   * that had handed its work back and one that had merely settled. The real host
   * answered `all finished: a, b` — b with `CLOSED-T5`, and a with
   * `Background subagent b4fa2d9d-… finished and will do no further work unless
   * you send it more.` as its report, while a had said nothing at all. The
   * acceptance criterion in the caller's own terms: one member in `done` with the
   * text it reported, the other in `busy`, and no template anywhere in `reports`.
   */
  it('separates the member that reported from the member that only settled', async () => {
    const scene = world()
    const a = await spawn(scene, 'a', { childId: 'b4fa2d9d-858f-452c-beb7-ad8c636e8380' })
    const b = await spawn(scene, 'b', { childId: 'child-b' })
    scene.leader.inbox.nextStep.push(
      settlementWithClosing(a.id, []),
      settlementWithClosing(b.id, ['CLOSED-T5']),
    )
    scene.agents.remove(a.id)
    scene.agents.remove(b.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 60 })

    expect(observed.done).toEqual(['b'])
    expect(observed.busy).toEqual(['a'])
    expect(observed.reports).toEqual([{ member: 'b', text: 'CLOSED-T5' }])
    for (const report of observed.reports) expect(report.text).not.toContain('Background subagent')
  })

  /**
   * The same rule for every arm of the template, not only the one the host trace
   * showed: `settlementSummary()` has an ending per `stopReason`, and five of the
   * six do not contain the `finished and will do no further work` sentence at
   * all. A detector keyed on that sentence alone — the quickest possible fix —
   * would let an aborted, truncated, refused or failed child through, in exactly
   * the moment a leader is most likely to be misled about what a member did.
   * The arms are built by {@link settlementSummaryOf}, from the producer's own
   * wording, so this case also fails if the runtime rewords its template.
   */
  it.each([
    { stopReason: 'completed', continuable: true },
    { stopReason: 'completed', continuable: false },
    { stopReason: 'aborted', continuable: true },
    { stopReason: 'max-tokens', continuable: true },
    { stopReason: 'refusal', continuable: true },
    { stopReason: 'error', continuable: true },
    { stopReason: 'an-unnameable-ending', continuable: true },
  ])('refuses the $stopReason template as a report', async ({ stopReason, continuable }) => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const template = settlementSummaryOf(alice.id, stopReason, continuable)
    scene.leader.inbox.nextStep.push(settlementWithClosing(alice.id, [], template))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 60 })

    expect(observed.reports).toEqual([])
    expect(observed.done).toEqual([])
    expect(observed.busy).toEqual(['Alice'])
  })

  /**
   * Why the detector cannot be the sentence, in one case: the notice's durable
   * `summary` is `boundContextSummary(summary)`, bounded to
   * `CONTEXT_SUMMARY_MAX_CHARS` (120) with an ellipsis
   * (`@deepseek-ai/dsh-llm/lib/types/message.js`). A child id long enough pushes
   * `finished and will do no further work` past that bound, so the stored summary
   * keeps the subject and loses the ending — while the message BODY still carries
   * the whole template. Keyed on the sentence, the detector would report a
   * half-template as a member's answer here; keyed on the subject, it cannot,
   * because every arm of `settlementSummary()` opens with it.
   */
  it('detects the template in a summary bounded short of its ending', async () => {
    const scene = world()
    // 90 characters, so the 120-char bound falls inside the finished sentence.
    const childId = `child-${'x'.repeat(84)}`
    const alice = await spawn(scene, 'Alice', { childId })
    const template = settlementSummaryOf(alice.id)
    const bounded = `${template.slice(0, 119)}\u2026`
    // The construction asserts its own premise: the surviving summary must have
    // lost the sentence, or this case would prove nothing about truncation.
    expect(bounded).not.toContain('finished and will do no further work')
    scene.leader.inbox.nextStep.push(createUserMessage({
      content: [
        { type: 'text', text: template },
        { type: 'text', text: 'It left no closing message.' },
      ],
      source: {
        kind: 'subagent-settled', form: 'notice', summary: bounded, senderSessionId: SessionId(alice.id),
      },
    }))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 60 })

    expect(observed.done).toEqual([])
    expect(observed.busy).toEqual(['Alice'])
    expect(observed.reports).toEqual([])
  })

  /**
   * The other side of the same read, so the fix cannot become "ignore the body
   * when a summary exists": a message that carries the member's words and no
   * one-line account at all still reports those words. `subagent-settled` cannot
   * be that message — its source type requires `form` and `summary` — so the
   * shape without a summary is the one a member writes itself, `team-message`,
   * and it must keep working untouched.
   */
  it('reports a member whose words arrive without any notice summary', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(inboxSplicedEvent([queuedReply(alice.id, 'Alice', 'CLOSED-T4')]))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })

    expect(observed.done).toEqual(['Alice'])
    expect(observed.reports).toEqual([{ member: 'Alice', text: 'CLOSED-T4' }])
  })

  /**
   * And the precedence, in the one shape that can be both: a notice that carries
   * a real account AND the member's own words reports the words. A fix written
   * as "prefer the summary unless it is the template" would answer `Alice
   * finished.` here — an account of the member standing in for what it said.
   */
  it('prefers a member’s own words over the account of them', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.inbox.nextStep.push(settlementWithClosing(alice.id, ['CLOSED-T4'], 'Alice finished.'))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })

    expect(observed.reports).toEqual([{ member: 'Alice', text: 'CLOSED-T4' }])
  })

  /**
   * A tool result becomes model-visible input on every later step, so an
   * unbounded report is a context window one verbose member can spend alone. The
   * bound is the contract: exactly `WAIT_REPORT_MAX_CHARS`, head kept, cut marked
   * with `…` so the reader knows there is more rather than believing it ended.
   */
  it('bounds a long report and marks the cut instead of flooding the caller', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    const long = 'a'.repeat(WAIT_REPORT_MAX_CHARS + 500)
    scene.leader.session.events.push(inboxSplicedEvent([queuedReply(alice.id, 'Alice', long)]))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    const [report] = observed.reports
    expect(report?.text).toHaveLength(WAIT_REPORT_MAX_CHARS)
    expect(report?.text.endsWith('\u2026')).toBe(true)
    // The head is preserved byte for byte: a truncation that reshaped it would be
    // a different report, not a shorter one.
    expect(report?.text.slice(0, -1)).toBe(long.slice(0, WAIT_REPORT_MAX_CHARS - 1))
  })

  /**
   * `reports` is about what came back, so a member that never came back cannot be
   * in it: Bob is still running and Carol never said a word. A report for either
   * would be the wait inventing content, which is the failure mode the whole
   * `cold`/`busy` split exists to prevent.
   */
  it('names only the members that reported, never a busy or cold one', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { childId: 'child-3' })
    scene.leader.session.events.push(inboxSplicedEvent([queuedReply(alice.id, 'Alice', 'reviewed: no findings')]))
    scene.agents.remove(alice.id)
    bob.status = 'running'
    scene.agents.remove(carol.id)
    carol.status = 'running'

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 60 })
    expect(observed.done).toEqual(['Alice'])
    expect(observed.busy).toEqual(['Bob'])
    expect(observed.cold).toEqual(['Carol'])
    expect(observed.reports).toEqual([{ member: 'Alice', text: 'reviewed: no findings' }])
  })

  /**
   * The other end of the same statement, restated as the new rule requires: a
   * member that finishes without leaving anything readable is NOT done, because a
   * `done` entry the caller cannot act on is the defect. It is also not `cold` —
   * its turn demonstrably ended — so it lands in `busy`: finished, words never
   * observed. Inventing a report to keep the lists the same length would be
   * worse; leaving it in `done` is what this change removed.
   */
  it('does not call a finished but silent member done, and leaves reports empty', async () => {
    const scene = world()
    await spawn(scene, 'Alice')

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.done).toEqual([])
    expect(observed.reports).toEqual([])
    expect(observed.busy).toEqual(['Alice'])
    expect(observed.timedOut).toBe(true)
  })

  /**
   * The queue is the FAST half of the report evidence and the only half that has
   * anything to read while the notice is unconsumed. Reading the bucket from it
   * and the text from somewhere else would let one answer describe two moments.
   */
  it('reads the report out of the live inbox while it is still queued', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.inbox.nextStep.push(queuedReply(alice.id, 'Alice', 'the diff is clean'))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.done).toEqual(['Alice'])
    expect(observed.reports).toEqual([{ member: 'Alice', text: 'the diff is clean' }])
  })

  /**
   * A report is text, and a tool result cannot carry an image: the block is
   * dropped, but the drop is disclosed inside the report so the leader knows
   * something was attached instead of reading a report that looks complete.
   */
  it('discloses a dropped non-text block instead of losing it silently', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    scene.leader.session.events.push(inboxSplicedEvent([createUserMessage({
      content: [
        { type: 'text', text: 'screenshot attached' },
        { type: 'image', attachment: { id: 'img-1' } } as never,
      ],
      source: {
        kind: 'team-message', form: 'relay', senderSessionId: alice.id, senderName: 'Alice', chainId: 'c1', hop: 0,
      },
    })]))
    scene.agents.remove(alice.id)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 40 })
    expect(observed.reports).toEqual([{
      member: 'Alice',
      text: 'screenshot attached\n[+1 non-text block omitted]',
    }])
  })

  /**
   * The regression lock for the reported defect, and the sentence the whole
   * change is about: **a wait waits for the REPORT, not for quiescence**.
   *
   * The host trace answered `all finished: a, b, c` while `reports` held only a
   * and b. `done` was decided by the idle signal and `reports` was collected
   * afterwards from a second, later read, so a member whose turn had ended but
   * whose words were not readable yet was confirmed finished with nothing to
   * hand back — a completion the caller cannot use.
   *
   * The harness leaves that window open by construction: in the subagent
   * manager's teardown `agent/disposed` (which settles `whenIdle()`) runs
   * BEFORE `notifySettlement()` queues the notice
   * (`@deepseek-ai/dsh-subagent/lib/types/manager.js`), so the very moment a
   * member settles there may be no report in the inbox, the log, or the mailbox.
   *
   * Under the new rule that state is NOT done: the member is still awaited, and
   * a budget that runs out first lands it in `busy` — finished, report never
   * observed — never in `done` and never in `cold` (it did finish).
   */
  it('does not count a settled member as done before its report is readable', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    // The turn ends inside the window; nothing readable ever follows.
    setTimeout(() => { alice.goIdle() }, 10)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 80 })

    expect(observed.done).toEqual([])
    expect(observed.reports).toEqual([])
    // Finished, so not cold; unreadable, so not done.
    expect(observed.busy).toEqual(['Alice'])
    expect(observed.cold).toEqual([])
    expect(observed.timedOut).toBe(true)
  })

  /**
   * The other half of the same rule: when the report does arrive, the wait
   * returns AT THAT MOMENT — it is a wait for the content, not a fixed grace
   * period that expires into a guess. The report lands on the leader's log
   * through the runtime's own splice, announced on `session/event`.
   */
  it('returns the moment a delayed report becomes readable', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    setTimeout(() => { alice.goIdle() }, 10)
    // Its closing words reach the leader a moment after its turn ended.
    setTimeout(() => { spliceReport(scene, settlementNotice(alice.id, 'c is ready')) }, 60)

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
    const elapsed = Date.now() - started

    expect(observed).toEqual({
      done: ['Alice'], busy: [], cold: [], timedOut: false,
      reports: [{ member: 'Alice', text: 'c is ready' }],
    })
    // It did not answer at its own settle (10 ms) and did not sit out the budget:
    // it answered when the report existed.
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(1_000)
  })

  /**
   * The acceptance criterion in one scene: an immediately readable report, a
   * delayed one, and a member that finished and never handed anything back. The
   * assertion is not three separate lists but the correspondence itself —
   * `done` and `reports` name the same members, in the same order — because the
   * defect was exactly a `done` entry with no report behind it.
   */
  it('keeps done and reports one-to-one across an immediate, a delayed and a silent member', async () => {
    const scene = world({ config: { ...CONFIG, maxTeammates: 3 } })
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    const carol = await spawn(scene, 'Carol', { childId: 'child-3' })
    alice.status = 'running'
    bob.status = 'running'
    carol.status = 'running'
    // Alice's report is already readable when the wait looks.
    scene.leader.inbox.nextStep.push(settlementNotice(alice.id, 'alice is back'))
    setTimeout(() => { alice.goIdle() }, 5)
    // Bob's report arrives inside the window, after his turn ended.
    setTimeout(() => {
      bob.goIdle()
      spliceReport(scene, settlementNotice(bob.id, 'bob is back'))
    }, 40)
    // Carol finishes and leaves no words anywhere.
    setTimeout(() => { carol.goIdle() }, 20)

    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 200 })

    expect(observed.done).toEqual(['Alice', 'Bob'])
    expect(observed.busy).toEqual(['Carol'])
    expect(observed.cold).toEqual([])
    // The contract: one report per done member, same members, same order.
    expect(observed.reports.map(report => report.member)).toEqual([...observed.done])
    expect(new Set(observed.done)).toEqual(new Set(observed.reports.map(report => report.member)))
  })

  /**
   * The performance property the new condition must not spend: a round whose
   * reports are all readable already answers at once. The idle signal and the
   * report are both there on the first read, so nothing new is armed and no
   * retry window is spent — the answer is tens of milliseconds, not the budget.
   */
  it('answers at once when every member already has a readable report', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    const bob = await spawn(scene, 'Bob', { childId: 'child-2' })
    scene.leader.inbox.nextStep.push(
      settlementNotice(alice.id, 'a is back'),
      settlementNotice(bob.id, 'b is back'),
    )

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 30_000 })
    const elapsed = Date.now() - started

    expect(observed.timedOut).toBe(false)
    expect(observed.done).toEqual(['Alice', 'Bob'])
    expect(observed.reports).toEqual([
      { member: 'Alice', text: 'a is back' },
      { member: 'Bob', text: 'b is back' },
    ])
    // Far below the 30 s budget — and below the 1 s a regression would need.
    expect(elapsed).toBeLessThan(500)
  })

  /**
   * The deadline half of the rule, stated as its own case: content that never
   * becomes readable by the end of the budget is a `busy` member with
   * `timedOut: true`, and the wait really does wait for it instead of answering
   * as soon as the turn ends.
   */
  it('reports a finished-but-unreadable member as busy when the budget expires', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    setTimeout(() => { alice.goIdle() }, 5)

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 120 })
    const elapsed = Date.now() - started

    expect(observed.done).toEqual([])
    expect(observed.busy).toEqual(['Alice'])
    expect(observed.reports).toEqual([])
    expect(observed.timedOut).toBe(true)
    // It waited the budget out rather than answering at the settle.
    expect(elapsed).toBeGreaterThanOrEqual(120)
  })
})
