/**
 * The durable team fold: one leader session's log to {@link TeamView}.
 *
 * Two vocabularies reach this fold, and neither makes the log unreadable
 * without this plugin.
 *
 * The tool paths ride vocabulary the harness already knows: the `meta`
 * (presentationMeta) of this plugin's own `tool/result` events, the structured
 * facts carried in nested `tool/ptc-dispatch` content, and the `user/message`
 * deliveries whose source is `team-message`.
 *
 * Lifecycle changes that no tool call settles — a teammate spawned through the
 * admin route instead of the tool, a relation change, a dismissal — write one
 * {@link TeamMemberRecord} as a plugin record: `plugin:dsh-team/member` via
 * `appendPluginRecord`. A shared task a MEMBER closed is the same kind of fact
 * with the opposite authorship: the close happens in the member's own session,
 * whose log this fold never reads, so it is published to the LEADER's log as a
 * {@link TeamTaskRecord} (`plugin:dsh-team/task`) carrying the same task fact
 * the tool path writes. That is the harness's own compatibility mechanism for
 * out-of-repo plugins: both records are committed with `ignorable: true`, so a
 * reader that does not know the type retains and skips it rather than refusing
 * the log, and neither enters the model-visible surface. Inventing a RELEASED
 * event type would be the unsafe move: a type inside the harness catalog is
 * required-on-read, so a log written here would stop loading once this plugin
 * is gone.
 *
 * All of them are plain JSON on a durable boundary, so this module validates
 * them instead of trusting them.
 *
 * @module dsh-team/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import {
  EMPTY_TEAM_VIEW,
  type TeamBoardEntryView, type TeamMemberView, type TeamMessageView, type TeamRelation,
  type TeamTaskStatus, type TeamTaskView, type TeamView,
} from './contract.ts'
import { readDispatchFact } from './fold-dispatch.ts'

/** Identity and relation facts one settled team tool publishes about a member. */
export interface TeamMemberFact {
  readonly memberId: string
  readonly name: string
  readonly role?: string
  readonly relation: TeamRelation
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly skills?: string[]
}

/**
 * The record name one lifecycle change commits under. The `plugin:` prefix is
 * the harness's out-of-repo plugin namespace; appended through
 * `appendPluginRecord`, the event carries `ignorable: true`.
 */
export const TEAM_MEMBER_RECORD = 'plugin:dsh-team/member'

/**
 * The record name one MEMBER-side change to the shared task list commits under.
 *
 * A member's tool result is written to the MEMBER's session log, which this
 * fold never reads for the leader, so a member that closes its own row
 * (`TeamService.closeTask`) publishes the row to the LEADER's log here.
 * It carries the same `{ team: 'task', task }` fact the leader's own
 * `team_task` result projects: one vocabulary, two transports, one fold.
 */
export const TEAM_TASK_RECORD = 'plugin:dsh-team/task'

/** The plugin-record type grammar, mirrored from the session package. */
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u

/**
 * Read one committed event as a plugin record.
 *
 * Deliberately local rather than `import { pluginRecordOf } from
 * '@deepseek-ai/dsh-session'`: this module is reachable from the BROWSER
 * bundle (`client/TeamToolCard.tsx` parses a tool result's `meta` through
 * {@link readFact}), and a value import there drags the whole session wire
 * graph — session, its dependencies, and their dependencies — into the page.
 * The grammar and the `ignorable` gate are the only two things that read
 * needs, so they are restated here and pinned by tests.
 * @param event - any committed session event, live or restored.
 * @returns the record envelope, or undefined when the event is not an ignorable
 *   plugin-namespaced record.
 */
function pluginRecordOf(event: SessionEvent):
{ readonly type: string; readonly seq: SessionEvent['seq']; readonly time: number; readonly data: unknown } | undefined {
  if (event.ignorable !== true) return undefined
  const type: string = event.type
  if (!PLUGIN_RECORD_TYPE.test(type)) return undefined
  return { type, seq: event.seq, time: event.time, data: event.data }
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
export type TeamMemberRecord =
  | { readonly version: 1; readonly op: 'upsert'; readonly member: TeamMemberFact }
  | { readonly version: 1; readonly op: 'remove'; readonly memberId: string }
  | { readonly version: 1; readonly op: 'ended' }

/**
 * One durable task change a MEMBER made, committed to the leader's log.
 *
 * The payload is deliberately not a new shape: it is the `task` arm of
 * {@link TeamFact}, exactly what the leader's own `team_task` result projects
 * through `presentationMeta`. Reusing it means one validator ({@link readFact}
 * → `readTask`) and one transition (`applyFact`) serve both transports, and a
 * member-driven close cannot drift from a leader-driven update.
 *
 * No `version` field, unlike {@link TeamMemberRecord}: the fact shape carries
 * its own discriminator and `readTask` rejects anything incomplete, so an
 * unknown payload folds to nothing instead of needing an envelope version.
 */
export type TeamTaskRecord = { readonly team: 'task'; readonly task: TeamTaskView }

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-team/member': TeamMemberRecord
    'plugin:dsh-team/task': TeamTaskRecord
  }
}


/**
 * One settled team-tool result, projected through `presentationMeta`. Every
 * arm carries the WHOLE post-change entity, never a delta, so the fold's
 * transition stays trivial and each logged row is self-describing.
 */
export type TeamFact =
  | { readonly team: 'member-added'; readonly member: TeamMemberFact }
  | { readonly team: 'member-updated'; readonly member: TeamMemberFact }
  /** An idempotent `member-added` that keeps the existing `joinedAt`. */
  | { readonly team: 'member-merged'; readonly member: TeamMemberFact }
  | { readonly team: 'member-removed'; readonly memberId: string }
  | { readonly team: 'ended' }
  | {
    readonly team: 'message'
    readonly messageId: string
    readonly to: string
    readonly text: string
    /** Depth of the delivery in its conversation chain. */
    readonly hop?: number
  }
  | { readonly team: 'task'; readonly task: TeamTaskView }
  | { readonly team: 'board'; readonly entries: readonly TeamBoardEntryView[]; readonly at: number }

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrow one logged skill list: names only, blank entries dropped. */
function asSkillNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim())
  return names.length === 0 ? undefined : names
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function asRelation(value: unknown): TeamRelation | undefined {
  return value === 'managed' || value === 'peer' ? value : undefined
}

function asStatus(value: unknown): TeamTaskStatus | undefined {
  return value === 'pending' || value === 'active' || value === 'done' ? value : undefined
}

/** Narrow one logged member fact, or reject it whole. */
function readMember(value: unknown): TeamMemberFact | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const memberId = asText(record['memberId'])
  const name = asText(record['name'])
  const relation = asRelation(record['relation'])
  if (memberId === undefined || name === undefined || relation === undefined) return undefined
  const role = asText(record['role'])
  const provider = asText(record['provider'])
  const model = asText(record['model'])
  const effort = asText(record['effort'])
  const skills = asSkillNames(record['skills'])
  return {
    memberId,
    name,
    relation,
    ...role !== undefined ? { role } : {},
    ...provider !== undefined ? { provider } : {},
    ...model !== undefined ? { model } : {},
    ...effort !== undefined ? { effort } : {},
    ...skills !== undefined ? { skills } : {},
  }
}

/**
 * Narrow one committed plugin record into a roster fact, or reject it.
 *
 * The record is durable JSON that an earlier build of this plugin wrote, so it
 * is validated exactly like the `meta` vocabulary: an unknown version or op,
 * or a member without its required identity, folds to nothing rather than
 * corrupting the view.
 * @param data - the record's committed payload.
 * @returns the fact to apply, or undefined when the record is not this
 *   plugin's current shape.
 */
function readMemberRecord(data: unknown): TeamFact | undefined {
  const record = asRecord(data)
  if (record === undefined || record['version'] !== 1) return undefined
  switch (record['op']) {
    case 'upsert': {
      const member = readMember(record['member'])
      return member === undefined ? undefined : { team: 'member-merged', member }
    }
    case 'remove': {
      const memberId = asText(record['memberId'])
      return memberId === undefined ? undefined : { team: 'member-removed', memberId }
    }
    case 'ended':
      return { team: 'ended' }
    default:
      return undefined
  }
}

/** Narrow one logged task fact, or reject it whole. */
function readTask(value: unknown): TeamTaskView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const taskId = asText(record['taskId'])
  const title = asText(record['title'])
  const status = asStatus(record['status'])
  if (taskId === undefined || title === undefined || status === undefined) return undefined
  const assigneeId = asText(record['assigneeId'])
  const note = asText(record['note'])
  return {
    taskId,
    title,
    status,
    ...assigneeId !== undefined ? { assigneeId } : {},
    ...note !== undefined ? { note } : {},
  }
}

/** Narrow one logged board entry, or reject it whole. */
function readBoardEntry(value: unknown): TeamBoardEntryView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const key = asText(record['key'])
  const authorId = asText(record['authorId'])
  const authorName = asText(record['authorName'])
  const updatedAt = asCount(record['updatedAt'])
  if (key === undefined || authorId === undefined || authorName === undefined || updatedAt === undefined) {
    return undefined
  }
  return { key, authorId, authorName, updatedAt, preview: asText(record['preview']) ?? '' }
}

/** Narrow one logged team fact off a `tool/result` event's `meta`. */
export function readFact(meta: unknown): TeamFact | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  switch (record['team']) {
    case 'member-added':
    case 'member-updated': {
      const member = readMember(record['member'])
      return member === undefined
        ? undefined
        : { team: record['team'] === 'member-added' ? 'member-added' : 'member-updated', member }
    }
    case 'member-removed': {
      const memberId = asText(record['memberId'])
      return memberId === undefined ? undefined : { team: 'member-removed', memberId }
    }
    case 'ended':
      return { team: 'ended' }
    case 'message': {
      const messageId = asText(record['messageId'])
      const to = asText(record['to'])
      if (messageId === undefined || to === undefined) return undefined
      const hop = asCount(record['hop'])
      return {
        team: 'message',
        messageId,
        to,
        text: asText(record['text']) ?? '',
        ...hop !== undefined ? { hop } : {},
      }
    }
    case 'task': {
      const task = readTask(record['task'])
      return task === undefined ? undefined : { team: 'task', task }
    }
    case 'board': {
      const rows = record['entries']
      const at = asCount(record['at'])
      if (!Array.isArray(rows) || at === undefined) return undefined
      const entries = rows.map(readBoardEntry).filter((entry): entry is TeamBoardEntryView => entry !== undefined)
      return { team: 'board', entries, at }
    }
    default:
      // Merge-extensible by construction: a fact written by a newer team
      // plugin folds to nothing rather than corrupting this view.
      return undefined
  }
}

/**
 * Narrow every logged team fact off one `meta` slot.
 *
 * A projection is single-valued by signature — `presentationMeta(args, value)`
 * returns one `JsonValue` — so a call that changes several things at once can
 * only report them by returning a LIST of facts. This reader is what makes that
 * list one event carrying several facts instead of one unreadable blob:
 * a plain object stays the single fact it always was, an array is read entry by
 * entry, and one unreadable entry is skipped rather than voiding the rest — the
 * same tolerance {@link readFact} gives an unknown fact kind.
 * @param meta - the `meta` of one `tool/result`, or a parsed PTC dispatch fact.
 * @returns every fact the slot carries, in order; empty when it carries none.
 */
export function readFacts(meta: unknown): readonly TeamFact[] {
  if (!Array.isArray(meta)) {
    const single = readFact(meta)
    return single === undefined ? [] : [single]
  }
  const facts: TeamFact[] = []
  for (const entry of meta) {
    const fact = readFact(entry)
    if (fact !== undefined) facts.push(fact)
  }
  return facts
}

/** The delivery facts the fold reads off one inbound message source. */
interface IncomingMessage {
  readonly senderSessionId: string
  readonly senderName?: string
  readonly kind: 'message' | 'report' | 'settled'
  /** Chain depth, on this plugin's own deliveries only. */
  readonly hop?: number
}

/**
 * Narrow one delivered message's source into a mailbox row, or reject it.
 *
 * Team deliveries use `team-message`; current continuation messages use
 * `agent-message`; historical report and settlement sources remain readable so
 * existing leader logs keep their mailbox rows. The latter sources can also
 * come from ordinary subagents, so the caller keeps only roster members.
 */
function readIncoming(source: unknown): IncomingMessage | undefined {
  const record = asRecord(source)
  if (record === undefined) return undefined
  const kind = record['kind']
  if (kind !== 'team-message' && kind !== 'agent-message' && kind !== 'subagent-report' && kind !== 'subagent-settled') return undefined
  const senderSessionId = asText(record['senderSessionId'])
  if (senderSessionId === undefined) return undefined
  const senderName = asText(record['senderName'])
  const hop = asCount(record['hop'])
  return {
    senderSessionId,
    ...senderName !== undefined ? { senderName } : {},
    ...hop !== undefined ? { hop } : {},
    kind: kind === 'team-message' || kind === 'agent-message' ? 'message' : kind === 'subagent-report' ? 'report' : 'settled',
  }
}

/** Append one row to the bounded feed. */
function appended(
  messages: readonly TeamMessageView[],
  row: TeamMessageView,
  bound: number,
): TeamMessageView[] {
  const next = [...messages, row]
  return next.length > bound ? next.slice(next.length - bound) : next
}

/** Replace one member in place, or append it when the id is new. */
function upsertMember(
  members: readonly TeamMemberView[],
  member: TeamMemberView,
): TeamMemberView[] {
  const index = members.findIndex(candidate => candidate.memberId === member.memberId)
  if (index < 0) return [...members, member]
  const next = [...members]
  next[index] = member
  return next
}

/** Replace one task in place, or append it when the id is new. */
function upsertTask(tasks: readonly TeamTaskView[], task: TeamTaskView): TeamTaskView[] {
  const index = tasks.findIndex(candidate => candidate.taskId === task.taskId)
  if (index < 0) return [...tasks, task]
  const next = [...tasks]
  next[index] = task
  return next
}

/**
 * Apply every fact one event carried, in order. An event with no readable fact
 * returns `view` itself, which is what keeps the projection registry's
 * reference-equality shortcut working for the single-fact case it has always
 * seen.
 * @param view - the state before this event.
 * @param facts - the facts the event carried, in log order.
 * @param time - the event's stamp.
 * @param bound - mailbox feed length ceiling.
 * @returns the folded view.
 */
function applyFacts(view: TeamView, facts: readonly TeamFact[], time: number, bound: number): TeamView {
  let next = view
  for (const fact of facts) next = applyFact(next, fact, time, bound)
  return next
}

/** Apply one settled team fact to the view. */
function applyFact(view: TeamView, fact: TeamFact, time: number, bound: number): TeamView {
  switch (fact.team) {
    case 'member-added':
      // A settled spawn (re)starts the team: an earlier whole-team end no
      // longer applies to the members that follow it.
      return {
        ...view,
        active: true,
        members: upsertMember(view.members, { ...fact.member, joinedAt: time }),
      }
    case 'member-merged': {
      // The durable path and the tool path both report the same member, and a
      // browser refresh re-folds every row, so this arm MUST be idempotent: an
      // existing row keeps its original `joinedAt`, and folding the same record
      // twice yields the same view. Unlike `member-updated` it also ADDS,
      // because a spawn made through the admin route has no prior row.
      const previous = view.members.find(candidate => candidate.memberId === fact.member.memberId)
      return {
        ...view,
        active: true,
        members: upsertMember(view.members, {
          ...fact.member,
          joinedAt: previous?.joinedAt ?? time,
        }),
      }
    }
    case 'member-updated': {
      const previous = view.members.find(candidate => candidate.memberId === fact.member.memberId)
      if (previous === undefined) return view
      return {
        ...view,
        members: upsertMember(view.members, { ...fact.member, joinedAt: previous.joinedAt }),
      }
    }
    case 'member-removed':
      return {
        ...view,
        members: view.members.filter(candidate => candidate.memberId !== fact.memberId),
      }
    case 'ended':
      return { active: false, members: [], tasks: [], messages: view.messages, board: [] }
    case 'message':
      return {
        ...view,
        messages: appended(view.messages, {
          messageId: fact.messageId,
          to: fact.to,
          kind: 'message',
          text: fact.text,
          time,
          ...fact.hop !== undefined ? { hop: fact.hop } : {},
        }, bound),
      }
    case 'task':
      return { ...view, tasks: upsertTask(view.tasks, fact.task) }
    case 'board':
      // The WHOLE shared area, as of the read or write that published it: the
      // durable workspace lives outside every session log, so the fold records
      // a snapshot rather than pretending to track it.
      return { ...view, board: fact.entries, boardAt: fact.at }
  }
}

/**
 * Apply one inbound delivery to the view, keeping only senders the roster
 * knows: a plain subagent's report is not team traffic.
 */
function applyIncoming(
  view: TeamView,
  incoming: IncomingMessage,
  messageId: string,
  text: string,
  time: number,
  bound: number,
): TeamView {
  if (!view.members.some(member => member.memberId === incoming.senderSessionId)) return view
  return {
    ...view,
    messages: appended(view.messages, {
      messageId,
      from: incoming.senderSessionId,
      kind: incoming.kind,
      text,
      time,
      ...incoming.hop !== undefined ? { hop: incoming.hop } : {},
    }, bound),
  }
}

/** One-line account carried by a `notice`-form source, when it has one. */
function noticeText(source: unknown): string | undefined {
  const record = asRecord(source)
  return record === undefined ? undefined : asText(record['summary'])
}

/** First readable text block of a logged message's content. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] === 'text') return asText(record['text']) ?? ''
  }
  return ''
}

/**
 * Fold one committed event into the team view.
 *
 * Returns the SAME reference for every event this unit does not own — the
 * projection registry treats reference equality as "no downstream work".
 * @param view - the state covering all prior events.
 * @param event - the next committed session event.
 * @param bound - mailbox feed length ceiling.
 * @returns the next view, or `view` itself when nothing changed.
 */
export function applyTeamEvent(view: TeamView, event: SessionEvent, bound: number): TeamView {
  // The durable lifecycle path. It is checked first and by TYPE rather than by
  // `event.type`, because `pluginRecordOf` is also what keeps a foreign
  // `plugin:` record from another package out of this fold.
  const record = pluginRecordOf(event)
  if (record !== undefined && record.type === TEAM_MEMBER_RECORD) {
    const fact = readMemberRecord(record.data)
    return fact === undefined ? view : applyFact(view, fact, event.time, bound)
  }
  // The member-side durable path: a task a teammate closed arrives here, because
  // its own tool result was committed to ITS log. Strict on the fact kind — this
  // record type may only carry a task, so a malformed or future payload folds to
  // nothing instead of reaching a transition it was not meant for.
  if (record !== undefined && record.type === TEAM_TASK_RECORD) {
    const fact = readFact(record.data)
    return fact !== undefined && fact.team === 'task' ? applyFact(view, fact, event.time, bound) : view
  }
  if (event.type === 'tool/result') {
    if (event.data.error !== undefined) return view
    return applyFacts(view, readFacts(event.data.meta), event.time, bound)
  }
  if (event.type === 'user/message') {
    const incoming = readIncoming(event.data.source)
    if (incoming === undefined) return view
    const text = incoming.kind === 'settled'
      ? noticeText(event.data.source) ?? textOf(event.data.content)
      : textOf(event.data.content)
    return applyIncoming(view, incoming, event.data.id, text, event.time, bound)
  }
  if (event.type === 'tool/ptc-dispatch') {
    return applyFacts(view, readFacts(readDispatchFact(view, event.data, event.time)), event.time, bound)
  }
  return view
}

/**
 * Fold a whole log — the cold path used by tests and by a service reading a
 * session the projection registry has not driven.
 * @param events - the session's events, in seq order.
 * @param bound - mailbox feed length ceiling.
 * @returns the folded view.
 */
export function foldTeam(events: readonly SessionEvent[], bound: number): TeamView {
  let view = EMPTY_TEAM_VIEW
  for (const event of events) view = applyTeamEvent(view, event, bound)
  return view
}
