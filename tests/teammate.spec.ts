/**
 * The teammate world: what one continuable child gains when — and only when —
 * it belongs to a team.
 *
 * @module dsh-team/tests/teammate
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemberDossiers, type MemberRecord } from '../src/dossier.ts'
import { TeamService } from '../src/service.ts'
import { installTeammateDossier, installTeammateWorld } from '../src/teammate.ts'
import type { TeamConfig } from '../src/config.ts'
import { FakeAgents, FakeSubagents, FakeSystemPrompt, FakeTools, fakeAgent, type FakeAgent } from './harness.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 8, maxRecentMessages: 20, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 8, maxNoteChars: 400, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}
const signal = new AbortController().signal

/** The world one continuable child is composed in. */
interface Child {
  readonly ctx: Context
  readonly tools: FakeTools
  readonly prompt: FakeSystemPrompt
  readonly agent: FakeAgent
  readonly release: () => void
}

let ctx: Context
let agents: FakeAgents
let subagents: FakeSubagents
let service: TeamService
let leader: FakeAgent
let removeWorld: () => void

beforeEach(() => {
  ctx = new Context()
  agents = new FakeAgents(ctx)
  subagents = new FakeSubagents()
  subagents.publishChild = (childId, parentId, options) => {
    agents.add(fakeAgent(String(childId), {
      parent: String(parentId),
      // The host composition mounts the subagent-control row, so a child here
      // inherits `send_message` exactly like a real teammate does.
      globals: ['send_message'],
      ...typeof options?.model === 'string' ? { model: options.model } : {},
      ...typeof options?.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {},
    }))
  }
  ctx.provide('agents', agents)
  ctx.provide('subagents', subagents)
  service = new TeamService(ctx, CONFIG)
  leader = agents.add(fakeAgent('leader-1'))
  removeWorld = installTeammateWorld(ctx)
})

/** Read the child scope composed by the agent lifecycle listener. */
function compose(agent: FakeAgent): Child {
  return {
    ctx: agent.ctx,
    tools: agent.tools,
    prompt: agent.prompt,
    agent,
    release: () => agents.remove(agent.id),
  }
}

/** Spawn one teammate and publish its live agent double. */
async function spawn(name: string, options: {
  readonly relation?: 'managed' | 'peer'
  readonly effort?: string
} = {}): Promise<FakeAgent> {
  subagents.nextChildId = `child-${subagents.started.length + 1}`
  const member = await service.spawn(leader.agent, {
    name,
    task: `do ${name}'s work`,
    relation: options.relation ?? 'managed',
    ...options.effort !== undefined ? { reasoningEffort: options.effort } : {},
  }, signal)
  const child = agents.getFake(member.memberId)
  if (child === undefined) throw new Error(`published child ${member.memberId} is missing`)
  return child
}

describe('composition', () => {
  it('composes published children and removes their world on disposal', () => {
    removeWorld()
    const child = fakeAgent('child-1', { parent: leader.id })
    agents.add(child)
    expect(child.tools.registered).toEqual([])
  })

  it('gives an ordinary subagent nothing at all', () => {
    const stranger = compose(agents.add(fakeAgent('other-child', { parent: 'unrelated-leader' })))
    expect(stranger.tools.registered).toEqual([])
    expect(stranger.prompt.sections).toEqual([])
    stranger.release()
  })

  it('equips a teammate with the mailbox, the team read, and its briefing', async () => {
    const child = compose(await spawn('Alice', { relation: 'peer' }))
    expect(child.tools.registered.map(tool => tool.name)).toEqual(['team_send', 'team_list', 'team_task_close'])
    expect(child.prompt.sections).toHaveLength(1)
    expect(child.prompt.sections[0]).toMatchObject({ name: 'team-membership', order: 118 })
  })

  it('gives a teammate a close, never the leader\'s task writer', async () => {
    const child = compose(await spawn('Alice'))
    const names = child.tools.registered.map(tool => tool.name)
    // `team_task` would hand a member row creation, renaming and reassignment:
    // the leader's shape of the list stays leader-only.
    expect(names).not.toContain('team_task')
    expect(names).toContain('team_task_close')
  })

  it('pins the close schema to the two fields a close needs, so the other three are unreachable', async () => {
    const child = compose(await spawn('Alice'))
    const close = child.tools.registered.find(tool => tool.name === 'team_task_close')
    const parameters = (close?.definition as {
      parameters?: { properties?: Record<string, unknown> }
    }).parameters
    // The schema IS the permission here: no `title`, no `assignee`, no `status`,
    // no creation path. A member cannot rename a row, move it to a peer, or
    // invent one, because there is no argument to put those in.
    expect(Object.keys(parameters?.properties ?? {}).sort()).toEqual(['note', 'task_id'])
  })

  it('unwinds every registration with the child', async () => {
    const child = compose(await spawn('Alice'))
    child.release()
    expect(child.tools.registered).toEqual([])
    expect(child.prompt.sections).toEqual([])
  })

  it('hides the parent-addressed send_message so one report is not delivered twice', async () => {
    const child = compose(await spawn('Alice'))
    // The duplicate delivery: `send_message` reaches the same parent as
    // `team_send`, so a member that reports through both puts the same report
    // in the leader's mailbox twice. The control tool is restricted away.
    expect(child.tools.restrictions).toEqual([{ deny: ['send_message'] }])
    expect(child.tools.get('send_message')).toBeUndefined()
  })

  it('keeps the team mailbox through the same restriction', async () => {
    const child = compose(await spawn('Alice'))
    // `restrict()` filters what a scope INHERITS; team_send is registered into
    // this child's own layer, so the mailbox survives by construction.
    expect(child.tools.get('team_send')).toBeDefined()
    expect(child.tools.registered.map(tool => tool.name)).toEqual(['team_send', 'team_list', 'team_task_close'])
  })

  it('composes a teammate where no send_message exists to hide', async () => {
    // A composition without the subagent-control row: nothing to hide, and
    // restrict() rejects names the scope cannot see — probed, never assumed.
    subagents.publishChild = (childId, parentId) => {
      agents.add(fakeAgent(String(childId), { parent: String(parentId) }))
    }
    const child = compose(await spawn('Alice'))
    expect(child.tools.restrictions).toEqual([])
    expect(child.tools.registered.map(tool => tool.name)).toEqual(['team_send', 'team_list', 'team_task_close'])
  })

  it('lifts the hide with the child scope', async () => {
    const child = compose(await spawn('Alice'))
    child.release()
    expect(child.tools.restrictions).toEqual([])
  })
})

describe('briefing', () => {
  it('states the identity, the reach a relation grants, and the rest of the team', async () => {
    const alice = await spawn('Alice', { relation: 'peer' })
    await spawn('Bob')
    const child = compose(alice)
    const text = child.prompt.sections[0]!.text()

    expect(text).toContain('You are Alice')
    expect(text).toContain('peer member')
    expect(text).toContain('Bob (managed)')
    expect(text).not.toContain('Alice (')
  })

  it('tells a managed teammate that its only correspondent is the leader', async () => {
    const child = compose(await spawn('Bob'))
    expect(child.prompt.sections[0]!.text()).toContain('managed member')
  })

  it('re-renders live, so a later teammate and a new task are visible next step', async () => {
    const alice = await spawn('Alice', { relation: 'peer' })
    const child = compose(alice)
    expect(child.prompt.sections[0]!.text()).toContain('only teammate')

    await spawn('Bob')
    service.upsertTask(leader.agent, { title: 'review the diff', assigneeId: 'Alice' })
    const text = child.prompt.sections[0]!.text()
    expect(text).toContain('Bob (managed)')
    expect(text).toContain('t1 "review the diff"')
  })

  it('tells a dismissed teammate its team is gone instead of failing to render', async () => {
    const alice = await spawn('Alice')
    const child = compose(alice)
    service.dismiss(leader.agent, 'Alice')
    expect(child.prompt.sections[0]!.text()).toContain('no longer active')
  })

  it('tells a teammate whose leader unloaded that the team is intact, and where to park the work', async () => {
    const alice = await spawn('Alice')
    const child = compose(alice)
    agents.remove(leader.id)
    const text = child.prompt.sections[0]!.text()
    expect(text).toContain('team is intact')
    expect(text).toContain('team_note')
    expect(text).not.toContain('no longer active')
  })
})

/** The dossier table double, same shape as the workspace spec's. */
class FakeDossierTable {
  readonly rows = new Map<string, MemberRecord>()

  get(key: string): MemberRecord | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, MemberRecord]> {
    return [...this.rows.entries()][Symbol.iterator]()
  }

  async put(key: string, value: MemberRecord): Promise<void> {
    this.rows.set(key, value)
    await Promise.resolve()
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve()
    return this.rows.delete(key)
  }
}

describe('dossier world', () => {
  let dossiers: MemberDossiers
  let removeDossier: () => void

  beforeEach(() => {
    const table = new FakeDossierTable()
    const domain = {
      name: 'team_dossier',
      table: () => table,
      close: () => Promise.resolve(),
    }
    const storeCtx = { storageDomain: { open: () => Promise.resolve(domain) } } as unknown as Context
    dossiers = new MemberDossiers(storeCtx, CONFIG)
    // The world listener is already installed by the outer setup; this one
    // composes the dossier contribution on top, in registration order.
    removeDossier = installTeammateDossier(ctx, dossiers)
  })

  /** The `team-dossier` section of one composed child, whatever else it carries. */
  function dossierSection(child: Child) {
    return child.prompt.sections.find(section => section.name === 'team-dossier')
  }

  it('equips a teammate with the digest of its name and the member-side tools', async () => {
    await dossiers.learn('Alice', { kind: 'lesson', text: 'run the suite before reporting', evidence: 'watched a red suite' })
    const child = compose(await spawn('Alice'))
    expect(child.tools.registered.map(tool => tool.name)).toEqual(['team_send', 'team_list', 'team_task_close', 'team_learn', 'team_profile'])
    const section = dossierSection(child)
    expect(section).toMatchObject({ order: 121 })
    const text = section!.text()
    expect(text).toContain('[lesson e1] run the suite before reporting')
    expect(text).toContain('suggestions, not commands')
    expect(text).toContain('team_learn')
    expect(text).toContain('evidence is required')
  })

  it('never hands a teammate the leader-side dossier tools', async () => {
    const child = compose(await spawn('Alice'))
    const names = child.tools.registered.map(tool => tool.name)
    expect(names).not.toContain('team_review')
    expect(names).not.toContain('team_forget')
  })

  it('re-renders the digest, so a lesson learned this turn is in front of the member next step', async () => {
    const child = compose(await spawn('Alice'))
    expect(dossierSection(child)!.text()).not.toContain('[lesson')
    await dossiers.learn('Alice', { kind: 'fact', text: 'the build needs node 22', evidence: 'build log' })
    expect(dossierSection(child)!.text()).toContain('[fact e1] the build needs node 22')
  })

  it('teaches the habit even to a name with no record yet', async () => {
    const child = compose(await spawn('Alice'))
    const text = dossierSection(child)!.text()
    expect(text).toContain('team_learn')
    expect(text).not.toContain('Dossier for')
  })

  it('gives the member profile no member parameter: another name is unreadable from here', async () => {
    const child = compose(await spawn('Alice'))
    const profile = child.tools.registered.find(tool => tool.name === 'team_profile')
    const parameters = (profile?.definition as { parameters?: { properties?: Record<string, unknown> } }).parameters
    expect(parameters?.properties).toEqual({})
  })

  it('unwinds every dossier registration with the child', async () => {
    const child = compose(await spawn('Alice'))
    expect(dossierSection(child)).toBeDefined()
    child.release()
    expect(child.prompt.sections).toEqual([])
    expect(child.tools.registered).toEqual([])
  })

  it('takes the dossier world off when the contribution is disposed', async () => {
    removeDossier()
    const child = compose(await spawn('Alice'))
    expect(child.tools.registered.map(tool => tool.name)).toEqual(['team_send', 'team_list', 'team_task_close'])
    expect(child.prompt.sections.map(section => section.name)).toEqual(['team-membership'])
  })
})
