import z from "@deepseek-ai/schemastery";
import { SessionEvent } from "@deepseek-ai/dsh-session";
import { Context, Service } from "@deepseek-ai/cordis";
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
 * One durable roster change, as committed to the LEADER's session log.
 *
 * This is this plugin's OWN shape, not the harness's `team/member` payload:
 * that one is a `TeamMemberSnapshot` (id, name, description, provider, context,
 * phase, error) with no `relation`, no `model`, no `effort`, and no `skills`,
 * and its projection parses the payload strictly. Reusing it would either drop
 * the fields the roster is built from or make this plugin's writes poison
 * another plugin's projection. A plugin record keeps the whole
 * {@link TeamMemberFact} and stays invisible to readers that do not know it.
 *
 * Every arm carries the WHOLE post-change entity, never a delta, matching the
 * `team` meta vocabulary: the fold's transition stays trivial and each logged
 * row is self-describing.
 */
type TeamMemberRecord = {
  readonly version: 1;
  readonly op: 'upsert';
  readonly member: TeamMemberFact;
} | {
  readonly version: 1;
  readonly op: 'remove';
  readonly memberId: string;
} | {
  readonly version: 1;
  readonly op: 'ended';
};
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-team/member': TeamMemberRecord;
  }
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
} |
/** An idempotent `member-added` that keeps the existing `joinedAt`. */
{
  readonly team: 'member-merged';
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
  /**
   * Per member: the ids of that member's messages which were ALREADY queued in
   * the leader's inbox when this process last delivered a task to it. Delivery
   * time is the only moment that separates "the reply to the task I just sent"
   * from "an earlier reply nothing has consumed yet", because a queued message
   * carries no timestamp — only its presence. Frozen at delivery, so an old
   * reply can never be read as this round's completion.
   */
  readonly staleReports: Map<string, ReadonlySet<string>>;
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
  readonly deliveredAt: Map<string, number>;
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
/**
 * The durable workspace, narrowed to the one read the team service makes of it.
 *
 * Structural on purpose: the service owns no storage and imports no workspace.
 * A deployment without a storage-domain form simply never attaches a reader,
 * and the board then reads as empty instead of the read failing. The shape
 * matches `TeamWorkspace.index()`, so the composition attaches the workspace
 * itself.
 */
interface TeamBoardReader {
  /**
   * The shared area of one team's workspace, newest first.
   * @param leaderId - the team's leader session id.
   */
  index(leaderId: string): Promise<readonly TeamBoardEntryView[]>;
}
/**
 * {@link TeamListResult} plus the shared board as it is right now.
 *
 * The board is read from the durable workspace, which teammates write without
 * any session log recording it, so it cannot be folded out of the leader's own
 * projection (that one is a snapshot of the last time the leader looked).
 */
interface TeamListView extends TeamListResult {
  readonly board: readonly TeamBoardEntryView[];
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
interface TeamWaitResult {
  /**
   * Members confirmed finished: `whenIdle()` settled during the observation, the
   * member was disposed during it (a reaped agent occupies no turn), the
   * member's round was already over when the wait began — it had no live agent
   * and its report was in the leader's own log past its latest delivery, so it
   * was settled before any observation was armed — the member was seen live
   * during it and was no longer `running` when the wait ended (reaped included),
   * or its session was already gone while the leader held its report: queued in
   * the leader's inbox for this round, spliced into the leader's own log after
   * this round's delivery (the row the queue is built from and outlives it), or
   * already spliced into its durable mailbox.
   */
  readonly done: readonly string[];
  /**
   * Members seen live during the observation that were still `running` at the
   * deadline. Empty unless `timedOut`.
   */
  readonly busy: readonly string[];
  /**
   * Members with no live session at any point during the observation AND no
   * report from them this round — not queued in the leader's inbox, not spliced
   * into the leader's log after this round's delivery, not in its durable
   * mailbox: not resident, cold, or already reaped — and silent.
   * Usually a delivery that has not been woken yet, but possibly a member that
   * finished without writing back, so this is "not confirmed finished", NEVER
   * evidence that the work came back, and never part of `done`.
   */
  readonly cold: readonly string[];
  /** Whether the budget expired before every target settled. */
  readonly timedOut: boolean;
  /**
   * What the members in {@link done} actually handed back, in that same order —
   * the answer itself, not just the fact that one arrived.
   *
   * A `done` bucket alone leaves the leader with a name and no content: it
   * knows a turn ended but not what the member concluded, so it has to ask
   * again (a whole extra round trip) or guess. Every member whose report this
   * wait could actually read contributes one entry here; a member that is
   * finished but left nothing to read (a silent turn, a session reaped with no
   * report in the inbox, the log, or the mailbox) has no entry, so this list is
   * a SUBSET of {@link done} — and {@link busy} and {@link cold} members never
   * appear in it, because nothing of theirs was read.
   */
  readonly reports: readonly TeamWaitReport[];
}
/** One finished member's closing words, as `team_wait` brought them back. */
interface TeamWaitReport {
  /** The member, named exactly as {@link TeamWaitResult.done} names it. */
  readonly member: string;
  /**
   * What it handed back: the text blocks of its report, template lines removed
   * and bounded to {@link WAIT_REPORT_MAX_CHARS} characters. An empty string
   * never appears — a member that produced no text at all has no report here.
   */
  readonly text: string;
}
/** What one caller asks `team_wait` to observe. */
interface TeamWaitRequest {
  /** Member names or ids; omitted means every member of this team. */
  readonly members?: readonly string[];
  /** Wall-clock budget in milliseconds, clamped to `[1, WAIT_MAX_MS]`. */
  readonly timeoutMs?: number;
  /** Caller cancellation: the wait refuses with `ABORTED` instead of a partial read. */
  readonly signal?: AbortSignal;
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
/** One accepted mailbox delivery: the message an inbox took, and its chain. */
interface TeamDelivery {
  /** Identity of the message the recipient's inbox accepted. */
  readonly messageId: string;
  /** Who took it, after address resolution and de-duplication. */
  readonly recipient: Recipient;
  /**
   * The conversation this delivery belongs to. One broadcast shares a single
   * chain, so every recipient inherits the same id and the same depth; each
   * recipient's own replies deepen only its own leg of it.
   */
  readonly chain: TeamChain;
}
/** Every delivery one broadcast made, in address order. */
interface TeamBroadcastResult {
  /** One entry per distinct recipient: the same address twice delivers once. */
  readonly deliveries: readonly TeamDelivery[];
}
/** `Context.team`: roster, mailbox routing, tasks, and team lifecycle. */
declare class TeamService extends Service {
  private readonly config;
  static inject: string[];
  /** Live team per leader session id; rebuilt lazily from that session's log. */
  private readonly teams;
  /** Spawns in flight, keyed by leader session id (team tools never overlap). */
  private readonly pending;
  /**
   * The durable workspace whose shared area backs {@link listWithBoard}.
   * Undefined in a composition without a storage domain, which is why the
   * board read must degrade to empty instead of refusing the roster.
   */
  private boardReader;
  constructor(ctx: Context, config: TeamConfig);
  /**
   * The live team of one leader, rebuilt from its log on first touch. Nothing
   * is resumed here: a teammate materializes only when a message reaches it.
   * @param leader - the leader session's live agent.
   * @returns the mutable live team state.
   */
  teamOf(leader: Agent): TeamState;
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
  private publish;
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
  send(from: Agent, to: '*', text: string, signal: AbortSignal): Promise<TeamBroadcastResult>;
  send(from: Agent, to: readonly string[], text: string, signal: AbortSignal): Promise<TeamBroadcastResult>;
  /** A single address, answered with the one delivery it made. */
  send(from: Agent, to: string, text: string, signal: AbortSignal): Promise<TeamDelivery>;
  send(from: Agent, to: string | readonly string[], text: string, signal: AbortSignal): Promise<TeamDelivery | TeamBroadcastResult>;
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
   * Attach — or detach — the durable workspace the shared board is read from.
   *
   * Called by the composition once the storage domain is open, and called with
   * `undefined` when that form is disposed: the service outlives the domain, so
   * a stale reader would otherwise keep a later `team_list` reading a closed
   * table.
   * @param reader - the workspace, or undefined to detach it.
   */
  attachWorkspace(reader: TeamBoardReader | undefined): void;
  /**
   * The roster, task list, and recent leader-visible mailbox traffic, from the
   * point of view of any member of the team.
   * @param actorAgent - the acting leader or teammate.
   * @returns the live team read; an inactive team reports empty lists.
   */
  list(actorAgent: Agent): TeamListResult;
  /**
   * {@link list} plus the team's shared board as it is RIGHT NOW.
   *
   * `list()` stays synchronous because two host seams it must serve are
   * synchronous — the teammate briefing's `systemPrompt.section` text and the
   * team-mode tool guard — while the board can only be read asynchronously from
   * the durable workspace. That is why the live board is this additive read
   * rather than a field `list()` fills: the roster keeps working for every
   * synchronous caller, and `team_list` — the one call a leader reads to see
   * what its team left behind — gets the live index.
   *
   * The read degrades instead of failing. `team_list` is a read, and a leader
   * must keep its roster when the board is unreadable (no storage domain at all,
   * a domain that failed to open, a disposed workspace): those all answer an
   * empty board. The tradeoff is deliberate — an unreadable board and an empty
   * one read the same here, and the roster stays available.
   * @param actorAgent - the acting leader or teammate.
   * @returns the live team read plus the shared board, newest first.
   */
  listWithBoard(actorAgent: Agent): Promise<TeamListView>;
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
   * - `whenIdle()` settling → `done`. So does a cold target whose report was
   *   already in the log past its own delivery when the wait began: it is
   *   settled before any observation is armed (see {@link presettleReported}).
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
   * That last sentence holds for a member with nothing on its record — and not
   * for one whose round is already provably over. A member reaped BEFORE the
   * wait began leaves the report that says so in the log, yet the cold path would
   * still spend the whole budget on an `agent/created` that can never come: the
   * right answer at the deadline, which the host trace showed as 20 037 ms for a
   * round that had finished at 1.1 s. So before one listener is armed, the same
   * delivery-bounded log judgement is applied once to the cold targets and a hit
   * is settled on the spot (see {@link presettleReported}). A finished-and-reaped
   * round then answers in milliseconds, while a member that never started still
   * gets the full window — nothing on its record says otherwise, and no report of
   * an earlier round can stand in for this one.
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
  wait(actorAgent: Agent, request?: TeamWaitRequest): Promise<TeamWaitResult>;
  /**
   * Settle, before anything is watched, the members whose round already ended —
   * the half of the reaped-member problem that a disposal race cannot reach.
   *
   * {@link observeIdle} races `whenIdle()` against `agent/disposed`, which covers
   * a member reaped DURING the wait. It cannot cover a member reaped BEFORE it:
   * the wait begins with no live agent, takes the cold path, subscribes to an
   * `agent/created` that will never fire for a session that is already gone, and
   * sits out the whole budget — after which {@link bucketOf} finally reads the
   * spliced report that was in the log from the first millisecond (20 037 ms
   * against a 20 000 ms budget in the host trace that found this). The answer was
   * right; only its arrival time was wrong.
   *
   * So the durable judgement is taken here as well, BEFORE the observation, and
   * a hit becomes a `settled` observation with nothing armed behind it. The
   * judgement itself is not new: it is {@link reportedInLog}, the very read
   * {@link bucketOf} does at the deadline, reused so both moments can never
   * disagree.
   *
   * Why this cannot over-claim, and how it differs from the "no live agent means
   * done" shortcut that was wrong:
   *
   * - **Only cold targets are eligible.** A resident member is answered by
   *   `whenIdle()` within the tick anyway, so pre-settling it buys nothing — and
   *   would be a false claim for one that already replied and is now running the
   *   next turn. Eligibility is a live registry read, so an agent published
   *   between the settle window and this line is left to the normal path.
   * - **The freshness boundary is the delivery, not the precheck.** A hit needs a
   *   spliced report from THIS member at or after `deliveredAt.get(memberId)` —
   *   the watermark {@link markDelivery} wrote before the prompt was accepted.
   *   The unbounded version of this rule ("it has any report at all") would
   *   settle a member whose previous round's answer is in the log but whose next
   *   task has not woken it yet, which is exactly the over-claim this boundary
   *   exists to stop. Reusing the same watermark means the precheck and the
   *   deadline judgement are the same question asked earlier.
   * - **The target belongs to this wait.** The walk is restricted to the members
   *   this call resolved, and credits a spliced row only to the sender its
   *   `source` names — never to whoever happens to be waiting.
   *
   * A miss settles nothing and changes nothing: the target goes on to
   * {@link observeIdle} exactly as before, resident or cold.
   * @param actor - the team, and the leader whose log and watermark are read.
   * @param targets - the members this wait was asked about, in order.
   * @param observations - this wait's per-target records, updated in place.
   */
  private presettleReported;
  /**
   * Split the observed targets into the three disjoint buckets, from what the
   * window actually saw rather than from one read taken at the end.
   *
   * The buckets are disjoint and their union is exactly `targets`: every target
   * is named once, under the first rule that fits. Rules in order:
   * 1. `settled` — `whenIdle()` resolved, so the member's turn really ended, or
   *    it was pre-settled because its round was already over when the wait began
   *    (no live agent, and its report past its delivery in the log).
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
   *
   * Every member that lands in `done` also gets {@link reportOf} asked what it
   * said, and the answer goes into `reports` when there is one. That read is
   * taken from the same evidence the bucket itself rests on — one inbox walk,
   * one log walk, and the mailbox — so the report a leader receives can never
   * belong to a different round than the completion it is attached to.
   * @param actor - the team, and the leader whose inbox queue is read.
   * @param targets - the members this wait was asked about, in order.
   * @param observations - the live observation recorded per target, same order.
   * @param outcome - how the race ended.
   * @param mailbox - the leader's durable mailbox feed, newest last.
   * @returns the four buckets, whether time ran out, and what the done members
   *   handed back.
   */
  private bucketOf;
  /**
   * What one finished member handed back, from the first place that has it.
   *
   * The order is the order the evidence outlives itself: the live inbox queue
   * (the newest thing the member said, still unconsumed), then the spliced rows
   * in the leader's own log (the durable form of the same message, and the only
   * trace left once a boundary consumed the notice), then the durable mailbox
   * row (a report that reached the surface and survived a restart; its text is
   * the delivered message or the notice's own summary), and finally whatever the
   * message's `source.summary` carried — the one-line account a settlement
   * notice keeps when the member's closing text was empty.
   *
   * A member that is `done` because `whenIdle()` settled has no guaranteed report
   * at all: it may have answered, and it may have said nothing. Both are answered
   * here without a claim — nothing found means no entry in `reports`.
   * @param actor - the team, and the leader whose inbox and log are read.
   * @param target - the finished member.
   * @param mailbox - the leader's durable mailbox feed, newest last.
   * @param logged - the log reports, resolved lazily and only when reached.
   * @returns the report text, or undefined when the member left nothing to read.
   */
  private reportOf;
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
  private settle;
  /**
   * Resolve the wait's addresses against this team's roster, in the order given
   * and without duplicates: one member is one target however it was spelled.
   * @param actor - whose roster answers.
   * @param requested - names or ids, or undefined for every member.
   * @returns the targets to observe.
   * @throws {TeamError} `UNKNOWN_MEMBER` for an address this team cannot place,
   *   including `leader`: the leader is the one waiting.
   */
  private waitTargets;
  /**
   * Watch one member until its turn quiesces, recording what was seen of it.
   *
   * Two paths, because a member can be in one of two very different states:
   *
   * - **Resident** (`agents.get()` yields an agent): mark `seen`, then follow
   *   `whenIdle()` — or the agent's disposal, whichever comes first: a reaped
   *   agent never settles its idle promise, and waiting out the budget for it
   *   would answer correctly but slowly. A rejected — or synchronously throwing —
   *   idle signal records as settled too: an unobservable member must not hang
   *   the leader's turn, and the next wait observes it afresh.
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
  private observeIdle;
  /**
   * The harness's own quiescence seam for one live agent, reported as `settled`,
   * raced against that agent's disposal.
   *
   * `whenIdle()` alone is not enough on this runtime: the harness disposes a
   * teammate's agent when its turn is over and its session is reaped, and a
   * disposed agent never settles the idle promise it handed out. A wait that
   * raced only `whenIdle()` therefore sat out its whole budget and then read the
   * registry to find the member correctly gone — the right answer at the wrong
   * time (20 041 ms against a 20 000 ms budget in the host trace that found
   * this). A disposed agent occupies no turn, so its disposal is a finish signal
   * of its own: it releases the member at once.
   *
   * A rejection — or a synchronous throw — also counts as settled for the same
   * reason the throwing case does: the alternative is a leader's turn held
   * hostage by one member's broken signal.
   *
   * The subscription is dropped idempotently on all four exits — `whenIdle()`
   * settling, disposal, the deadline, and the caller's cancellation — because
   * the wait's `finally` calls the same `stop` every other watch entry uses. A
   * `whenIdle()` promise abandoned at the deadline cannot be cancelled and is
   * harmless: its `then` runs `stop` a second time, which is a no-op, and flips
   * a flag on a record the finished wait has already read.
   * @param agent - the live agent to wait on.
   * @param release - records the member as settled.
   * @param watch - the wait's subscription set, so an ending wait can drop this.
   * @returns the observation promise, which never rejects.
   */
  private idleOf;
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
   * `agent/created` and `agent/disposed` subscriptions are NOT harmless and are
   * the caller's to drop as soon as this race ends, on every exit.
   * @param observing - one observation promise per member being watched.
   * @param budget - the deadline in milliseconds, already clamped.
   * @param signal - the caller's cancellation, when it supplied one.
   * @returns `done` when every member settled, `timeout` when the deadline fired.
   * @throws {TeamError} `ABORTED` when the caller's signal fires first.
   */
  private raceWait;
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
  private resolveRecipients;
  /**
   * Everyone the wildcard reaches from this sender: the whole roster for the
   * leader, the leader and the other members for a peer, and the leader alone
   * for a managed member.
   * @param actor - who is sending, and therefore who is left out.
   * @returns the expansion, empty only for a leader with no teammates.
   */
  private everyoneElse;
  /**
   * Refuse one delivery the actor's relation or its own identity forbids. The
   * relation check runs first so a managed member writing to itself is told
   * what it may not do as a managed member, exactly as before.
   */
  private assertDeliverable;
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
  private markDelivery;
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
  private reportedInLog;
  /**
   * The same reverse walk as {@link reportedInLog}, keeping each member's NEWEST
   * report instead of only the fact that one exists.
   *
   * The wait asks this walk two things at once — "did it report" (the bucket)
   * and "what did it say" (the report text) — and they must be answered from one
   * scan: two scans would stamp two different sets of freshness evidence onto
   * one answer. Walking backwards makes the newest row the first hit for its
   * sender, so the message kept per member is the one the leader would read next
   * anyway.
   * @param actor - the team, and the leader whose log is read.
   * @param targets - the members this wait was asked about.
   * @returns the newest spliced report per member id, past its own boundary.
   */
  private logReportMap;
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
  private reportedIntoInbox;
  /**
   * The queued messages this member left in the leader's inbox about THIS round
   * — the same read as {@link reportedIntoInbox}, keeping the messages instead
   * of only counting them.
   *
   * The wait needs both halves of one question from the same read: whether a
   * report exists (which decides the bucket) and what it says (which is the
   * answer the bucket is worth having). Splitting them into two walks would let
   * the two disagree about freshness, which is the one thing the boundary is
   * there to decide.
   * @param actor - the team, and the leader whose inbox is read.
   * @param memberId - the member whose reports are being collected.
   * @param mailbox - the leader's durable mailbox rows, newest last, used only
   *   when this process never delivered to this member (no freeze boundary).
   * @returns the queued messages, oldest first; empty when none is this round's.
   */
  private freshQueuedReports;
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