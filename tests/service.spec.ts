/**
 * The team service: roster lifecycle, the relation-based delivery matrix, the
 * shared task list, and hydration from a leader's own log.
 *
 * @module dsh-team/tests/service
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { TeamError } from '../src/errors.ts'
import { TeamService } from '../src/service.ts'
import type { TeamConfig } from '../src/config.ts'
import {
  FakeAgents, FakeLlm, FakeSubagents, fakeAgent, toolResultEvent, type FakeAgent,
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

  it('returns at once with every member done when nobody is running', async () => {
    const scene = world()
    await spawn(scene, 'Alice', { childId: 'child-1' })
    await spawn(scene, 'Bob', { childId: 'child-2' })

    expect(await scene.service.wait(scene.leader.agent))
      .toEqual({ done: ['Alice', 'Bob'], busy: [], timedOut: false })
  })

  it('blocks while a member runs, and returns as soon as it is idle', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'

    const resolved: boolean[] = []
    const waiting = scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 })
      .then((value) => { resolved.push(true); return value })
    // Past the settle window, so the wait is now holding a live `whenIdle()`.
    await sleep(80)
    expect(resolved).toEqual([])

    alice.goIdle()
    expect(await waiting).toEqual({ done: ['Alice'], busy: [], timedOut: false })
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

    alice.goIdle()
    expect(await waiting).toEqual({ done: ['Alice'], busy: [], timedOut: false })
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

    alice.goIdle()
    expect(await waiting).toEqual({ done: ['Alice'], busy: [], timedOut: false })
  })

  it('reports the members still running when the budget expires, without hanging', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice', { childId: 'child-1' })
    await spawn(scene, 'Bob', { childId: 'child-2' })
    alice.status = 'running'

    const started = Date.now()
    const observed = await scene.service.wait(scene.leader.agent, { timeoutMs: 20 })
    expect(observed).toEqual({ done: ['Bob'], busy: ['Alice'], timedOut: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('counts a member the registry no longer holds as done, without observing it', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    scene.agents.remove(alice.id)

    expect(await scene.service.wait(scene.leader.agent, { timeoutMs: 5_000 }))
      .toEqual({ done: ['Alice'], busy: [], timedOut: false })
    expect(alice.idleCalls).toBe(0)
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
      .toEqual({ done: [], busy: [], timedOut: false })

    const alice = await spawn(scene, 'Alice')
    alice.status = 'running'
    expect(await scene.service.wait(scene.leader.agent, { members: [], timeoutMs: 60_000 }))
      .toEqual({ done: [], busy: [], timedOut: false })
    expect(alice.idleCalls).toBe(0)
  })

  it('names each member once, however it was addressed', async () => {
    const scene = world()
    const alice = await spawn(scene, 'Alice')

    expect(await scene.service.wait(scene.leader.agent, { members: ['Alice', 'alice', alice.id] }))
      .toEqual({ done: ['Alice'], busy: [], timedOut: false })
  })
})
