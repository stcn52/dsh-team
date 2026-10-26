/**
 * The agent-team service: roster, mailbox routing with its relation-based
 * authorization, the shared task list, and the team lifecycle.
 *
 * Teammates are NOT a private runtime. Each one is a continuable subagent of
 * the leader (`ctx.subagents.startActivation`), so the harness owns identity,
 * residency, cold resume after a restart, interrupt, and the `origin:
 * 'subagent'` session header that keeps a teammate out of the session tree and
 * out of generic Host routing. What this service adds is what the subagent
 * seam deliberately leaves out: named members, member-to-member delivery, and
 * one shared task list.
 *
 * Delivery authority is always the leader's. `ctx.subagents` authorizes a
 * follow-up against the durable direct-parent lineage only ("teams remain
 * rejected until an explicit authority protocol has a production consumer"),
 * and the leader IS every teammate's durable direct parent. A peer-to-peer
 * message is therefore a leader-authorized delivery whose durable source names
 * the real sender; `relation` decides who may ASK for it, never who may
 * perform it.
 *
 * @module dsh-team/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  EMPTY_TEAM_VIEW, type TeamChain, type TeamMemberView, type TeamMessageView, type TeamRelation,
  type TeamTaskStatus, type TeamTaskView, type TeamView,
} from './contract.ts'
import { TeamError } from './errors.ts'
import { foldTeam, TEAM_MEMBER_RECORD, type TeamMemberFact, type TeamMemberRecord } from './fold.ts'
import type { TeamConfig } from './config.ts'

/** Live lifecycle of one teammate, as `list_agents` names the same states. */
export type MemberStatus = 'running' | 'idle' | 'ready'

/** How many recent conversation chains one team keeps enforcement state for. */
const CHAIN_MEMORY = 64

/**
 * The default `team_wait` budget: long enough for one teammate's turn, short
 * enough that a stalled member is reported instead of holding the leader's turn
 * for the rest of the session.
 */
export const WAIT_DEFAULT_MS = 120_000

/**
 * The ceiling `team_wait` accepts. A leader that genuinely needs longer asks
 * again with the members still running; holding one tool call for longer than
 * this only makes a stuck roster invisible for longer.
 */
export const WAIT_MAX_MS = 600_000

/**
 * How long `team_wait` lets a just-accepted delivery settle before it reads the
 * roster. `team_send` is asynchronous by contract: its prompt is accepted into
 * the recipient's inbox — behind which a cold recipient may also be resumed and
 * published — while `whenIdle()` only answers "is the current activity
 * quiescent". Without one settle, a wait issued straight from the sending turn
 * would read an idle member whose driver has not started yet.
 */
const WAKE_SETTLE_MS = 25

/**
 * How far back one wait's report scan may walk the leader's log.
 *
 * The scan is already bounded by the delivery boundary it is looking past (see
 * {@link TeamState.deliveredAt}); this is the second, absolute bound, for the
 * log of a long session whose boundary predates a restart. Walking back is what
 * makes the bound cheap in the common case: the evidence of a finished member is
 * near the end, and an old enough report being out of reach only costs an
 * under-claim (`cold`, "nothing observed says it finished"), never a done that
 * the round cannot support.
 */
const LOG_REPORT_SCAN_LIMIT = 4096

/**
 * The address that means "everyone else on this team". It expands per the
 * sender's relation, because a managed member may only reach the leader and
 * its wildcard therefore resolves to that one address.
 */
const WILDCARD_ADDRESS = '*'

/** Traffic one conversation chain has already carried, per ordered pair. */
interface ChainRecord {
  /** Deliveries per `from → to` pair. */
  readonly edges: Map<string, number>
  /** The last text each ordered pair carried, so a verbatim repeat is refused. */
  readonly said: Map<string, string>
}

/** The live team of one leader session. */
interface TeamState {
  active: boolean
  readonly members: Map<string, TeamMemberFact>
  readonly tasks: Map<string, TeamTaskView>
  /**
   * The delivery each member is working from. A teammate's own sends inherit
   * it, which is what makes a peer exchange one bounded conversation rather
   * than an unbounded sequence of unrelated messages.
   */
  readonly inbox: Map<string, TeamChain>
  /**
   * Per member: the ids of that member's messages which were ALREADY queued in
   * the leader's inbox when this process last delivered a task to it. Delivery
   * time is the only moment that separates "the reply to the task I just sent"
   * from "an earlier reply nothing has consumed yet", because a queued message
   * carries no timestamp — only its presence. Frozen at delivery, so an old
   * reply can never be read as this round's completion.
   */
  readonly staleReports: Map<string, ReadonlySet<string>>
  /**
   * Per member: how many events the leader's log held at the moment this
   * process last delivered a task to it — the same boundary as
   * {@link staleReports}, counted in the log's own currency.
   *
   * The queued message and the logged splice are two views of one delivery
   * boundary, and they answer one question: did the member report AFTER this
   * task was handed to it? A queued message carries no timestamp, so its
   * freshness is an id set; a log event carries a position, so its freshness is
   * a count. Missing means "this process never delivered to it", and the whole
   * log is admissible — a brand-new member cannot have an older report, because
   * its session id is new.
   */
  readonly deliveredAt: Map<string, number>
  /** Enforcement state per chain, oldest first and bounded by {@link CHAIN_MEMORY}. */
  readonly chains: Map<string, ChainRecord>
  /** Monotonic chain counter for this leader's live team. */
  started: number
}

/** A spawn in flight: identity for the teammate scope that is being composed. */
interface PendingSpawn {
  readonly fact: Omit<TeamMemberFact, 'memberId'>
  /** Child ids adopted by the setup contribution, rolled back on failure. */
  readonly claimed: string[]
}

/** What the leader asks for when spawning one teammate. */
export interface TeamSpawnRequest {
  readonly name: string
  readonly role?: string
  readonly persona?: string
  readonly relation: TeamRelation
  readonly task: string
  /**
   * LLM provider route for this teammate. Omitted inherits the leader's route
   * (or the deployment's `teammateProvider` default); naming another route is
   * how one teammate runs on a locally served model.
   */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /**
   * Skills this teammate must load before working. Each member carries only the
   * skills its own job needs; the catalog stays readable, so it may still find
   * more, but the leader's assignment is what it is told to put first.
   */
  readonly skills?: readonly string[]
}

/** The route one spawn resolves to, after request and deployment defaults. */
interface ResolvedRoute {
  readonly provider?: string
  readonly model?: string
}

/** One roster row with its live runtime state. */
export interface TeamMemberStatusView extends TeamMemberView {
  readonly status: MemberStatus
}

/** The model-facing team read. */
export interface TeamListResult {
  readonly active: boolean
  readonly members: readonly TeamMemberStatusView[]
  readonly tasks: readonly TeamTaskView[]
  readonly messages: readonly TeamMessageView[]
}

/**
 * What one `team_wait` observed when it returned: three disjoint buckets whose
 * union is exactly the set of targets the wait was asked about, named in the
 * order they were asked about, plus whether the clock ran out.
 *
 * The split answers two questions that must not be collapsed into one.
 * `whenIdle()` answers "is this member's turn over" — quiescence. `cold` answers
 * "did anything observed show this member finishing", which is the question a
 * leader asking "is everyone back" actually depends on: a member that no live
 * session was ever seen for, and that has not written back either, may not have
 * started — reporting it as done turns a broadcast that woke nobody into a
 * completed round, while reporting it as "never started" is a claim the
 * observation cannot support (it may have finished without reporting back).
 */
export interface TeamWaitResult {
  /**
   * Members confirmed finished: `whenIdle()` settled during the observation, the
   * member was seen live during it and was no longer `running` when the wait
   * ended (reaped included — a reaped agent occupies no turn), or its session was
   * already gone while the leader held its report — queued in the leader's inbox
   * for this round, spliced into the leader's own log after this round's
   * delivery (the row the queue is built from and outlives it), or already
   * spliced into its durable mailbox.
   */
  readonly done: readonly string[]
  /**
   * Members seen live during the observation that were still `running` at the
   * deadline. Empty unless `timedOut`.
   */
  readonly busy: readonly string[]
  /**
   * Members with no live session at any point during the observation AND no
   * report from them this round — not queued in the leader's inbox, not spliced
   * into the leader's log after this round's delivery, not in its durable
   * mailbox: not resident, cold, or already reaped — and silent.
   * Usually a delivery that has not been woken yet, but possibly a member that
   * finished without writing back, so this is "not confirmed finished", NEVER
   * evidence that the work came back, and never part of `done`.
   */
  readonly cold: readonly string[]
  /** Whether the budget expired before every target settled. */
  readonly timedOut: boolean
}

/** What one caller asks `team_wait` to observe. */
export interface TeamWaitRequest {
  /** Member names or ids; omitted means every member of this team. */
  readonly members?: readonly string[]
  /** Wall-clock budget in milliseconds, clamped to `[1, WAIT_MAX_MS]`. */
  readonly timeoutMs?: number
  /** Caller cancellation: the wait refuses with `ABORTED` instead of a partial read. */
  readonly signal?: AbortSignal
}

/** Where one member sits: whose workspace it reaches, and how a note is signed. */
export interface TeamSeat {
  readonly leaderId: string
  readonly memberId: string
  readonly name: string
}

/** Who is acting, and which team they act in. */
interface Actor {
  /** The live leader agent whose parent authority every delivery uses. */
  readonly leader: Agent
  readonly team: TeamState
  /** The acting teammate, or undefined when the leader itself is acting. */
  readonly member?: TeamMemberFact
}

/** One resolved delivery recipient. */
export type Recipient =
  | { readonly kind: 'leader'; readonly id: string; readonly name: string }
  | { readonly kind: 'member'; readonly id: string; readonly name: string; readonly member: TeamMemberFact }

/** One member a wait observes, resolved against the roster before any clock starts. */
interface WaitTarget {
  readonly memberId: string
  readonly name: string
}

/**
 * What one wait has learned about one target while it watched. Live state, read
 * when the wait ends — never a snapshot taken before it began.
 */
interface WaitObservation {
  /**
   * At least one `agents.get()` — the first read or a later `agent/created` —
   * returned a live agent for this member, whatever its status at the time.
   * This separates "it was there to watch" from "nothing was there"; it does NOT
   * separate finished from never started, because a turn that ran and was reaped
   * before the first read leaves `seen` false too. The mailbox answers that one.
   */
  seen: boolean
  /**
   * `whenIdle()` resolved (its rejection counts: an unobservable member must not
   * hang the leader's turn). Only this means the member's turn really ended.
   */
  settled: boolean
}

/**
 * The `agent/created` subscriptions one wait is holding, so a wait that ends by
 * deadline or by cancellation can drop every one of them. A listener that
 * outlived its wait would wake a dead closure on every later publication.
 */
type WaitWatch = Set<() => void>

/** One accepted mailbox delivery: the message an inbox took, and its chain. */
export interface TeamDelivery {
  /** Identity of the message the recipient's inbox accepted. */
  readonly messageId: string
  /** Who took it, after address resolution and de-duplication. */
  readonly recipient: Recipient
  /**
   * The conversation this delivery belongs to. One broadcast shares a single
   * chain, so every recipient inherits the same id and the same depth; each
   * recipient's own replies deepen only its own leg of it.
   */
  readonly chain: TeamChain
}

/** Every delivery one broadcast made, in address order. */
export interface TeamBroadcastResult {
  /** One entry per distinct recipient: the same address twice delivers once. */
  readonly deliveries: readonly TeamDelivery[]
}

/** `Context.team`: roster, mailbox routing, tasks, and team lifecycle. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'subagents', 'sessionProjections']

  /** Live team per leader session id; rebuilt lazily from that session's log. */
  private readonly teams = new Map<string, TeamState>()
  /** Spawns in flight, keyed by leader session id (team tools never overlap). */
  private readonly pending = new Map<string, PendingSpawn>()

  constructor(ctx: Context, private readonly config: TeamConfig) {
    super(ctx, 'team')
    // A leader's live team is a cache of its log. Dropping it with the agent
    // keeps a resumed session from inheriting the previous lifecycle's roster,
    // and keeps this map from growing with every session ever touched.
    ctx.on('agent/disposed', (payload: { agent: Agent }) => {
      this.teams.delete(payload.agent.id)
      this.pending.delete(payload.agent.id)
    })
  }

  /**
   * The live team of one leader, rebuilt from its log on first touch. Nothing
   * is resumed here: a teammate materializes only when a message reaches it.
   * @param leader - the leader session's live agent.
   * @returns the mutable live team state.
   */
  teamOf(leader: Agent): TeamState {
    const existing = this.teams.get(leader.id)
    if (existing !== undefined) return existing
    const view = this.durableView(leader)
    const state: TeamState = {
      active: view.active,
      members: new Map(view.members.map(member => [member.memberId, memberFact(member)])),
      tasks: new Map(view.tasks.map(task => [task.taskId, task])),
      inbox: new Map(),
      staleReports: new Map(),
      deliveredAt: new Map(),
      chains: new Map(),
      started: 0,
    }
    this.teams.set(leader.id, state)
    return state
  }

  /**
   * Commit one roster change to the LEADER's session log.
   *
   * `ctx.emit('team/changed')` is a same-process edge only — it tells observers
   * to look again, and it dies with the process. The roster the panel renders is
   * rebuilt from this log ({@link durableView}), so a lifecycle change that only
   * emitted would be gone after a refresh, and a spawn made through the admin
   * route has no tool result to carry it. This record is that durable half.
   *
   * The event is a plugin record, not a released type: it is committed
   * `ignorable`, never enters the model-visible surface, and a reader that does
   * not know the type skips it instead of refusing the log.
   * @param leader - the leader whose session log carries the team.
   * @param record - the WHOLE post-change roster fact.
   */
  private publish(leader: Agent, record: TeamMemberRecord): void {
    try {
      appendPluginRecord(leader.session, TEAM_MEMBER_RECORD, record)
    } catch (error: unknown) {
      // The roster already changed in memory, and a refusal here is not worth
      // failing a spawn whose child is live (a reentrant append is the
      // realistic cause). The divergence is reported, never swallowed.
      this.ctx.logger.warn(
        'dsh-team: publishing %s to the session log failed: %s',
        record.op,
        String(error),
      )
      return
    }
    // Durability is a checkpoint rather than this call's contract: the route
    // answers once the fact is in the log, and the backend drains its buffer.
    void this.ctx.sessions.flush(leader.session)
  }

  /**
   * Adopt one continuable child into the team world while its scope is being
   * composed. Called from the teammate setup contribution after the child is
   * published — on cold resume the child is already on the leader's roster,
   * and only a child the roster has never seen can be the spawn currently in
   * flight.
   * @param child - the unpublished child agent.
   * @returns the membership facts, or undefined for a child outside any team.
   */
  adopt(child: Agent): TeamMemberFact | undefined {
    const leaderId = child.session.header.parentSession
    if (leaderId === undefined) return undefined
    const leader = this.ctx.agents.get(leaderId)
    if (leader === undefined) return undefined
    const team = this.teamOf(leader)
    // Roster first: a cold resume of one teammate may run while another spawn
    // is in flight (a peer's message wakes it), and claiming the pending
    // identity for it would give two children the same name.
    const known = team.members.get(child.id)
    if (known !== undefined) return known
    const pending = this.pending.get(leaderId)
    if (pending === undefined) return undefined
    const fact: TeamMemberFact = { ...pending.fact, memberId: child.id }
    pending.claimed.push(child.id)
    team.members.set(child.id, fact)
    return fact
  }

  /**
   * Spawn one teammate: a continuable subagent of the leader plus a roster row.
   * @param leader - the acting leader agent.
   * @param request - name, relation, initial task, and optional overrides.
   * @param signal - cancellation owning the operation until the teammate accepts its brief.
   * @returns the new member's durable facts.
   * @throws {TeamError} when the actor cannot lead, or the roster is full.
   */
  async spawn(leader: Agent, request: TeamSpawnRequest, signal: AbortSignal): Promise<TeamMemberFact> {
    if (leader.session.header.origin === 'subagent') throw new TeamError('NESTED_TEAM')
    const team = this.teamOf(leader)
    if (team.members.size >= this.config.maxTeammates) {
      throw new TeamError('MAX_TEAMMATES', String(this.config.maxTeammates))
    }
    if (findByName(team, request.name) !== undefined) throw new TeamError('DUPLICATE_NAME', request.name)
    const route = this.resolveRoute(leader, request)
    await this.assertProviderRegistered(leader, route.provider)
    await this.assertEffortOffered(leader, request, route)
    const agentOptions: AgentOptions = {
      ...route.provider !== undefined ? { provider: route.provider } : {},
      ...route.model !== undefined ? { model: route.model } : {},
      ...request.reasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }
        : {},
    }
    const pending: PendingSpawn = {
      fact: {
        name: request.name,
        relation: request.relation,
        ...request.role !== undefined ? { role: request.role } : {},
        ...route.provider !== undefined ? { provider: route.provider } : {},
        ...route.model !== undefined ? { model: route.model } : {},
        ...request.reasoningEffort !== undefined ? { effort: request.reasoningEffort } : {},
        ...request.skills !== undefined && request.skills.length > 0 ? { skills: [...request.skills] } : {},
      },
      claimed: [],
    }
    this.pending.set(leader.id, pending)
    let childId: SessionIdType
    try {
      const started = await this.ctx.subagents.startActivation({
        provider: this.config.provider,
        label: request.role === undefined ? request.name : `${request.name} (${request.role})`,
        request: {
          parent: leader,
          prompt: [{ type: 'text', text: brief(request) }],
          ...request.persona !== undefined ? { persona: request.persona } : {},
          ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
        },
        signal,
        // DSH 0.2.1: startActivation replaced startContinuable; parenting delivery
        // matches the old continuable behaviour (the leader's model is notified).
        delivery: 'parent',
      })
      childId = started.childId
    } catch (error: unknown) {
      // The child rolled back: drop whatever its composition window adopted so
      // a failed spawn never leaves a phantom on the roster.
      for (const claimed of pending.claimed) team.members.delete(claimed)
      throw error
    } finally {
      this.pending.delete(leader.id)
    }
    const fact: TeamMemberFact = { ...pending.fact, memberId: childId }
    team.members.set(childId, fact)
    team.active = true
    this.publish(leader, { version: 1, op: 'upsert', member: fact })
    this.ctx.emit('team/changed', { leaderId: leader.id })
    return fact
  }

  /**
   * Deliver a mailbox message to one address, a list of addresses, or everyone.
   * The leader may message any teammate; a peer teammate may message the leader
   * or any other teammate; a managed teammate may message only the leader, so
   * its wildcard collapses to that one address.
   *
   * A teammate-to-teammate delivery also spends chain budget: it continues the
   * conversation its sender is working from, and that conversation may only
   * relay so far and may not repeat one ordered pair. Escalation to the leader
   * spends nothing, so the guard converges a peer exchange without ever
   * trapping a member with something to say.
   *
   * A broadcast is all-or-nothing. Every address is resolved, every relation and
   * every per-recipient budget is checked before the first mailbox is touched,
   * so a refusal anywhere delivers nothing anywhere — there is no half-sent
   * broadcast. The whole broadcast shares ONE chain: recipients are charged
   * their own `sender → recipient` leg of it, so reaching three teammates does
   * not cost any one of them three relays, and no broadcast deepens a chain past
   * the hop budget it has already spent.
   *
   * A single address keeps the one-delivery result every existing caller reads;
   * a list or `"*"` answers with the deliveries it made. `"*"` passed through an
   * untyped `string` still broadcasts at runtime — pass the literal so the type
   * matches what happens.
   * @param from - the acting agent (leader or teammate).
   * @param to - recipient member id or member name, `leader`, a list of those,
   *   or `"*"` for everyone else on the team.
   * @param text - the message content, identical for every recipient.
   * @param signal - cancellation owning each delivery until inbox acceptance.
   * @returns one accepted delivery for a single address, or the whole broadcast.
   * @throws {TeamError} when the actor is outside the team, an address is
   *   unknown (the refusal names it), the actor's relation forbids a delivery,
   *   or the conversation has spent its budget — all before anything is sent.
   */
  async send(from: Agent, to: '*', text: string, signal: AbortSignal): Promise<TeamBroadcastResult>
  async send(from: Agent, to: readonly string[], text: string, signal: AbortSignal): Promise<TeamBroadcastResult>
  /** A single address, answered with the one delivery it made. */
  async send(from: Agent, to: string, text: string, signal: AbortSignal): Promise<TeamDelivery>
  async send(
    from: Agent,
    to: string | readonly string[],
    text: string,
    signal: AbortSignal,
  ): Promise<TeamDelivery | TeamBroadcastResult>
  async send(
    from: Agent,
    to: string | readonly string[],
    text: string,
    signal: AbortSignal,
  ): Promise<TeamDelivery | TeamBroadcastResult> {
    const actor = this.resolveActor(from)
    // Phase 1: every address, every relation rule, every budget — all of it
    // before the first delivery, which is what makes a broadcast all-or-nothing.
    const recipients = this.resolveRecipients(actor, to)
    for (const recipient of recipients) this.assertDeliverable(actor, from, recipient)
    const chain = this.chainFor(actor, from)
    for (const recipient of recipients) {
      if (recipient.kind === 'member') this.assertBudget(actor.team, chain, from.id, recipient, text)
    }
    // Phase 2: deliver. Each recipient is charged its own leg of the one chain,
    // never a share of somebody else's.
    const deliveries: TeamDelivery[] = []
    for (const recipient of recipients) {
      const messageId = await this.deliver(actor, recipient, [{ type: 'text', text }], signal, chain)
      this.recordDelivery(actor.team, chain, from.id, recipient, text)
      deliveries.push({ messageId, recipient, chain })
    }
    if (typeof to === 'string' && to.trim() !== WILDCARD_ADDRESS) return deliveries[0]!
    return { deliveries }
  }

  /**
   * Create or update one shared task. Writes are the leader's: a teammate's
   * own tool calls land in its own log, which the leader's durable team state
   * never reads — teammates report, and the leader records the outcome.
   * @param leader - the acting leader agent.
   * @param spec - a new task (title) or an update to an existing one (taskId).
   * @returns the whole post-change task.
   * @throws {TeamError} when the actor is not the leader, the task is unknown,
   *   or the assignee is not on the roster.
   */
  upsertTask(leader: Agent, spec: {
    readonly taskId?: string
    readonly title?: string
    readonly assigneeId?: string
    readonly status?: TeamTaskStatus
    readonly note?: string
  }): TeamTaskView {
    const actor = this.resolveActor(leader)
    if (actor.member !== undefined) throw new TeamError('UNAUTHORIZED', 'only the leader writes the task list')
    const assigneeId = spec.assigneeId === undefined
      ? undefined
      : this.resolveRecipient(actor, spec.assigneeId).id
    if (spec.taskId === undefined) {
      if (spec.title === undefined) throw new TeamError('TASK_TITLE_REQUIRED')
      const task: TeamTaskView = {
        taskId: taskIdOf(actor.team),
        title: spec.title,
        status: spec.status ?? 'pending',
        ...assigneeId !== undefined ? { assigneeId } : {},
        ...spec.note !== undefined ? { note: spec.note } : {},
      }
      actor.team.tasks.set(task.taskId, task)
      this.ctx.emit('team/changed', { leaderId: actor.leader.id })
      return task
    }
    const previous = actor.team.tasks.get(spec.taskId)
    if (previous === undefined) throw new TeamError('UNKNOWN_TASK', spec.taskId)
    const task: TeamTaskView = {
      ...previous,
      ...spec.title !== undefined ? { title: spec.title } : {},
      ...spec.status !== undefined ? { status: spec.status } : {},
      ...assigneeId !== undefined ? { assigneeId } : {},
      ...spec.note !== undefined ? { note: spec.note } : {},
    }
    actor.team.tasks.set(task.taskId, task)
    this.ctx.emit('team/changed', { leaderId: actor.leader.id })
    return task
  }

  /**
   * Change one teammate's relationship level.
   * @param leader - the acting leader agent.
   * @param target - the teammate's member id or name.
   * @param relation - the new relation.
   * @returns the whole post-change member record.
   * @throws {TeamError} when the actor is not the leader or the member is unknown.
   */
  setRelation(leader: Agent, target: string, relation: TeamRelation): TeamMemberFact {
    const actor = this.resolveActor(leader)
    if (actor.member !== undefined) throw new TeamError('UNAUTHORIZED', 'only the leader changes relations')
    const recipient = this.resolveRecipient(actor, target)
    if (recipient.kind !== 'member') throw new TeamError('UNKNOWN_MEMBER', target)
    const fact: TeamMemberFact = { ...recipient.member, relation }
    actor.team.members.set(fact.memberId, fact)
    this.publish(actor.leader, { version: 1, op: 'upsert', member: fact })
    this.ctx.emit('team/changed', { leaderId: actor.leader.id })
    return fact
  }

  /**
   * Dismiss one teammate, or end the whole team when no target is given. A
   * dismissed teammate stops its current turn and stops receiving mail; its
   * durable session stays readable through the subagent catalog.
   * @param leader - the acting leader agent.
   * @param target - the teammate's member id or name; absent ends the team.
   * @returns whether the team ended, plus the dismissed member id when targeted.
   * @throws {TeamError} when the actor is not the leader or the member is unknown.
   */
  dismiss(leader: Agent, target?: string): { readonly ended: boolean; readonly memberId?: string } {
    const actor = this.resolveActor(leader)
    if (actor.member !== undefined) throw new TeamError('UNAUTHORIZED', 'only the leader dismisses teammates')
    if (target === undefined) {
      for (const memberId of [...actor.team.members.keys()]) this.stopMember(actor.leader, memberId)
      actor.team.members.clear()
      actor.team.tasks.clear()
      actor.team.inbox.clear()
      actor.team.staleReports.clear()
      actor.team.chains.clear()
      actor.team.active = false
      this.publish(actor.leader, { version: 1, op: 'ended' })
      this.ctx.emit('team/changed', { leaderId: actor.leader.id, ended: true })
      return { ended: true }
    }
    const recipient = this.resolveRecipient(actor, target)
    if (recipient.kind !== 'member') throw new TeamError('UNKNOWN_MEMBER', target)
    this.stopMember(actor.leader, recipient.id)
    actor.team.members.delete(recipient.id)
    // A dismissed member carries no conversation forward; a later member
    // reusing its id would otherwise inherit a stranger's chain.
    actor.team.inbox.delete(recipient.id)
    actor.team.staleReports.delete(recipient.id)
    this.publish(actor.leader, { version: 1, op: 'remove', memberId: recipient.id })
    this.ctx.emit('team/changed', { leaderId: actor.leader.id, removedMember: recipient.id })
    return { ended: false, memberId: recipient.id }
  }

  /**
   * The roster, task list, and recent leader-visible mailbox traffic, from the
   * point of view of any member of the team.
   * @param actorAgent - the acting leader or teammate.
   * @returns the live team read; an inactive team reports empty lists.
   */
  list(actorAgent: Agent): TeamListResult {
    const actor = this.tryResolveActor(actorAgent)
    if (actor === undefined) return { active: false, members: [], tasks: [], messages: [] }
    const view = this.durableView(actor.leader)
    return {
      active: actor.team.active,
      members: [...actor.team.members.values()].map(member => ({
        ...member,
        joinedAt: view.members.find(row => row.memberId === member.memberId)?.joinedAt ?? 0,
        status: this.statusOf(member.memberId),
      })),
      tasks: [...actor.team.tasks.values()],
      messages: [...view.messages],
    }
  }

  /**
   * Block until the named teammates stop running, or until the budget expires.
   *
   * Observation only: nothing here spawns, wakes, cancels, or messages a member.
   * Readiness is `Agent.whenIdle()` — the harness's own quiescence signal —
   * rather than a poll of `Agent.status`: a status sample can miss a turn that
   * begins between two samples, while `whenIdle()` follows the activity it was
   * observed against.
   *
   * The answer carries three disjoint buckets (see {@link TeamWaitResult}), and
   * the rule that used to be wrong is how `cold` is decided:
   *
   * - Every target is watched for the whole window, recording `seen` the moment
   *   `agents.get()` (or an `agent/created` for it) yields a live agent, however
   *   that agent's status reads at the time.
   * - `whenIdle()` settling → `done`.
   * - At the deadline: `seen` and still `running` → `busy`; `seen` but no longer
   *   running (idle or reaped) → `done`; never `seen` → `done` when the leader
   *   holds a report from it — queued in its inbox for this round, spliced into
   *   its log after this round's delivery, or in its durable mailbox with
   *   nothing addressed to it since — and `cold` otherwise.
   *
   * "No agent in the registry" is three histories, not one: never started, a
   * delivery accepted but not yet published, or a turn that ran and was reaped
   * before the first read. The first two must not be called done — that is the
   * bug this split fixes, where a broadcast that reached nobody looked like a
   * completed round — while the third MUST be: a member whose whole turn fits
   * between the spawn and the wait (1.3 s in the host trace that found this) has
   * finished, and reporting it as missing is its own false alarm. What separates
   * them is the leader's own report trail. The durable mailbox alone was not
   * enough: a report reaches that log only at the leader's next step boundary,
   * so a wait issued in the same turn saw "no live session, no report" for a
   * member that had already answered while the report sat in the inbox queue.
   * The queue is therefore read first (see {@link reportedIntoInbox}), with the
   * log as the durable half of the same question (see {@link reportedInLog}) —
   * the queue is a moment, and the splice row outlives it even when the boundary
   * consumes the notice without ever delivering it — and the mailbox as the part
   * that did reach the surface. One delivery boundary keeps an older round's
   * reply from standing in for this one, in both currencies. A
   * `cold` target therefore means "nothing observed says it finished", not "it
   * never started", and because nothing shorter than the caller's own budget can
   * tell "woken in a moment" from "never woken", it still makes the wait run the
   * full budget rather than answer at once.
   *
   * The boundary this answer still carries: it reports **quiescence**, not
   * receipt. A member that is idle right now may already be holding a prompt
   * `team_send` accepted a moment ago, and `whenIdle()` cannot see that — so one
   * settle window runs before the first read, and a delivery that lands later
   * than that window on an already-resident, already-idle member is
   * indistinguishable from a member that was already idle.
   * @param actorAgent - the acting leader or teammate.
   * @param request - who to wait for, for how long, and the caller's signal.
   * @returns who is done, who is still running, who had no live session and no
   *   report, and whether time ran out.
   * @throws {TeamError} `UNKNOWN_MEMBER` for an address this team cannot place
   *   (the leader itself included — it is the one waiting), `ABORTED` when the
   *   caller's signal fires, `NO_TEAM`/`LEADER_AWAY` when there is no team.
   */
  async wait(actorAgent: Agent, request: TeamWaitRequest = {}): Promise<TeamWaitResult> {
    const actor = this.resolveActor(actorAgent)
    const targets = this.waitTargets(actor, request.members)
    // Read through a call, not the property directly: `AbortSignal.aborted` is
    // readonly, so a second direct comparison would be narrowed away by the
    // first — but the settle below is exactly where it can change.
    const cancelled = (): boolean => request.signal?.aborted === true
    // Checked before the first await, so an already-cancelled call never reports
    // a cheerful "everyone is done".
    if (cancelled()) {
      throw new TeamError('ABORTED', 'team_wait was cancelled before it started')
    }
    // Nothing to observe is a complete answer, not a refusal: an empty roster and
    // an explicit empty selection have both already happened.
    if (targets.length === 0) return { done: [], busy: [], cold: [], timedOut: false }
    await this.settle()
    // The settle is an await of its own, so a cancellation that lands during it
    // must still refuse rather than report a roster it stopped believing in.
    if (cancelled()) {
      throw new TeamError('ABORTED', 'team_wait was cancelled before it observed anyone')
    }
    const observations = targets.map((): WaitObservation => ({ seen: false, settled: false }))
    const watch: WaitWatch = new Set()
    let outcome: 'done' | 'timeout'
    try {
      const observing = targets.map((target, index) => this.observeIdle(target, observations[index]!, watch))
      outcome = await this.raceWait(observing, clampWait(request.timeoutMs), request.signal)
    } finally {
      // Every cold subscription dies with the wait, on all three exits: all
      // settled, deadline, and cancellation. `whenIdle()` promises abandoned at
      // the deadline cannot be cancelled and are harmless remnants, but a live
      // `agent/created` listener would wake a dead closure on every later
      // publication of the session — one leaked listener per timed-out wait.
      for (const stop of watch) stop()
      watch.clear()
    }
    return this.bucketOf(actor, targets, observations, outcome, this.durableView(actor.leader).messages)
  }

  /**
   * Split the observed targets into the three disjoint buckets, from what the
   * window actually saw rather than from one read taken at the end.
   *
   * The buckets are disjoint and their union is exactly `targets`: every target
   * is named once, under the first rule that fits. Rules in order:
   * 1. `settled` — `whenIdle()` resolved, so the member's turn really ended.
   * 2. never `seen`, but the leader's inbox queue holds a report FROM it that
   *    arrived after its latest delivery, or its own log holds a spliced report
   *    from it past that same delivery, or its durable mailbox holds one and
   *    nothing has been addressed to it since — `done`: it finished a turn and
   *    reported back, and the runtime has already reaped its session. "No live
   *    agent" is three different states, and this is the one that used to be
   *    misread as "never started" (a member whose whole turn fits between the
   *    spawn and the first read of a wait leaves exactly this trace).
   * 3. never `seen` and no such report — `cold`: no live agent existed for the
   *    whole window AND neither queue, log, nor mailbox has a word from it, so
   *    nothing observed says it ever finished. It must not fall through to the
   *    quiescence rule.
   * 4. `seen`, and no longer `running` at the end — `done`: resident and
   *    quiescent now (or reaped, which occupies no turn either).
   * 5. `seen` and still `running` — `busy`.
   * @param actor - the team, and the leader whose inbox queue is read.
   * @param targets - the members this wait was asked about, in order.
   * @param observations - the live observation recorded per target, same order.
   * @param outcome - how the race ended.
   * @param mailbox - the leader's durable mailbox feed, newest last.
   * @returns the four-field result.
   */
  private bucketOf(
    actor: Actor,
    targets: readonly WaitTarget[],
    observations: readonly WaitObservation[],
    outcome: 'done' | 'timeout',
    mailbox: readonly TeamMessageView[],
  ): TeamWaitResult {
    const done: string[] = []
    const busy: string[] = []
    const cold: string[] = []
    // Only a target with no live session asks where its report went, so a wait
    // whose members are all accounted for never reads the log at all.
    const reported = observations.some(observation => !observation.seen)
      ? this.reportedInLog(actor, targets)
      : undefined
    targets.forEach((target, index) => {
      const observation = observations[index]!
      if (observation.settled) {
        done.push(target.name)
        return
      }
      if (!observation.seen) {
        // No live session is not one state but three: not started yet, accepted
        // but not published, or already run and reaped. What tells the third
        // apart is a report from THIS member, read from the three places it can
        // be: the leader's inbox queue (accepted but not consumed yet — the state
        // a wait issued in the same turn always finds), the leader's own log (the
        // spliced row the queue was built from and that outlives it), or the
        // leader's durable mailbox (a report that did reach the surface).
        if (reported?.has(target.memberId) === true
          || this.reportedIntoInbox(actor, target.memberId, mailbox)
          || reportedBack(mailbox, target.memberId)) {
          done.push(target.name)
          return
        }
        cold.push(target.name)
        return
      }
      // Re-reading the registry is what keeps a settle that lost the race by one
      // microtask out of `busy`.
      const agent = this.ctx.agents.get(SessionId(target.memberId))
      if (agent === undefined || agent.status !== 'running') {
        done.push(target.name)
        return
      }
      busy.push(target.name)
    })
    return { done, busy, cold, timedOut: outcome === 'timeout' }
  }

  /**
   * The one settle `wait` gives a delivery `team_send` accepted just before it.
   *
   * One fixed delay, never a poll: `team_send` is asynchronous by contract — the
   * prompt is accepted into the recipient's inbox, which may also resume and
   * publish a cold recipient — while `whenIdle()` only answers "is the current
   * activity quiescent". Reading the roster in the same tick as the send would
   * therefore see an idle member whose driver has not started yet. The settle
   * runs before the budget starts, so it never shortens the wait the caller
   * asked for.
   *
   * This window protects a **hot** member whose driver has not started; it is
   * not, and must not be mistaken for, a cold-recovery budget — a resume plus a
   * publish can take seconds, which is why {@link observeIdle} waits for the
   * publication itself instead of relying on this delay.
   * @returns a promise that resolves after one settle window.
   */
  private settle(): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, WAKE_SETTLE_MS) })
  }

  /**
   * Resolve the wait's addresses against this team's roster, in the order given
   * and without duplicates: one member is one target however it was spelled.
   * @param actor - whose roster answers.
   * @param requested - names or ids, or undefined for every member.
   * @returns the targets to observe.
   * @throws {TeamError} `UNKNOWN_MEMBER` for an address this team cannot place,
   *   including `leader`: the leader is the one waiting.
   */
  private waitTargets(actor: Actor, requested: readonly string[] | undefined): readonly WaitTarget[] {
    const addresses = requested ?? [...actor.team.members.values()].map(member => member.memberId)
    const targets: WaitTarget[] = []
    const seen = new Set<string>()
    for (const address of addresses) {
      const recipient = this.resolveRecipient(actor, address)
      if (recipient.kind !== 'member') {
        throw new TeamError('UNKNOWN_MEMBER', `${recipient.name} is the leader, which is the one waiting`)
      }
      if (seen.has(recipient.id)) continue
      seen.add(recipient.id)
      targets.push({ memberId: recipient.id, name: recipient.name })
    }
    return targets
  }

  /**
   * Watch one member until its turn quiesces, recording what was seen of it.
   *
   * Two paths, because a member can be in one of two very different states:
   *
   * - **Resident** (`agents.get()` yields an agent): mark `seen`, then follow
   *   `whenIdle()`. A rejected — or synchronously throwing — idle signal records
   *   as settled too: an unobservable member must not hang the leader's turn, and
   *   the next wait observes it afresh.
   * - **Cold** (no agent yet): do NOT settle. A member with no live agent has not
   *   finished anything, it has not started — settling it here was the bug: a
   *   leader that broadcast to a cold member and waited got "everybody is back"
   *   in one tick. Nothing shorter than the caller's own budget can tell "woken
   *   in a moment" from "never woken", so subscribe to `agent/created` and join
   *   the normal `whenIdle()` path the moment this member is published; if that
   *   never happens, the deadline ends the wait and the target is classified by
   *   what the mailbox says about it: reported back → done, silent → cold.
   *
   * The registry read and the subscription happen in the same tick, with no
   * `await` between them, so a publication cannot slip into the gap: either the
   * read sees it or the subscription hears it.
   * @param target - the roster member to watch.
   * @param observation - this target's live record, updated in place.
   * @param watch - the wait's subscription set, so an ending wait can drop it.
   * @returns the observation promise, which never rejects and, on the cold path,
   *   may never resolve at all — the deadline, not this promise, ends that wait.
   */
  private observeIdle(target: WaitTarget, observation: WaitObservation, watch: WaitWatch): Promise<void> {
    const release = (): void => { observation.settled = true }
    const agent = this.ctx.agents.get(SessionId(target.memberId))
    if (agent !== undefined) {
      observation.seen = true
      return this.idleOf(agent, release)
    }
    return new Promise<void>((resolve) => {
      // Idempotent, because both the wake path and the wait's `finally` run it:
      // it drops the subscription AND its watch entry, so a listener can never
      // outlive the wait that armed it — not on timeout, not on cancellation, and
      // not on the success path where the member finally shows up.
      let unsubscribe: (() => void) | undefined
      const stop = (): void => {
        watch.delete(stop)
        const drop = unsubscribe
        unsubscribe = undefined
        drop?.()
      }
      unsubscribe = this.ctx.on('agent/created', (payload: { agent: Agent }) => {
        if (payload.agent.id !== SessionId(target.memberId)) return
        stop()
        observation.seen = true
        // Deliberately not returned and not awaited: `agent/created` dispatches
        // SERIALLY and the seam forbids a creation listener from awaiting
        // `whenIdle()` — that would hold the member's own creation on the turn it
        // was created to run, which resolves only when that turn ends.
        void this.idleOf(payload.agent, release).then(resolve)
      })
      watch.add(stop)
    })
  }

  /**
   * The harness's own quiescence seam for one live agent, reported as `settled`.
   * A rejection means the member became unobservable; it counts as settled for
   * the same reason the throwing case does — the alternative is a leader's turn
   * held hostage by one member's broken signal.
   * @param agent - the live agent to wait on.
   * @param release - records the member as settled.
   * @returns the observation promise, which never rejects.
   */
  private idleOf(agent: Agent, release: () => void): Promise<void> {
    try {
      return agent.whenIdle().then(release, release)
    } catch {
      release()
      return Promise.resolve()
    }
  }

  /**
   * Race every idle signal against one deadline and the caller's signal.
   *
   * One aggregate race, not one timer per member: who is still running at the
   * deadline is re-read from the registry afterwards, so per-member timers would
   * only duplicate that read. The timer is always cleared and the abort listener
   * always removed, so a wait that ends early leaves nothing armed on the
   * caller's signal.
   *
   * A `whenIdle()` promise abandoned at the deadline or on abort cannot be
   * cancelled — the seam takes no signal — and is a harmless remnant: its `then`
   * only flips a flag on a record the finished wait has already read. Never await
   * it a second time; a fresh wait starts a fresh observation instead. Live
   * `agent/created` subscriptions are NOT harmless and are the caller's to drop
   * as soon as this race ends, on every exit.
   * @param observing - one observation promise per member being watched.
   * @param budget - the deadline in milliseconds, already clamped.
   * @param signal - the caller's cancellation, when it supplied one.
   * @returns `done` when every member settled, `timeout` when the deadline fired.
   * @throws {TeamError} `ABORTED` when the caller's signal fires first.
   */
  private async raceWait(
    observing: readonly Promise<void>[],
    budget: number,
    signal: AbortSignal | undefined,
  ): Promise<'done' | 'timeout'> {
    if (observing.length === 0) return 'done'
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, budget)
    })
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return
      // An abort that landed between the caller's own check and this line would
      // never emit again, so arm nothing and refuse now instead of waiting out
      // the full budget.
      if (signal.aborted) {
        reject(new TeamError('ABORTED', 'team_wait was cancelled before it started waiting'))
        return
      }
      onAbort = () => { reject(new TeamError('ABORTED', 'team_wait was cancelled while it was waiting')) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([Promise.all(observing).then(() => 'done' as const), deadline, cancelled])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Where one acting agent sits in its team: whose workspace it reaches, and
   * how a note it writes is attributed. The leader's own seat carries its
   * session id, so its private pad is addressed exactly like a teammate's.
   * @param agent - the acting leader or teammate.
   * @returns the team's leader id, the actor's own id, and its display name.
   * @throws {TeamError} when the actor is not in a team.
   */
  seatOf(agent: Agent): TeamSeat {
    const actor = this.resolveActor(agent)
    return {
      leaderId: actor.leader.id,
      memberId: actor.member?.memberId ?? actor.leader.id,
      name: actor.member?.name ?? 'leader',
    }
  }

  /**
   * The teammate roster as one teammate should see it, for its prompt section.
   * @param member - the teammate agent.
   * @returns the leader-relative roster, or undefined outside a team.
   */
  rosterFor(member: Agent): { readonly self: TeamMemberFact; readonly others: readonly TeamMemberFact[] } | undefined {
    const actor = this.tryResolveActor(member)
    if (actor?.member === undefined) return undefined
    return {
      self: actor.member,
      others: [...actor.team.members.values()].filter(row => row.memberId !== member.id),
    }
  }

  /** The durable view the leader's log folds to (the projection registry's cached cut). */
  private durableView(leader: Agent): TeamView {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) {
      return foldTeam(leader.session.snapshotEvents(), this.config.maxRecentMessages)
    }
    const value = registry.snapshot(leader.session).values.team
    return value ?? EMPTY_TEAM_VIEW
  }

  /** Live runtime state of one teammate; `ready` means no live agent remains. */
  private statusOf(memberId: string): MemberStatus {
    const agent = this.ctx.agents.get(SessionId(memberId))
    if (agent === undefined) return 'ready'
    return agent.status === 'running' ? 'running' : 'idle'
  }

  /**
   * Resolve the acting agent's team, or fail loud — and say WHICH failure it
   * is. A teammate whose leader session is simply not loaded is not a teammate
   * without a team: every delivery runs on the leader's parent authority, so
   * the mailbox is shut until the leader is back, while the workspace (which
   * needs nobody) stays open. Telling it "no team here yet" would send it to
   * spawn one, which it cannot do.
   */
  private resolveActor(agent: Agent): Actor {
    const actor = this.tryResolveActor(agent)
    if (actor !== undefined) return actor
    const leaderId = agent.session.header.parentSession
    if (agent.session.header.origin === 'subagent'
      && leaderId !== undefined
      && this.ctx.agents.get(leaderId) === undefined) {
      throw new TeamError('LEADER_AWAY')
    }
    throw new TeamError('NO_TEAM')
  }

  /** Resolve the acting agent's team, or report absence. */
  private tryResolveActor(agent: Agent): Actor | undefined {
    if (agent.session.header.origin !== 'subagent') {
      return { leader: agent, team: this.teamOf(agent) }
    }
    const leaderId = agent.session.header.parentSession
    if (leaderId === undefined) return undefined
    const leader = this.ctx.agents.get(leaderId)
    if (leader === undefined) return undefined
    const team = this.teamOf(leader)
    const member = team.members.get(agent.id)
    return member === undefined ? undefined : { leader, team, member }
  }

  /** Resolve one address (member id, member name, or `leader`) to a recipient. */
  private resolveRecipient(actor: Actor, address: string): Recipient {
    const normalized = address.trim()
    if (normalized.length === 0) throw new TeamError('UNKNOWN_MEMBER', address)
    if (normalized === actor.leader.id || normalized.toLowerCase() === 'leader') {
      return { kind: 'leader', id: actor.leader.id, name: 'leader' }
    }
    const byId = actor.team.members.get(normalized)
    if (byId !== undefined) return { kind: 'member', id: byId.memberId, name: byId.name, member: byId }
    const byName = findByName(actor.team, normalized)
    if (byName !== undefined) return { kind: 'member', id: byName.memberId, name: byName.name, member: byName }
    throw new TeamError('UNKNOWN_MEMBER', address)
  }

  /**
   * Resolve one address, a list of them, or the wildcard to the distinct
   * recipients one send must reach, in the order given.
   *
   * The wildcard means "everyone else on this team", which the sender's
   * relation decides: every member for the leader, the leader plus the other
   * members for a peer, and only the leader for a managed member — the one
   * address that relation may reach. The sender is never a recipient of its own
   * wildcard, while an address the sender spelled out for itself is refused
   * later by {@link assertDeliverable} rather than silently dropped: a member
   * that named itself made a mistake worth reporting.
   * @param actor - who is sending, which fixes both the wildcard and self.
   * @param address - one address, the wildcard, or a list mixing the two.
   * @returns the distinct recipients, never empty and never the sender.
   * @throws {TeamError} when an address is unknown (the refusal names that one
   *   address), or when nothing is left to address.
   */
  private resolveRecipients(actor: Actor, address: string | readonly string[]): readonly Recipient[] {
    const addresses = typeof address === 'string' ? [address] : address
    const resolved: Recipient[] = []
    // Ids, because one member is one mailbox however it was spelled: a name, an
    // id, and a second occurrence of either are the same delivery.
    const seen = new Set<string>()
    for (const entry of addresses) {
      const candidates = entry.trim() === WILDCARD_ADDRESS
        ? this.everyoneElse(actor)
        : [this.resolveRecipient(actor, entry)]
      for (const candidate of candidates) {
        if (seen.has(candidate.id)) continue
        seen.add(candidate.id)
        resolved.push(candidate)
      }
    }
    if (resolved.length === 0) {
      throw new TeamError('UNKNOWN_MEMBER', typeof address === 'string'
        ? 'there is nobody else on this team to address'
        : 'the list of recipients is empty')
    }
    return resolved
  }

  /**
   * Everyone the wildcard reaches from this sender: the whole roster for the
   * leader, the leader and the other members for a peer, and the leader alone
   * for a managed member.
   * @param actor - who is sending, and therefore who is left out.
   * @returns the expansion, empty only for a leader with no teammates.
   */
  private everyoneElse(actor: Actor): readonly Recipient[] {
    const leader: Recipient = { kind: 'leader', id: actor.leader.id, name: 'leader' }
    const others: Recipient[] = []
    for (const member of actor.team.members.values()) {
      if (member.memberId === actor.member?.memberId) continue
      others.push({ kind: 'member', id: member.memberId, name: member.name, member })
    }
    if (actor.member === undefined) return others
    if (actor.member.relation === 'managed') return [leader]
    return [leader, ...others]
  }

  /**
   * Refuse one delivery the actor's relation or its own identity forbids. The
   * relation check runs first so a managed member writing to itself is told
   * what it may not do as a managed member, exactly as before.
   */
  private assertDeliverable(actor: Actor, from: Agent, recipient: Recipient): void {
    if (actor.member !== undefined && actor.member.relation === 'managed' && recipient.kind !== 'leader') {
      throw new TeamError('UNAUTHORIZED', `${actor.member.name} is a managed teammate and may only message the leader`)
    }
    if (recipient.id === from.id) throw new TeamError('SELF_MESSAGE')
  }

  /**
   * The chain one send belongs to. A teammate continues the conversation it is
   * working from — that is what turns a peer exchange into one bounded
   * conversation instead of an unbounded sequence of unrelated messages. The
   * leader always opens a fresh chain: its own turns are the user-visible,
   * interruptible convergence point, so a conversation that reached the leader
   * has already converged and the next instruction starts over.
   */
  private chainFor(actor: Actor, from: Agent): TeamChain {
    const inherited = actor.member === undefined ? undefined : actor.team.inbox.get(from.id)
    if (inherited !== undefined) return { chainId: inherited.chainId, hop: inherited.hop + 1 }
    actor.team.started += 1
    return { chainId: `c${actor.team.started}`, hop: 0 }
  }

  /**
   * Refuse a peer delivery this conversation can no longer afford: too many
   * relays deep, one ordered pair talked out, or a verbatim repeat. Nothing
   * here applies to a message addressed to the leader.
   */
  private assertBudget(
    team: TeamState,
    chain: TeamChain,
    fromId: string,
    recipient: Recipient,
    text: string,
  ): void {
    if (chain.hop > this.config.maxChainHops) {
      throw new TeamError('CHAIN_EXHAUSTED', `relay ${chain.hop} of at most ${this.config.maxChainHops}`)
    }
    const record = team.chains.get(chain.chainId)
    if (record === undefined) return
    const edge = edgeKey(fromId, recipient.id)
    if ((record.edges.get(edge) ?? 0) >= this.config.maxChainRoundTrips) {
      throw new TeamError(
        'PING_PONG',
        `${this.config.maxChainRoundTrips} message(s) already went to ${recipient.name} in this conversation`,
      )
    }
    if (record.said.get(edge) === text) throw new TeamError('REPEATED_MESSAGE', recipient.name)
  }

  /** Charge one accepted peer delivery to its chain, and hand the chain on. */
  private recordDelivery(
    team: TeamState,
    chain: TeamChain,
    fromId: string,
    recipient: Recipient,
    text: string,
  ): void {
    if (recipient.kind !== 'member') return
    team.inbox.set(recipient.id, chain)
    let record = team.chains.get(chain.chainId)
    if (record === undefined) {
      record = { edges: new Map(), said: new Map() }
      team.chains.set(chain.chainId, record)
      // Bounded by insertion order: the oldest conversation's enforcement state
      // falls off first, and a conversation that old is not the one looping.
      for (const stale of team.chains.keys()) {
        if (team.chains.size <= CHAIN_MEMORY) break
        team.chains.delete(stale)
      }
    }
    const edge = edgeKey(fromId, recipient.id)
    record.edges.set(edge, (record.edges.get(edge) ?? 0) + 1)
    record.said.set(edge, text)
  }

  /** Deliver one message, choosing the transport the recipient's runtime requires. */
  private async deliver(
    actor: Actor,
    recipient: Recipient,
    content: ContentBlock[],
    signal: AbortSignal,
    chain: TeamChain,
  ): Promise<string> {
    const source = {
      kind: 'team-message',
      form: 'relay',
      senderSessionId: actor.member?.memberId ?? actor.leader.id,
      senderName: actor.member?.name ?? 'leader',
      chainId: chain.chainId,
      hop: chain.hop,
    } as const
    if (recipient.kind === 'leader') {
      // The leader is an ordinary top-level agent: its inbox is the delivery
      // point, exactly as the continuation manager delivers a child's report.
      const message = createUserMessage({ content, source })
      actor.leader.send(message, 'next-turn', true)
      return message.id
    }
    // Before this task can produce a report, freeze what is already queued and
    // how far the log has run: an answer from an earlier round is not evidence
    // that this one finished (see `staleReports` and `deliveredAt`).
    this.markDelivery(actor, recipient.id)
    return await queueHostSubagentPrompt(
      this.ctx.subagents,
      actor.leader,
      SessionId(recipient.id),
      content,
      source,
      signal,
    )
  }

  /**
   * Record the delivery boundary for one member, in both currencies a report
   * can arrive in.
   *
   * A queued message carries no timestamp, so "is this reply about the task I
   * just sent" cannot be read off the queue afterwards. Delivery time is the
   * one moment that answers it: everything queued now belongs to an earlier
   * round, everything queued later is an answer to this one. The same is true
   * of the log, whose splice rows outlive the queue by the whole session: a
   * spliced report is this round's only if it sits after the log position of
   * this delivery. Both are taken BEFORE the delivery is accepted, so nothing
   * queued or spliced afterwards can be mistaken for something older, and both
   * are overwritten on every delivery (only the latest boundary matters).
   *
   * In memory by design: this describes the live queue and this process's own
   * deliveries, not durable state. A team rebuilt from a log has no boundary
   * and admits the whole log, which is right — anything in it predates the
   * restart, so it answers whichever task was delivered before it.
   * @param actor - the team, and the leader whose inbox and log are read.
   * @param memberId - the member the task is being delivered to.
   */
  private markDelivery(actor: Actor, memberId: string): void {
    const stale = new Set<string>()
    for (const message of [...actor.leader.inbox.nextTurn, ...actor.leader.inbox.nextStep]) {
      if (reportSenderOf(message.source) === memberId) stale.add(String(message.id))
    }
    actor.team.staleReports.set(memberId, stale)
    actor.team.deliveredAt.set(memberId, logPositionOf(actor.leader))
  }

  /**
   * Which of these members left a report in the leader's own log.
   *
   * This is the durable half of {@link reportedIntoInbox}, and it exists
   * because the queue is a moment, not a record. A member's completion reaches
   * the leader as a new message on one of its inbox boundaries, which the
   * runtime commits to the log as `agent/inbox/spliced` — `inserted[].source`
   * naming the settling child. The boundary then CONSUMES those messages with a
   * second splice and, when the turn never reaches the boundary's delivery (an
   * interrupt, a cancel), never writes the `user/message` the mailbox folds. So
   * the live queue sees the notice only between the two splices, and the
   * mailbox never sees it at all; the insertion row stays in the log for good.
   *
   * Freshness is the delivery boundary, not the wait: the report that proves a
   * finished member belongs to THIS round sits before the wait (the member
   * finished while the leader was still writing the tool call), so a boundary
   * taken at wait start would discard exactly the evidence it is looking for.
   * {@link TeamState.deliveredAt} is that boundary, and it is the same one the
   * inbox rule uses.
   *
   * One reverse walk serves every target: it starts at the end of the log, stops
   * at the oldest boundary among them, reads each member's own boundary before
   * crediting it, and stops early once every target has been found.
   * @param actor - the team, and the leader whose log is read.
   * @param targets - the members this wait was asked about.
   * @returns the member ids with a report after their own boundary.
   */
  private reportedInLog(actor: Actor, targets: readonly WaitTarget[]): ReadonlySet<string> {
    const floorOf = (memberId: string): number => actor.team.deliveredAt.get(memberId) ?? 0
    const pending = new Set(targets.map(target => target.memberId))
    const reported = new Set<string>()
    if (pending.size === 0) return reported
    const events = actor.leader.session.snapshotEvents()
    // The oldest boundary settles how far back the walk has to go; the absolute
    // bound only matters for a log longer than one scan is worth.
    const floor = Math.min(...targets.map(target => floorOf(target.memberId)))
    const first = Math.max(0, events.length - LOG_REPORT_SCAN_LIMIT)
    for (let index = events.length - 1; index >= first; index -= 1) {
      const event = events[index]!
      if (event.seq < floor) break
      if (event.type !== 'agent/inbox/spliced') continue
      for (const message of event.data.inserted) {
        const sender = reportSenderOf(message.source)
        if (sender === undefined || !pending.has(sender)) continue
        // Before this member's own delivery: an earlier round's answer.
        if (event.seq < floorOf(sender)) continue
        reported.add(sender)
      }
      if (reported.size === pending.size) break
    }
    return reported
  }

  /**
   * Whether this round's completion is already sitting in the leader's inbox.
   *
   * The FAST half of the same question as {@link reportedInLog}, and the one
   * that answers while the notice is still queued: the runtime parks the
   * settlement notice on `next-step` (and a `team_send` reply on `next-turn`),
   * and the leader's log receives it as model-visible input only at the next
   * step boundary — which is AFTER this tool call. So the log alone reports "no
   * live session, no report" for a member that has already answered, while the
   * queue already holds the answer. Once a boundary consumes the notice, the
   * queue is empty and this read is silent; the spliced row is then what
   * remains, and {@link reportedInLog} is the read that finds it.
   *
   * Freshness is the delicate half: a reply that was queued BEFORE the latest
   * delivery belongs to the previous round and says nothing about the task just
   * sent. {@link markDelivery} is the boundary; see
   * {@link TeamState.staleReports}.
   * @param actor - the team, and the leader whose inbox is read.
   * @param memberId - the member whose report is being looked for.
   * @param mailbox - the leader's durable mailbox rows, newest last, used only
   *   when this process never delivered to this member (no freeze boundary).
   * @returns true when the queue holds a report from this member about the
   *   current round.
   */
  private reportedIntoInbox(actor: Actor, memberId: string, mailbox: readonly TeamMessageView[]): boolean {
    const queued: string[] = []
    for (const message of [...actor.leader.inbox.nextTurn, ...actor.leader.inbox.nextStep]) {
      if (reportSenderOf(message.source) === memberId) queued.push(String(message.id))
    }
    if (queued.length === 0) return false
    const stale = actor.team.staleReports.get(memberId)
    if (stale !== undefined) return queued.some(id => !stale.has(id))
    // Nothing was delivered to this member through this live team, so a queued
    // report cannot predate a delivery this process made. The durable mailbox
    // still catches a hydrated delivery: a leader that sent a NEW task in an
    // earlier process has an outbound row nothing has answered yet.
    const mentioned = mailbox.some(row => row.from === memberId || row.to === memberId)
    return !mentioned || reportedBack(mailbox, memberId)
  }

  /**
   * The route this spawn runs on. A request that names its own provider or
   * model wins exactly as given; one that names neither falls back to the
   * deployment's teammate route, so a single `teammateProvider` pair turns
   * every teammate local without overriding a leader that asked for a
   * specific route. Model ids are provider-scoped, so a route change without
   * a model is refused instead of sending the leader's model id to a provider
   * that never advertised it.
   */
  private resolveRoute(leader: Agent, request: TeamSpawnRequest): ResolvedRoute {
    const explicit = request.provider !== undefined || request.model !== undefined
    const provider = explicit
      ? request.provider
      : this.config.teammateProvider === '' ? undefined : this.config.teammateProvider
    const model = explicit
      ? request.model
      : this.config.teammateModel === '' ? undefined : this.config.teammateModel
    if (provider !== undefined && provider !== leader.options.provider && model === undefined) {
      throw new TeamError('MODEL_REQUIRED', provider)
    }
    return {
      ...provider !== undefined ? { provider } : {},
      ...model !== undefined ? { model } : {},
    }
  }

  /**
   * Reject a spawn aimed at a provider this deployment never registered, at
   * spawn rather than on the teammate's first request: the failure would
   * otherwise arrive as an adapter error inside the teammate's own turn,
   * where the leader cannot see it or correct the route.
   */
  private assertProviderRegistered(leader: Agent, provider: string | undefined): void {
    if (provider === undefined || provider === leader.options.provider) return
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    const registered = llm.listProviders()
    // An empty registry means no adapter has mounted yet: the spawn stays the
    // adapter's call rather than refusing every route on a technicality.
    if (registered.length === 0 || registered.some(entry => entry.id === provider)) return
    throw new TeamError(
      'UNKNOWN_PROVIDER',
      `${provider}; registered: ${registered.map(entry => entry.id).join(', ')}`,
    )
  }

  /**
   * Reject a reasoning effort the selected model does not offer, at spawn
   * rather than on the teammate's every later request. Validation needs an
   * exact provider/model route: without one the adapter stays the authority.
   */
  private async assertEffortOffered(
    leader: Agent,
    request: TeamSpawnRequest,
    route: ResolvedRoute,
  ): Promise<void> {
    if (request.reasoningEffort === undefined) return
    const llm = this.ctx.get('llm')
    const provider = route.provider ?? leader.options.provider
    const model = route.model ?? leader.options.model
    if (llm === undefined || provider === undefined || model === undefined) return
    let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
    try {
      info = await llm.resolveModelInfo(provider, model)
    } catch {
      // An unresolvable route stays the adapter's authority; the provider check
      // above already refused the mismatch the leader can act on.
      return
    }
    const offered = info.reasoning?.efforts ?? []
    if (offered.some(effort => effort.id === request.reasoningEffort)) return
    throw new TeamError(
      'UNKNOWN_EFFORT',
      offered.length === 0
        ? `${model} exposes no reasoning efforts`
        : `${model} offers ${offered.map(effort => effort.id).join(', ')}`,
    )
  }

  /**
   * Stop one teammate's current work. Residency belongs to the continuation
   * manager, so dismissal interrupts rather than disposes: an interrupted
   * teammate settles on its own and its session stays readable.
   */
  private stopMember(leader: Agent, memberId: string): void {
    try {
      this.ctx.subagents.interrupt(SessionId(memberId), { kind: 'ancestor', agent: leader })
    } catch (error: unknown) {
      // Swallows only the subagent seam's authorization/absence rejection for
      // one member: dismissal must remove the roster row either way, and an
      // already-settled teammate has nothing left to interrupt.
      this.ctx.logger.warn('dsh-team: interrupt of teammate %s failed: %s', memberId, String(error))
    }
  }

  /** Service teardown: live teams are rebuilt from their logs on next touch. */
  protected stop(): void {
    this.teams.clear()
    this.pending.clear()
  }
}

/** Strip the live-view fields a roster fact does not carry. */
function memberFact(member: TeamMemberView): TeamMemberFact {
  return {
    memberId: member.memberId,
    name: member.name,
    relation: member.relation,
    ...member.role !== undefined ? { role: member.role } : {},
    ...member.provider !== undefined ? { provider: member.provider } : {},
    ...member.model !== undefined ? { model: member.model } : {},
    ...member.effort !== undefined ? { effort: member.effort } : {},
    ...member.skills !== undefined ? { skills: [...member.skills] } : {},
  }
}

/** One ordered pair, as the chain ledger keys it. */
function edgeKey(fromId: string, toId: string): string {
  return `${fromId} ${toId}`
}

/** Case-insensitive roster lookup by display name. */
function findByName(team: TeamState, name: string): TeamMemberFact | undefined {
  const wanted = name.trim().toLowerCase()
  for (const member of team.members.values()) {
    if (member.name.toLowerCase() === wanted) return member
  }
  return undefined
}

/**
 * Did this member's last word in the leader's mailbox come FROM it?
 *
 * A member with no live agent has three possible histories, and the mailbox
 * separates the one that looked like a cold member: it ran, reported back, and
 * was reaped. The test is the LAST row that names the member, not "any row from
 * it": a report from an earlier round must not disguise a delivery that has been
 * addressed to it since, because that delivery may simply not have woken it yet
 * — the over-claim this guard exists for. A row addressed to it therefore
 * outranks any older report of its own.
 *
 * The feed is bounded (`maxRecentMessages`), so an old enough report can be
 * evicted; the target then falls back to `cold`, which under-claims rather than
 * over-claims, and `cold` no longer asserts "never started".
 * @param mailbox - the leader's durable mailbox rows, newest last.
 * @param memberId - the member's session id, which is also a row's `from`.
 * @returns true when the member's most recent mailbox row is its own.
 */
function reportedBack(mailbox: readonly TeamMessageView[], memberId: string): boolean {
  for (let index = mailbox.length - 1; index >= 0; index -= 1) {
    const row = mailbox[index]!
    if (row.from === memberId) return true
    if (row.to === memberId) return false
  }
  return false
}

/**
 * Where the leader's log ends right now: the position a delivery boundary is
 * recorded at, and the line later spliced reports are compared against.
 *
 * It is the session's own `seq` — "the next event's sequence number, always the
 * log length" — so the boundary is a sequence number, exactly like the `seq` on
 * every event it is compared to. One unit on both sides of the comparison means
 * the scan never has to assume that an event's position in the snapshot equals
 * its sequence number.
 * @param leader - the leader whose log the boundary is taken in.
 * @returns the next sequence number the leader's log will use.
 */
function logPositionOf(leader: Agent): number {
  return leader.session.seq
}

/**
 * The sender one queued leader-inbox message is attributed to, or undefined
 * when the message is not a teammate report at all.
 *
 * Two kinds carry a member's report into the leader's inbox:
 * - `team-message`, built by this plugin's `deliver` for an explicit
 *   `team_send` reply (`senderSessionId`, `senderName`, `chainId`, `hop`);
 * - `subagent-settled`, built by the harness's continuation manager when the
 *   child's turn ends (`form: 'notice'`, `summary`, `senderSessionId`). This is
 *   what a member that simply ANSWERS leaves behind — the reported bug's shape.
 * Reading the sender, not the text, is what makes the answer per-member.
 * @param source - the message's durable attribution.
 * @returns the sender's session id, or undefined for any other source.
 */
function reportSenderOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'team-message' && kind !== 'subagent-settled') return undefined
  const sender = record['senderSessionId']
  return typeof sender === 'string' ? sender : undefined
}

/**
 * Clamp one requested wait budget into the window `team_wait` honours: an
 * absent or non-finite value takes the default, and everything else is bounded
 * so that neither a zero (a snapshot wearing a wait's name) nor an hour-long
 * block can surprise the caller.
 * @param requested - the caller's milliseconds, when it gave any.
 * @returns the budget to arm.
 */
function clampWait(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return WAIT_DEFAULT_MS
  return Math.min(Math.max(Math.trunc(requested), 1), WAIT_MAX_MS)
}

/** Short stable task id, unique within one team's live list. */
function taskIdOf(team: TeamState): string {
  let next = team.tasks.size + 1
  while (team.tasks.has(`t${next}`)) next += 1
  return `t${next}`
}

/** The teammate's first turn: who it is, and what the leader asked for. */
function brief(request: TeamSpawnRequest): string {
  const identity = request.role === undefined
    ? `You are ${request.name}, a teammate in this agent team.`
    : `You are ${request.name} (${request.role}), a teammate in this agent team.`
  return [identity, '', 'The leader assigned you this task:', request.task].join('\n')
}
