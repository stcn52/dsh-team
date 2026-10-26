/**
 * The `/api/team/*` channel: the wire shapes the panel depends on, the
 * operation dispatch that turns one mutation endpoint into three service calls,
 * and the refusals that are about the SESSION rather than the operation.
 *
 * The routes are driven as they are registered — `(request: Request) =>
 * Response` — so a failure names the handler, not an HTTP carrier.
 *
 * @module dsh-team/routes.test
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import {
  MUTATION_PATH, ROSTER_PATH, adminRoutes, registerAdminRoutes,
  type AdminDeps, type AdminFetchRoute, type AdminTeam, type ConnectionSeat,
} from './routes.ts'
import type { TeamMemberView, TeamRelation } from './contract.ts'
import { TeamError } from './errors.ts'
import type { TeamMemberFact } from './fold.ts'
import type { TeamSpawnRequest } from './service.ts'

const ORIGIN = 'http://dsh.internal'

/** One member fact the stub answers with. */
function fact(overrides: Partial<TeamMemberFact> = {}): TeamMemberFact {
  return { memberId: 'child-1', name: 'Alice', relation: 'managed', ...overrides }
}

/** One roster row exactly as the contract shapes it; every optional field is present. */
function view(overrides: Partial<TeamMemberView> = {}): TeamMemberView {
  return {
    memberId: 'child-1',
    name: 'Alice',
    relation: 'peer',
    role: 'reviewer',
    provider: 'qwen-local',
    model: 'qwen3',
    effort: 'high',
    skills: ['deep-brief'],
    joinedAt: 7,
    ...overrides,
  }
}

/** One spawn as the route handed it to the service. */
interface SpawnCall {
  readonly leader: Agent
  readonly request: TeamSpawnRequest
  readonly signal: AbortSignal
}

/** One relation change as the route handed it to the service. */
interface RelationCall {
  readonly leader: Agent
  readonly target: string
  readonly relation: TeamRelation
}

/**
 * The `ctx.team` double: records every call and answers from a scripted field.
 * It implements {@link AdminTeam} structurally, so an interface change fails
 * this file's typecheck before it can reach a running panel.
 */
class FakeTeam implements AdminTeam {
  readonly spawns: SpawnCall[] = []
  readonly dismissals: { readonly leader: Agent; readonly target?: string }[] = []
  readonly relations: RelationCall[] = []
  /** The roster `list` reports; the route projects it and never computes it. */
  active = true
  roster: readonly TeamMemberView[] = []
  /** Scripted answers: the value the service returns, or the error it throws. */
  spawnAnswer: TeamMemberFact | Error = fact()
  dismissAnswer: { readonly ended: boolean; readonly memberId?: string } | Error =
    { ended: false, memberId: 'child-1' }
  relationAnswer: TeamMemberFact | Error = fact({ relation: 'peer' })

  list(_leader: Agent): { readonly active: boolean; readonly members: readonly TeamMemberView[] } {
    return { active: this.active, members: this.roster }
  }

  async spawn(leader: Agent, request: TeamSpawnRequest, signal: AbortSignal): Promise<TeamMemberFact> {
    this.spawns.push({ leader, request, signal })
    if (this.spawnAnswer instanceof Error) throw this.spawnAnswer
    return this.spawnAnswer
  }

  dismiss(leader: Agent, target?: string): { readonly ended: boolean; readonly memberId?: string } {
    this.dismissals.push({ leader, ...target !== undefined ? { target } : {} })
    if (this.dismissAnswer instanceof Error) throw this.dismissAnswer
    return this.dismissAnswer
  }

  setRelation(leader: Agent, target: string, relation: TeamRelation): TeamMemberFact {
    this.relations.push({ leader, target, relation })
    if (this.relationAnswer instanceof Error) throw this.relationAnswer
    return this.relationAnswer
  }
}

/** A published leader/teammate double: only identity and origin are ever read. */
function agent(sessionId: string, origin: 'user' | 'subagent'): Agent {
  return { id: sessionId, session: { header: { origin } } } as unknown as Agent
}

/** The deps one request sees: a fixed session table and the stub service. */
function fixture(sessions: Readonly<Record<string, Agent>> = { 'lead-1': agent('lead-1', 'user') }): {
  readonly team: FakeTeam
  readonly deps: AdminDeps
  readonly roster: AdminFetchRoute
  readonly mutation: AdminFetchRoute
} {
  const team = new FakeTeam()
  const deps: AdminDeps = { agentOf: sessionId => sessions[sessionId], team }
  const routes = adminRoutes(deps)
  return {
    team,
    deps,
    roster: routeFor(routes, ROSTER_PATH),
    mutation: routeFor(routes, MUTATION_PATH),
  }
}

/** The one route at a path; both are exact paths, so a miss is a test bug. */
function routeFor(routes: readonly AdminFetchRoute[], path: string): AdminFetchRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route at ${path}`)
  return route
}

/** A GET with an optional query string. */
function read(query: string): Request {
  return new Request(`${ORIGIN}${ROSTER_PATH}${query}`)
}

/** A POST of one JSON mutation body. */
function mutate(body: unknown, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${MUTATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

/** The parsed JSON body of one answer. */
async function bodyOf(response: Response): Promise<unknown> {
  return await response.json()
}

describe('contributions', () => {
  it('declares two exact routes below /api, GET and POST, both buffered', () => {
    const routes = adminRoutes(fixture().deps)
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
      [ROSTER_PATH, ['GET'], 'buffered'],
      [MUTATION_PATH, ['POST'], 'buffered'],
    ])
    // The registry refuses any path the shared channel cannot address.
    for (const route of routes) expect(route.path.startsWith('/api/')).toBe(true)
  })
})

describe('GET /api/team/roster', () => {
  it('answers 400 without a session', async () => {
    const { roster } = fixture()
    const response = await roster.fetch(read(''))
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toEqual({ error: 'session query parameter is required' })
  })

  it('answers 409 while the session is not resident', async () => {
    const { roster } = fixture()
    const response = await roster.fetch(read('?session=ghost'))
    expect(response.status).toBe(409)
    expect(await bodyOf(response)).toEqual({ error: 'session ghost is not resident here' })
  })

  it('answers 404 for a teammate session', async () => {
    const { roster } = fixture({ 'child-1': agent('child-1', 'subagent') })
    const response = await roster.fetch(read('?session=child-1'))
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).toEqual({ error: 'child-1 is a teammate session, not a team leader' })
  })

  it('reports the roster as contract rows, dropping the live status the service adds', async () => {
    const { team, roster } = fixture()
    const withStatus = { ...view(), status: 'idle' }
    team.roster = [withStatus]
    const response = await roster.fetch(read('?session=lead-1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await bodyOf(response)).toEqual({ active: true, members: [view()] })
  })

  it('reports an inactive team without inventing members', async () => {
    const { team, roster } = fixture()
    team.active = false
    const response = await roster.fetch(read('?session=lead-1'))
    expect(await bodyOf(response)).toEqual({ active: false, members: [] })
  })
})

describe('POST /api/team/mutation', () => {
  it('spawn maps every body field onto the service request', async () => {
    const { team, mutation } = fixture()
    team.spawnAnswer = fact({
      role: 'reviewer',
      relation: 'peer',
      provider: 'qwen-local',
      model: 'qwen3',
      effort: 'high',
      skills: ['deep-brief'],
    })
    const response = await mutation.fetch(mutate({
      session: 'lead-1',
      op: 'spawn',
      name: ' Alice ',
      task: 'Review the patch',
      relation: 'peer',
      role: 'reviewer',
      persona: 'terse',
      provider: 'qwen-local',
      model: 'qwen3',
      reasoningEffort: 'high',
      skills: ['deep-brief'],
    }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({
      member: {
        memberId: 'child-1',
        name: 'Alice',
        role: 'reviewer',
        relation: 'peer',
        provider: 'qwen-local',
        model: 'qwen3',
        effort: 'high',
        skills: ['deep-brief'],
      },
    })
    const call = team.spawns[0]
    expect(call?.request).toEqual({
      name: 'Alice',
      task: 'Review the patch',
      relation: 'peer',
      role: 'reviewer',
      persona: 'terse',
      provider: 'qwen-local',
      model: 'qwen3',
      reasoningEffort: 'high',
      skills: ['deep-brief'],
    })
    expect(call?.leader.id).toBe('lead-1')
  })

  it('spawn carries only the fields the body named', async () => {
    const { team, mutation } = fixture()
    await mutation.fetch(mutate({ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'Count the tests', relation: 'managed' }))
    expect(team.spawns[0]?.request).toEqual({ name: 'Bob', task: 'Count the tests', relation: 'managed' })
  })

  it('spawn hands the request signal to the service, so a hang-up cancels it', async () => {
    const { team, mutation } = fixture()
    const hangup = new AbortController()
    await mutation.fetch(mutate(
      { session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed' },
      { signal: hangup.signal },
    ))
    const signal = team.spawns[0]?.signal
    expect(signal?.aborted).toBe(false)
    hangup.abort()
    expect(signal?.aborted).toBe(true)
  })

  it('spawn answers 400 for each missing or malformed field, before calling the service', async () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ session: 'lead-1', op: 'spawn', task: 'go', relation: 'managed' }, 'name is required'],
      [{ session: 'lead-1', op: 'spawn', name: 'Bob', relation: 'managed' }, 'task is required'],
      [{ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'boss' }, 'relation must be "managed" or "peer"'],
      [{ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed', skills: [''] }, 'skills must be an array of non-empty skill names'],
      [{ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed', provider: 7 }, 'provider must be a string'],
    ]
    for (const [payload, error] of cases) {
      const { team, mutation } = fixture()
      const response = await mutation.fetch(mutate(payload))
      expect(response.status).toBe(400)
      expect(await bodyOf(response)).toEqual({ error })
      expect(team.spawns).toHaveLength(0)
    }
  })

  it('spawn answers 502 with the TeamError code beside the sentence', async () => {
    const { team, mutation } = fixture()
    team.spawnAnswer = new TeamError('MAX_TEAMMATES', '2')
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed' }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({
      error: 'the team is full — dismiss a teammate before spawning another: 2',
      code: 'MAX_TEAMMATES',
    })
  })

  it('spawn answers 502 with the unregistered-provider sentence', async () => {
    const { team, mutation } = fixture()
    team.spawnAnswer = new TeamError('UNKNOWN_PROVIDER', 'qwen-local; registered: deepseek')
    const response = await mutation.fetch(mutate({
      session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed',
      provider: 'qwen-local', model: 'qwen3',
    }))
    expect(response.status).toBe(502)
    const body = await bodyOf(response) as { error: string; code: string }
    expect(body.code).toBe('UNKNOWN_PROVIDER')
    expect(body.error).toContain('no LLM provider with that id is registered here')
    expect(body.error).toContain('registered: deepseek')
  })

  it('spawn answers 502 without a code for a failure that is not a TeamError', async () => {
    const { team, mutation } = fixture()
    team.spawnAnswer = new Error('provider adapter exploded')
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed' }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({ error: 'provider adapter exploded' })
  })

  it('dismiss answers the outcome and names the member', async () => {
    const { team, mutation } = fixture()
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'dismiss', memberId: 'child-1' }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ ended: false, memberId: 'child-1' })
    expect(team.dismissals[0]?.target).toBe('child-1')
  })

  it('dismiss requires a member: the contract names one, so no disband-by-omission', async () => {
    const { team, mutation } = fixture()
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'dismiss' }))
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toEqual({ error: 'memberId is required' })
    expect(team.dismissals).toHaveLength(0)
  })

  it('dismiss answers 404 when the member is not on the roster', async () => {
    const { team, mutation } = fixture()
    team.dismissAnswer = new TeamError('UNKNOWN_MEMBER', 'ghost')
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'dismiss', memberId: 'ghost' }))
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).toMatchObject({ code: 'UNKNOWN_MEMBER' })
  })

  it('setRelation answers the whole member', async () => {
    const { team, mutation } = fixture()
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'setRelation', memberId: 'child-1', relation: 'peer' }))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ member: { memberId: 'child-1', name: 'Alice', relation: 'peer' } })
    expect(team.relations[0]).toMatchObject({ target: 'child-1', relation: 'peer' })
  })

  it('setRelation answers 400 for a relation the service does not know', async () => {
    const { team, mutation } = fixture()
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'setRelation', memberId: 'child-1', relation: 'owner' }))
    expect(response.status).toBe(400)
    expect(team.relations).toHaveLength(0)
  })

  it('setRelation answers 404 when the member is not on the roster', async () => {
    const { team, mutation } = fixture()
    team.relationAnswer = new TeamError('UNKNOWN_MEMBER', 'ghost')
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'setRelation', memberId: 'ghost', relation: 'peer' }))
    expect(response.status).toBe(404)
    expect(await bodyOf(response)).toMatchObject({ code: 'UNKNOWN_MEMBER' })
  })

  it('setRelation answers 502 for any other service failure', async () => {
    const { team, mutation } = fixture()
    team.relationAnswer = new Error('roster is locked')
    const response = await mutation.fetch(mutate({ session: 'lead-1', op: 'setRelation', memberId: 'child-1', relation: 'peer' }))
    expect(response.status).toBe(502)
    expect(await bodyOf(response)).toEqual({ error: 'roster is locked' })
  })

  it('answers 400 for a malformed envelope or body', async () => {
    const cases: readonly [() => Request, number, string | undefined][] = [
      [() => mutate({ op: 'spawn' }), 400, 'session is required'],
      [() => mutate({ session: 'lead-1', op: 'promote' }), 400, 'op must be "spawn", "dismiss", or "setRelation"'],
      [() => mutate({ session: 'lead-1' }), 400, 'op must be "spawn", "dismiss", or "setRelation"'],
      // Not JSON at all: the same 400, carrying the parser's own sentence.
      [() => new Request(`${ORIGIN}${MUTATION_PATH}`, { method: 'POST', body: 'nope' }), 400, undefined],
    ]
    for (const [build, status, error] of cases) {
      const { mutation } = fixture()
      const response = await mutation.fetch(build())
      expect(response.status).toBe(status)
      const body = await bodyOf(response) as { error: string }
      if (error !== undefined) expect(body.error).toContain(error)
      else expect(body.error.length).toBeGreaterThan(0)
    }
  })

  it('answers 400 when the body is JSON but not an object', async () => {
    const { mutation } = fixture()
    const response = await mutation.fetch(mutate([{ session: 'lead-1', op: 'dismiss', memberId: 'child-1' }]))
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toEqual({ error: 'body must be a JSON object' })
  })

  it('answers 409 for a session that is not resident, before any operation runs', async () => {
    const { team, mutation } = fixture()
    const response = await mutation.fetch(mutate({ session: 'ghost', op: 'spawn', name: 'Bob', task: 'go', relation: 'managed' }))
    expect(response.status).toBe(409)
    expect(await bodyOf(response)).toEqual({ error: 'session ghost is not resident here' })
    expect(team.spawns).toHaveLength(0)
  })

  it('answers 404 for a teammate session', async () => {
    const { team, mutation } = fixture({ 'child-1': agent('child-1', 'subagent') })
    const response = await mutation.fetch(mutate({ session: 'child-1', op: 'dismiss', memberId: 'other' }))
    expect(response.status).toBe(404)
    expect(team.dismissals).toHaveLength(0)
  })
})

/** The `ctx.connection` double: records the path and methods of every route. */
class FakeConnection implements ConnectionSeat {
  readonly contributions: { readonly path: string; readonly methods: readonly string[] }[] = []
  readonly routes: AdminFetchRoute[] = []
  readonly fetch: ConnectionSeat['fetch'] = {
    register: (route: AdminFetchRoute): (() => Promise<void>) => {
      this.routes.push(route)
      this.contributions.push({ path: route.path, methods: route.methods })
      return () => {
        this.routes.splice(this.routes.indexOf(route), 1)
        return Promise.resolve()
      }
    },
  }
}

/** Provide one service on a bare root context, off the typed table. */
function provide(ctx: Context, serviceName: string, value: unknown): void {
  const mount = ctx.provide.bind(ctx) as unknown as (name: string, value: unknown) => void
  mount(serviceName, value)
}

/** Let the injection fiber activate; it starts off a service event. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('registerAdminRoutes', () => {
  it('registers both routes, by path and method, once Connection arrives', async () => {
    const team = new FakeTeam()
    team.roster = [view()]
    const connection = new FakeConnection()
    const ctx = new Context()
    provide(ctx, 'agents', { get: () => agent('lead-1', 'user') })
    provide(ctx, 'team', team)
    registerAdminRoutes(ctx)
    // A headless composition loads this row unchanged: nothing to mount yet.
    expect(connection.contributions).toHaveLength(0)

    provide(ctx, 'connection', connection)
    await settle()
    expect(connection.contributions).toEqual([
      { path: ROSTER_PATH, methods: ['GET'] },
      { path: MUTATION_PATH, methods: ['POST'] },
    ])
  })

  it('serves a roster through the registered contribution', async () => {
    const team = new FakeTeam()
    team.roster = [view()]
    const connection = new FakeConnection()
    const ctx = new Context()
    provide(ctx, 'agents', { get: () => agent('lead-1', 'user') })
    provide(ctx, 'team', team)
    registerAdminRoutes(ctx)
    provide(ctx, 'connection', connection)
    await settle()

    const response = await routeFor(connection.routes, ROSTER_PATH).fetch(read('?session=lead-1'))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ active: true, members: [view()] })
  })
})
