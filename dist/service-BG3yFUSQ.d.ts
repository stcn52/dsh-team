import z from "@deepseek-ai/schemastery";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionEvent } from "@deepseek-ai/dsh-session";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/config.d.ts
/** Validated team configuration. */
interface TeamConfig {
  /** `ctx.subagents` provider used to materialize teammates (the base bundle registers `spawn`). */
  readonly provider: string;
  /** Ceiling on live roster size for one leader. */
  readonly maxTeammates: number;
  /** Mailbox feed length kept in the durable fold and served to the panel. */
  readonly maxRecentMessages: number;
  /**
   * Relays one teammate-started conversation may take before the mailbox
   * refuses another peer delivery. Escalating to the leader is never refused,
   * so the budget converges a peer exchange instead of ending the work.
   */
  readonly maxChainHops: number;
  /** Messages one ordered member pair may exchange within a single chain. */
  readonly maxChainRoundTrips: number;
  /** Notes one workspace area (the shared board, or one private pad) may hold. */
  readonly maxWorkspaceEntries: number;
  /** Longest single note body. */
  readonly maxNoteChars: number;
  /**
   * Entries one member dossier may hold. Over the bound the oldest
   * non-feedback entry goes first; feedback is only touched when it is all
   * that remains, because the leader's correction is not re-derivable.
   */
  readonly maxDossierEntries: number;
  /** Total entry characters (text plus evidence) one member dossier may hold. */
  readonly maxDossierChars: number;
  /** Longest dossier digest injected into a teammate's system prompt. */
  readonly maxDossierDigestChars: number;
  /**
   * Default LLM provider route for a teammate the leader does not address
   * explicitly. Empty inherits the leader's own route. Set it together with
   * {@link teammateModel} to run every teammate on another route — a locally
   * served model, for instance — without repeating the route on every spawn.
   */
  readonly teammateProvider: string;
  /** Default model id paired with {@link teammateProvider}; empty inherits the leader's. */
  readonly teammateModel: string;
}
/**
 * The row's config schema; the loader validates before the service is built.
 * Every key is defaulted, so a deployment may add the row with no options at
 * all — the input type stays partial while the validated output is complete.
 */
declare const Config: z<Partial<TeamConfig>, TeamConfig>;
//#endregion
//#region src/contract.d.ts
/**
 * The team vocabulary shared by the host half and the browser half: the
 * durable projection value, the mailbox message source, and the relationship
 * model. Types only — the browser bundle imports this module type-only, so it
 * must never grow a runtime import of a host package.
 *
 * @module dsh-team/contract
 */
/** The two relationship levels between the leader and a teammate. */
type TeamRelation = 'managed' | 'peer';
/** Lifecycle of one shared task. */
type TeamTaskStatus = 'pending' | 'active' | 'done';
/** What kind of traffic one mailbox row records. */
type TeamMessageKind =
/** Content one member addressed to another through `team_send`. */
'message' |
/** A teammate's own result, delivered through the continuation settlement message. */
'report' |
/** The runtime's account of a teammate's activation ending. */
'settled';
/** One teammate as the leader's log records it. */
interface TeamMemberView {
  /** The teammate's session id; the address every team tool takes. */
  readonly memberId: string;
  readonly name: string;
  readonly role?: string;
  readonly relation: TeamRelation;
  /** Provider route recorded at spawn, when it differs from the leader's own. */
  readonly provider?: string;
  /** Model route recorded at spawn, when the leader overrode its own. */
  readonly model?: string;
  /** Provider-owned reasoning effort recorded at spawn, when one was requested. */
  readonly effort?: string;
  /** Skill names the leader assigned to this teammate at spawn, in the order given. */
  readonly skills?: string[];
  /** Epoch ms of the spawn that added this member. */
  readonly joinedAt: number;
}
/** One shared task. */
interface TeamTaskView {
  readonly taskId: string;
  readonly title: string;
  /** Assigned teammate; absent means unassigned (leader-held). */
  readonly assigneeId?: string;
  readonly status: TeamTaskStatus;
  /** Closing note recorded by whoever moved the task to `done`. */
  readonly note?: string;
}
/**
 * One mailbox row. `from`/`to` absent means the leader — the projection is
 * served per session, so the owning session needs no id of its own.
 */
interface TeamMessageView {
  readonly messageId: string;
  readonly from?: string;
  readonly to?: string;
  readonly kind: TeamMessageKind;
  readonly text: string;
  readonly time: number;
  /**
   * Depth of this delivery in its conversation chain: 0 is a message the
   * leader started, and every teammate-to-teammate relay adds one. A row
   * without it was written before the plugin recorded chains.
   */
  readonly hop?: number;
}
/**
 * One entry of the team's shared workspace, as the leader's log last recorded
 * it. Only the shared area is ever projected: a member's private pad stays
 * private, including from this panel.
 */
interface TeamBoardEntryView {
  readonly key: string;
  /** Session id of the member that wrote it last. */
  readonly authorId: string;
  readonly authorName: string;
  readonly updatedAt: number;
  /** First non-empty line, bounded — the projection never carries note bodies. */
  readonly preview: string;
}
/** The durable team state folded from one leader session's log. */
interface TeamView {
  /** True once a spawn settled and the team was not ended afterwards. */
  readonly active: boolean;
  readonly members: readonly TeamMemberView[];
  readonly tasks: readonly TeamTaskView[];
  /** Bounded newest-last mailbox feed of leader-visible traffic. */
  readonly messages: readonly TeamMessageView[];
  /**
   * The shared workspace as of the last time the leader read or wrote it.
   * Teammates write straight to the durable workspace, which no session log
   * records, so this index is a snapshot rather than a live view.
   */
  readonly board: readonly TeamBoardEntryView[];
  /** When that snapshot was taken; absent while the leader has never looked. */
  readonly boardAt?: number;
}
/** The empty value every session without a team folds to. */
declare const EMPTY_TEAM_VIEW: TeamView;
/**
 * One delivery's place in a conversation chain. A chain begins whenever the
 * leader addresses a teammate and grows by one hop with every relay a teammate
 * makes off the message it is working from; escalation to the leader always
 * ends it. The pair is what bounds a peer conversation mechanically instead of
 * by prompt — see `src/service.ts`.
 */
interface TeamChain {
  /** Identity of the conversation this delivery belongs to (per leader, per process). */
  readonly chainId: string;
  /** Relays between the chain's first delivery and this one. */
  readonly hop: number;
}
/**
 * Durable attribution for one team mailbox delivery, carried by the recipient's
 * own `user/message` event so the sender survives persistence on both sides.
 */
interface TeamMessageSource extends TeamChain {
  readonly kind: 'team-message';
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay';
  /** Session id of the sending member, or of the leader. */
  readonly senderSessionId: string;
  /** Display name of the sender at delivery time. */
  readonly senderName: string;
}
/** The projection key this plugin owns. */
declare const TEAM_PROJECTION_KEY = "team";
//#endregion
//#region src/fold.d.ts
/** Identity and relation facts one settled team tool publishes about a member. */
interface TeamMemberFact {
  readonly memberId: string;
  readonly name: string;
  readonly role?: string;
  readonly relation: TeamRelation;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly skills?: string[];
}
/**
 * One settled team-tool result, projected through `presentationMeta`. Every
 * arm carries the WHOLE post-change entity, never a delta, so the fold's
 * transition stays trivial and each logged row is self-describing.
 */
type TeamFact = {
  readonly team: 'member-added';
  readonly member: TeamMemberFact;
} | {
  readonly team: 'member-updated';
  readonly member: TeamMemberFact;
} | {
  readonly team: 'member-removed';
  readonly memberId: string;
} | {
  readonly team: 'ended';
} | {
  readonly team: 'message';
  readonly messageId: string;
  readonly to: string;
  readonly text: string;
  /** Depth of the delivery in its conversation chain. */
  readonly hop?: number;
} | {
  readonly team: 'task';
  readonly task: TeamTaskView;
} | {
  readonly team: 'board';
  readonly entries: readonly TeamBoardEntryView[];
  readonly at: number;
};
/**
 * Fold a whole log — the cold path used by tests and by a service reading a
 * session the projection registry has not driven.
 * @param events - the session's events, in seq order.
 * @param bound - mailbox feed length ceiling.
 * @returns the folded view.
 */
declare function foldTeam(events: readonly SessionEvent[], bound: number): TeamView;
//#endregion
//#region src/service.d.ts
/** Live lifecycle of one teammate, as `list_agents` names the same states. */
type MemberStatus = 'running' | 'idle' | 'ready';
/** Traffic one conversation chain has already carried, per ordered pair. */
interface ChainRecord {
  /** Deliveries per `from → to` pair. */
  readonly edges: Map<string, number>;
  /** The last text each ordered pair carried, so a verbatim repeat is refused. */
  readonly said: Map<string, string>;
}
/** The live team of one leader session. */
interface TeamState {
  active: boolean;
  readonly members: Map<string, TeamMemberFact>;
  readonly tasks: Map<string, TeamTaskView>;
  /**
   * The delivery each member is working from. A teammate's own sends inherit
   * it, which is what makes a peer exchange one bounded conversation rather
   * than an unbounded sequence of unrelated messages.
   */
  readonly inbox: Map<string, TeamChain>;
  /** Enforcement state per chain, oldest first and bounded by {@link CHAIN_MEMORY}. */
  readonly chains: Map<string, ChainRecord>;
  /** Monotonic chain counter for this leader's live team. */
  started: number;
}
/** What the leader asks for when spawning one teammate. */
interface TeamSpawnRequest {
  readonly name: string;
  readonly role?: string;
  readonly persona?: string;
  readonly relation: TeamRelation;
  readonly task: string;
  /**
   * LLM provider route for this teammate. Omitted inherits the leader's route
   * (or the deployment's `teammateProvider` default); naming another route is
   * how one teammate runs on a locally served model.
   */
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /**
   * Skills this teammate must load before working. Each member carries only the
   * skills its own job needs; the catalog stays readable, so it may still find
   * more, but the leader's assignment is what it is told to put first.
   */
  readonly skills?: readonly string[];
}
/** One roster row with its live runtime state. */
interface TeamMemberStatusView extends TeamMemberView {
  readonly status: MemberStatus;
}
/** The model-facing team read. */
interface TeamListResult {
  readonly active: boolean;
  readonly members: readonly TeamMemberStatusView[];
  readonly tasks: readonly TeamTaskView[];
  readonly messages: readonly TeamMessageView[];
}
/** Where one member sits: whose workspace it reaches, and how a note is signed. */
interface TeamSeat {
  readonly leaderId: string;
  readonly memberId: string;
  readonly name: string;
}
/** One resolved delivery recipient. */
type Recipient = {
  readonly kind: 'leader';
  readonly id: string;
  readonly name: string;
} | {
  readonly kind: 'member';
  readonly id: string;
  readonly name: string;
  readonly member: TeamMemberFact;
};
/** `Context.team`: roster, mailbox routing, tasks, and team lifecycle. */
declare class TeamService extends Service {
  private readonly config;
  static inject: string[];
  /** Live team per leader session id; rebuilt lazily from that session's log. */
  private readonly teams;
  /** Spawns in flight, keyed by leader session id (team tools never overlap). */
  private readonly pending;
  constructor(ctx: Context, config: TeamConfig);
  /**
   * The live team of one leader, rebuilt from its log on first touch. Nothing
   * is resumed here: a teammate materializes only when a message reaches it.
   * @param leader - the leader session's live agent.
   * @returns the mutable live team state.
   */
  teamOf(leader: Agent): TeamState;
  /**
   * Adopt one continuable child into the team world while its scope is being
   * composed. Called from the teammate setup contribution after the child is
   * published — on cold resume the child is already on the leader's roster,
   * and only a child the roster has never seen can be the spawn currently in
   * flight.
   * @param child - the unpublished child agent.
   * @returns the membership facts, or undefined for a child outside any team.
   */
  adopt(child: Agent): TeamMemberFact | undefined;
  /**
   * Spawn one teammate: a continuable subagent of the leader plus a roster row.
   * @param leader - the acting leader agent.
   * @param request - name, relation, initial task, and optional overrides.
   * @param signal - cancellation owning the operation until the teammate accepts its brief.
   * @returns the new member's durable facts.
   * @throws {TeamError} when the actor cannot lead, or the roster is full.
   */
  spawn(leader: Agent, request: TeamSpawnRequest, signal: AbortSignal): Promise<TeamMemberFact>;
  /**
   * Deliver one mailbox message. The leader may message any teammate; a peer
   * teammate may message the leader or any other teammate; a managed teammate
   * may message only the leader.
   *
   * A teammate-to-teammate delivery also spends chain budget: it continues the
   * conversation its sender is working from, and that conversation may only
   * relay so far and may not repeat one ordered pair. Escalation to the leader
   * spends nothing, so the guard converges a peer exchange without ever
   * trapping a member with something to say.
   * @param from - the acting agent (leader or teammate).
   * @param to - recipient member id or member name; `leader` addresses the leader.
   * @param text - the message content.
   * @param signal - cancellation owning the delivery until inbox acceptance.
   * @returns the accepted message id, the resolved recipient, and the chain it joined.
   * @throws {TeamError} when the actor is outside the team, the recipient is
   *   unknown, the actor's relation forbids the delivery, or the conversation
   *   has spent its budget.
   */
  send(from: Agent, to: string, text: string, signal: AbortSignal): Promise<{
    readonly messageId: string;
    readonly recipient: Recipient;
    readonly chain: TeamChain;
  }>;
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
    readonly taskId?: string;
    readonly title?: string;
    readonly assigneeId?: string;
    readonly status?: TeamTaskStatus;
    readonly note?: string;
  }): TeamTaskView;
  /**
   * Change one teammate's relationship level.
   * @param leader - the acting leader agent.
   * @param target - the teammate's member id or name.
   * @param relation - the new relation.
   * @returns the whole post-change member record.
   * @throws {TeamError} when the actor is not the leader or the member is unknown.
   */
  setRelation(leader: Agent, target: string, relation: TeamRelation): TeamMemberFact;
  /**
   * Dismiss one teammate, or end the whole team when no target is given. A
   * dismissed teammate stops its current turn and stops receiving mail; its
   * durable session stays readable through the subagent catalog.
   * @param leader - the acting leader agent.
   * @param target - the teammate's member id or name; absent ends the team.
   * @returns whether the team ended, plus the dismissed member id when targeted.
   * @throws {TeamError} when the actor is not the leader or the member is unknown.
   */
  dismiss(leader: Agent, target?: string): {
    readonly ended: boolean;
    readonly memberId?: string;
  };
  /**
   * The roster, task list, and recent leader-visible mailbox traffic, from the
   * point of view of any member of the team.
   * @param actorAgent - the acting leader or teammate.
   * @returns the live team read; an inactive team reports empty lists.
   */
  list(actorAgent: Agent): TeamListResult;
  /**
   * Where one acting agent sits in its team: whose workspace it reaches, and
   * how a note it writes is attributed. The leader's own seat carries its
   * session id, so its private pad is addressed exactly like a teammate's.
   * @param agent - the acting leader or teammate.
   * @returns the team's leader id, the actor's own id, and its display name.
   * @throws {TeamError} when the actor is not in a team.
   */
  seatOf(agent: Agent): TeamSeat;
  /**
   * The teammate roster as one teammate should see it, for its prompt section.
   * @param member - the teammate agent.
   * @returns the leader-relative roster, or undefined outside a team.
   */
  rosterFor(member: Agent): {
    readonly self: TeamMemberFact;
    readonly others: readonly TeamMemberFact[];
  } | undefined;
  /** The durable view the leader's log folds to (the projection registry's cached cut). */
  private durableView;
  /** Live runtime state of one teammate; `ready` means no live agent remains. */
  private statusOf;
  /**
   * Resolve the acting agent's team, or fail loud — and say WHICH failure it
   * is. A teammate whose leader session is simply not loaded is not a teammate
   * without a team: every delivery runs on the leader's parent authority, so
   * the mailbox is shut until the leader is back, while the workspace (which
   * needs nobody) stays open. Telling it "no team here yet" would send it to
   * spawn one, which it cannot do.
   */
  private resolveActor;
  /** Resolve the acting agent's team, or report absence. */
  private tryResolveActor;
  /** Resolve one address (member id, member name, or `leader`) to a recipient. */
  private resolveRecipient;
  /**
   * The chain one send belongs to. A teammate continues the conversation it is
   * working from — that is what turns a peer exchange into one bounded
   * conversation instead of an unbounded sequence of unrelated messages. The
   * leader always opens a fresh chain: its own turns are the user-visible,
   * interruptible convergence point, so a conversation that reached the leader
   * has already converged and the next instruction starts over.
   */
  private chainFor;
  /**
   * Refuse a peer delivery this conversation can no longer afford: too many
   * relays deep, one ordered pair talked out, or a verbatim repeat. Nothing
   * here applies to a message addressed to the leader.
   */
  private assertBudget;
  /** Charge one accepted peer delivery to its chain, and hand the chain on. */
  private recordDelivery;
  /** Deliver one message, choosing the transport the recipient's runtime requires. */
  private deliver;
  /**
   * The route this spawn runs on. A request that names its own provider or
   * model wins exactly as given; one that names neither falls back to the
   * deployment's teammate route, so a single `teammateProvider` pair turns
   * every teammate local without overriding a leader that asked for a
   * specific route. Model ids are provider-scoped, so a route change without
   * a model is refused instead of sending the leader's model id to a provider
   * that never advertised it.
   */
  private resolveRoute;
  /**
   * Reject a spawn aimed at a provider this deployment never registered, at
   * spawn rather than on the teammate's first request: the failure would
   * otherwise arrive as an adapter error inside the teammate's own turn,
   * where the leader cannot see it or correct the route.
   */
  private assertProviderRegistered;
  /**
   * Reject a reasoning effort the selected model does not offer, at spawn
   * rather than on the teammate's every later request. Validation needs an
   * exact provider/model route: without one the adapter stays the authority.
   */
  private assertEffortOffered;
  /**
   * Stop one teammate's current work. Residency belongs to the continuation
   * manager, so dismissal interrupts rather than disposes: an interrupted
   * teammate settles on its own and its session stays readable.
   */
  private stopMember;
  /** Service teardown: live teams are rebuilt from their logs on next touch. */
  protected stop(): void;
}
//#endregion
export { Config as _, EMPTY_TEAM_VIEW as a, TeamChain as c, TeamMessageSource as d, TeamMessageView as f, TeamView as g, TeamTaskView as h, foldTeam as i, TeamMemberView as l, TeamTaskStatus as m, TeamFact as n, TEAM_PROJECTION_KEY as o, TeamRelation as p, TeamMemberFact as r, TeamBoardEntryView as s, TeamService as t, TeamMessageKind as u, TeamConfig as v };