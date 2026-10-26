/**
 * The team's browser-facing `/api/team/*` channel: one read of a leader's
 * roster, and one mutation endpoint a panel drives to shape the team.
 *
 * It rides Connection's shared `/api` transport rather than a raw route on the
 * HTTP listener, and that is a security decision before it is a convenience:
 * only an owner Peer reaches an exact Fetch route — the framework answers 403
 * for every other principal — while a raw listener route would answer anyone
 * who can reach the port. This deployment serves its UI on a LAN address and a
 * spawn creates an agent with a shell, so the authenticated transport is the
 * whole difference between that being a feature and an open door. Nothing here
 * validates a credential itself: the framework has already done it, and a
 * second check would only add a second way to get it wrong.
 *
 * `connection` is injected softly. A headless composition has no browser
 * transport at all, and the row must still load there with every other
 * capability intact; the row's own `inject` therefore never names it.
 *
 * Requests are handled as WHATWG Fetch: one `Request` in, one `Response` out.
 * That is the shape the transport calls, so a test drives the exact call the
 * deployment makes, with no HTTP socket in between.
 *
 * @module dsh-team/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamMemberView, TeamRelation } from './contract.ts'
import { TeamError } from './errors.ts'
import type { TeamMemberFact } from './fold.ts'
import type { TeamSpawnRequest } from './service.ts'
import { memberValue } from './tools.ts'

/** The roster read: one leader session's team, or 409 while it is not resident. */
export const ROSTER_PATH = '/api/team/roster'

/** The one mutating endpoint; the operation it applies is named in the body. */
export const MUTATION_PATH = '/api/team/mutation'

/** Methods the shared channel carries. Mirrors `ConnectionFetchMethod`. */
type FetchMethod = 'GET' | 'HEAD' | 'POST'

/**
 * One exact route on the shared `/api` channel. Mirrors `ConnectionFetchRoute`
 * of `@deepseek-ai/dsh-client-connection`, a package this row does not depend
 * on: naming the structural seat here keeps the row installable in a
 * composition that ships no browser transport.
 */
export interface AdminFetchRoute {
  /** Absolute path below `/api`; the registry refuses anything else. */
  readonly path: string
  /** Methods this exact path owns. */
  readonly methods: readonly FetchMethod[]
  /**
   * Body handling the carrier must use before dispatch. Required by the
   * registry even though both routes only read a small JSON body.
   */
  readonly requestBody: 'buffered' | 'streaming'
  /** Handle one already-authenticated request. */
  readonly fetch: (request: Request) => Promise<Response>
}

/** The narrow seat this row needs on `ctx.connection`. */
export interface ConnectionSeat {
  readonly fetch: {
    /**
     * Add one exact route to the shared channel.
     * @param route - path, methods, body mode, and the Fetch-shaped handler.
     * @returns the disposer removing this exact contribution.
     */
    register(route: AdminFetchRoute): () => Promise<void>
  }
}

/**
 * The team operations these routes call, structurally. `TeamService` satisfies
 * this interface; a test supplies a double without roles, tasks, or the mailbox.
 */
export interface AdminTeam {
  list(actor: Agent): { readonly active: boolean; readonly members: readonly TeamMemberView[] }
  spawn(leader: Agent, request: TeamSpawnRequest, signal: AbortSignal): Promise<TeamMemberFact>
  dismiss(leader: Agent, target?: string): { readonly ended: boolean; readonly memberId?: string }
  setRelation(leader: Agent, target: string, relation: TeamRelation): TeamMemberFact
}

/** What one request needs from the host: the live-session registry and the team service. */
export interface AdminDeps {
  /** The live agent published under one session id, or undefined while it is not resident. */
  readonly agentOf: (sessionId: string) => Agent | undefined
  readonly team: AdminTeam
}

/**
 * Register the team channel on the deployment's shared API transport.
 *
 * A deployment without Connection never runs the callback, and one that mounts
 * it later still gets both routes: that is why this is an injection rather than
 * a lookup on the context.
 *
 * @param ctx - a context whose `team` service is resolved.
 */
export function registerAdminRoutes(ctx: Context): void {
  ctx.inject(['connection'], (connCtx: Context) => {
    // The cast names the seat `connection` occupies (see {@link ConnectionSeat}).
    const connection = (connCtx as Context & { readonly connection: ConnectionSeat }).connection
    const deps: AdminDeps = {
      agentOf: sessionId => connCtx.agents.get(SessionId(sessionId)),
      team: connCtx.team,
    }
    for (const route of adminRoutes(deps)) {
      // The returned disposer is the registry entry itself: registration also
      // fails loudly if the exact path is already taken by another feature.
      connCtx.effect(() => connection.fetch.register(route), `team: ${route.path}`)
    }
  })
}

/**
 * The two exact routes, in the shape the registry takes them. Exported so a test
 * drives the same contributions the deployment mounts, with no carrier.
 * @param deps - the live-session registry and the team service.
 * @returns both route contributions, roster first.
 */
export function adminRoutes(deps: AdminDeps): AdminFetchRoute[] {
  return [
    { path: ROSTER_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => handleRoster(request, deps) },
    { path: MUTATION_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => handleMutation(request, deps) },
  ]
}

/**
 * `GET /api/team/roster?session=…` — the leader's roster and whether its team is
 * live. Read-only, and safe to poll: it folds no state of its own.
 * @param request - the authenticated request carrying the `session` query parameter.
 * @param deps - the live-session registry and the team service.
 * @returns the roster, or the refusal that explains why there is none.
 */
export async function handleRoster(request: Request, deps: AdminDeps): Promise<Response> {
  const session = textOf(new URL(request.url).searchParams.get('session'))
  if (session === undefined) return fail(400, 'session query parameter is required')
  const leader = leaderOf(session, deps)
  if (leader instanceof Response) return leader
  const view = deps.team.list(leader)
  return json(200, { active: view.active, members: view.members.map(rosterRow) })
}

/**
 * `POST /api/team/mutation` — apply one roster change named in the body.
 *
 * The body is validated in three passes, so the answer names the most useful
 * thing first: the envelope (`session`, `op`), then the session itself, then the
 * operation's own fields.
 * @param request - the authenticated request carrying the JSON body.
 * @param deps - the live-session registry and the team service.
 * @returns the operation's result, or the refusal that explains it.
 */
export async function handleMutation(request: Request, deps: AdminDeps): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJson(request)
  } catch (error: unknown) {
    return fail(400, describe(error))
  }
  const session = textOf(body.session)
  if (session === undefined) return fail(400, 'session is required')
  const op = textOf(body.op)
  if (op !== 'spawn' && op !== 'dismiss' && op !== 'setRelation') {
    return fail(400, 'op must be "spawn", "dismiss", or "setRelation"')
  }
  const leader = leaderOf(session, deps)
  if (leader instanceof Response) return leader
  switch (op) {
    case 'spawn':
      return await spawnOp(leader, body, request.signal, deps)
    case 'dismiss':
      return dismissOp(leader, body, deps)
    default:
      return relationOp(leader, body, deps)
  }
}

/**
 * `op: "spawn"` — add one teammate through the same service call `team_spawn`
 * makes.
 * @param leader - the acting leader agent.
 * @param body - the validated envelope plus the spawn fields.
 * @param signal - the request's signal, which the transport aborts when the
 *   client hangs up before the answer, so a cancelled spawn stops composing.
 * @param deps - the team service.
 * @returns the new member, or the refusal.
 */
async function spawnOp(
  leader: Agent,
  body: Record<string, unknown>,
  signal: AbortSignal,
  deps: AdminDeps,
): Promise<Response> {
  const name = textOf(body.name)
  if (name === undefined) return fail(400, 'name is required')
  const task = textOf(body.task)
  if (task === undefined) return fail(400, 'task is required')
  const relation = relationOf(body.relation)
  if (relation === undefined) return fail(400, 'relation must be "managed" or "peer"')
  const texts: Partial<Record<typeof SPAWN_TEXT_FIELDS[number], string>> = {}
  for (const field of SPAWN_TEXT_FIELDS) {
    const raw = body[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return fail(400, `${field} must be a string`)
    const held = raw.trim()
    if (held !== '') texts[field] = held
  }
  let skills: string[] | undefined
  if (body.skills !== undefined) {
    if (!Array.isArray(body.skills)) return fail(400, 'skills must be an array of skill names')
    const names = body.skills.map(entry => typeof entry === 'string' ? entry.trim() : '')
    if (names.some(entry => entry === '')) return fail(400, 'skills must be an array of non-empty skill names')
    skills = names
  }
  try {
    const member = await deps.team.spawn(leader, {
      name,
      task,
      relation,
      ...texts.role !== undefined ? { role: texts.role } : {},
      ...texts.persona !== undefined ? { persona: texts.persona } : {},
      ...texts.provider !== undefined ? { provider: texts.provider } : {},
      ...texts.model !== undefined ? { model: texts.model } : {},
      ...texts.reasoningEffort !== undefined ? { reasoningEffort: texts.reasoningEffort } : {},
      ...skills !== undefined ? { skills } : {},
    }, signal)
    return json(200, { member: memberValue(member) })
  } catch (error: unknown) {
    return failure(error)
  }
}

/**
 * `op: "dismiss"` — dismiss one teammate.
 * @param leader - the acting leader agent.
 * @param body - the validated envelope plus `memberId`.
 * @param deps - the team service.
 * @returns the dismissal outcome, or the refusal.
 */
function dismissOp(leader: Agent, body: Record<string, unknown>, deps: AdminDeps): Response {
  const memberId = textOf(body.memberId)
  if (memberId === undefined) return fail(400, 'memberId is required')
  try {
    const outcome = deps.team.dismiss(leader, memberId)
    return json(200, { ended: outcome.ended, ...outcome.memberId !== undefined ? { memberId: outcome.memberId } : {} })
  } catch (error: unknown) {
    return failure(error)
  }
}

/**
 * `op: "setRelation"` — widen or tighten one teammate's autonomy.
 * @param leader - the acting leader agent.
 * @param body - the validated envelope plus `memberId` and `relation`.
 * @param deps - the team service.
 * @returns the whole post-change member, or the refusal.
 */
function relationOp(leader: Agent, body: Record<string, unknown>, deps: AdminDeps): Response {
  const memberId = textOf(body.memberId)
  if (memberId === undefined) return fail(400, 'memberId is required')
  const relation = relationOf(body.relation)
  if (relation === undefined) return fail(400, 'relation must be "managed" or "peer"')
  try {
    return json(200, { member: memberValue(deps.team.setRelation(leader, memberId, relation)) })
  } catch (error: unknown) {
    return failure(error)
  }
}

/**
 * Resolve the leader a request addresses.
 *
 * The two refusals are deliberately different: a session that is not loaded here
 * may simply be another worker's or a cold one (409 — the client can retry
 * later), while a loaded teammate session is never a leader (404 — this request
 * is addressed wrong and retrying changes nothing).
 *
 * @param session - the session id the request named.
 * @param deps - the live-session registry.
 * @returns the leader agent, or the Response that refuses the request.
 */
function leaderOf(session: string, deps: AdminDeps): Agent | Response {
  const agent = deps.agentOf(session)
  if (agent === undefined) return fail(409, `session ${session} is not resident here`)
  if (agent.session.header.origin === 'subagent') {
    return fail(404, `${session} is a teammate session, not a team leader`)
  }
  return agent
}

/**
 * The contract's roster row. `TeamService.list` adds the live `status` on top of
 * the durable view; the API contract fixes a row as `TeamMemberView`, so this
 * projection names every contract field and nothing else.
 * @param member - one roster row as the service reports it.
 * @returns the same row, narrowed to the contract.
 */
function rosterRow(member: TeamMemberView): TeamMemberView {
  return {
    memberId: member.memberId,
    name: member.name,
    relation: member.relation,
    ...member.role !== undefined ? { role: member.role } : {},
    ...member.provider !== undefined ? { provider: member.provider } : {},
    ...member.model !== undefined ? { model: member.model } : {},
    ...member.effort !== undefined ? { effort: member.effort } : {},
    ...member.skills !== undefined ? { skills: [...member.skills] } : {},
    joinedAt: member.joinedAt,
  }
}

/**
 * Read one JSON object body.
 * @param request - the authenticated request.
 * @returns the body as a plain object; an empty body reads as `{}`.
 * @throws when the body is not JSON or not an object.
 */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json()
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * One service refusal, at the status its reason deserves: a member the roster
 * does not hold is a client mistake (404), and every other failure of the call
 * is a failed service operation (502). `code` carries the stable `TeamError`
 * code so a panel can branch without parsing prose.
 * @param error - the thrown value.
 * @returns the refusal response.
 */
function failure(error: unknown): Response {
  return fail(
    refusalStatus(error),
    error instanceof TeamError ? error.message : describe(error),
    error instanceof TeamError ? error.code : undefined,
  )
}

/**
 * The status one refusal maps to.
 * @param error - the thrown value.
 * @returns 404 for a member the roster does not hold, 502 for everything else.
 */
function refusalStatus(error: unknown): number {
  if (error instanceof TeamError && error.code === 'UNKNOWN_MEMBER') return 404
  return 502
}

/** A readable sentence for an unknown throwable. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write one JSON response.
 * @param status - the HTTP status code.
 * @param value - the JSON body.
 * @returns the response the carrier writes out.
 */
function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Answer one refusal.
 * @param status - the HTTP status code.
 * @param error - the sentence the client reads.
 * @param code - the machine-readable reason, when one exists.
 * @returns the response.
 */
function fail(status: number, error: string, code?: string): Response {
  return json(status, { error, ...code !== undefined ? { code } : {} })
}

/** A trimmed non-empty string field, or undefined when it is absent, blank, or not a string. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The two relation levels, as a request body names them. */
function relationOf(value: unknown): TeamRelation | undefined {
  return value === 'managed' || value === 'peer' ? value : undefined
}

/** The optional text fields one spawn body may carry, in the order they are read. */
const SPAWN_TEXT_FIELDS = ['role', 'persona', 'provider', 'model', 'reasoningEffort'] as const
