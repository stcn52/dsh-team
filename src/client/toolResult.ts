/**
 * Structured reads of a team tool's result, for the cards that need numbers.
 *
 * A Tool view is handed no typed result value: a settled `ToolResultNode`
 * carries the tool's rendered `content` and its `presentationMeta` as `meta`,
 * nothing else. The wait and dossier tools render for the MODEL, not for this
 * card, so each reader below accepts either source, in this order:
 *
 * 1. `meta`, once a tool starts projecting `presentationMeta` for it — the
 *    wait tool gains one when its result grows a `cold` list, and that upgrade
 *    must land here without a second edit;
 * 2. the rendered text, matched against the sentences those tools print today;
 * 3. nothing. Every field is optional and an unrecognised shape reads as
 *    "absent", so the card degrades to its arguments rather than throwing or
 *    spilling raw JSON into the conversation.
 *
 * The text patterns are a compatibility surface, not a contract. They are
 * pinned against the real `output.render` of `src/tools.ts` in
 * `tests/tool-card-catalog.spec.tsx`, so a wording change fails a test here
 * instead of silently emptying a card.
 *
 * @module dsh-team/client/toolResult
 */

/** One JSON object read off an untyped boundary. */
type Fields = Readonly<Record<string, unknown>>

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A string list, or undefined when the field is not one. An empty list is kept: it is a fact. */
function listed(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((row): row is string => typeof row === 'string' && row !== '')
}

/**
 * The records a presentation fact may hide in: the slot itself, or one of the
 * envelopes a tool commonly wraps it in. Reading all of them keeps this module
 * working when a tool's `presentationMeta` shape is chosen by someone else.
 */
function* candidates(meta: unknown): Generator<Fields> {
  const root = fields(meta)
  if (root === undefined) return
  yield root
  for (const key of ['wait', 'result', 'value', 'report']) {
    const nested = fields(root[key])
    if (nested !== undefined) yield nested
  }
}

/** Read the names listed after one `label:` in a rendered sentence, up to the next `;`. */
function after(label: string, sentence: string): readonly string[] | undefined {
  const marker = `${label}: `
  const at = sentence.indexOf(marker)
  if (at < 0) return undefined
  const rest = sentence.slice(at + marker.length)
  const end = rest.indexOf(';')
  const names = (end < 0 ? rest : rest.slice(0, end)).split(',').map(name => name.trim()).filter(name => name !== '')
  return names.length > 0 ? names : undefined
}

/** What one `team_wait` call reports: who settled, who is still out, and why it ended. */
export interface WaitReport {
  /** Members that had stopped running when the wait ended. */
  readonly done?: readonly string[]
  /** Members still running when the wait gave up. */
  readonly busy?: readonly string[]
  /**
   * Members the wait could not observe because they are no longer resident.
   * A field the wait tool is still growing: read when present, absent otherwise.
   */
  readonly cold?: readonly string[]
  /** Whether the budget ran out instead of everyone settling. */
  readonly timedOut?: boolean
}

function waitRecord(record: Fields): WaitReport | undefined {
  if (!('done' in record) && !('busy' in record) && !('cold' in record) && !('timedOut' in record)) return undefined
  const done = listed(record['done'])
  const busy = listed(record['busy'])
  const cold = listed(record['cold'])
  const timedOut = flag(record['timedOut'])
  return {
    ...done !== undefined ? { done } : {},
    ...busy !== undefined ? { busy } : {},
    ...cold !== undefined ? { cold } : {},
    ...timedOut !== undefined ? { timedOut } : {},
  }
}

/**
 * The wait result, from its fact when a tool projects one and from its rendered
 * sentence otherwise.
 *
 * Three vocabularies are read on purpose. The wait tool renamed its clauses while
 * this card was being written (`settled`/`still running` became
 * `finished`/`still busy`, and `cold` joined as `never started`), and sessions
 * logged before each rename still replay their old sentences through this card.
 * The newest rename is the one that matters most: `never started` claimed a
 * member had not begun, which the wait cannot know (a reaped member may have
 * finished without reporting), so `cold` now reads `no live session` and BOTH
 * labels are recognized.
 * @param meta - the settled call's `meta`, when it has one.
 * @param output - the settled call's text content.
 * @returns every field the source actually carried; unrecognised sources read
 *   as an empty report rather than a guess.
 */
export function waitReport(meta: unknown, output: string): WaitReport {
  for (const candidate of candidates(meta)) {
    const report = waitRecord(candidate)
    if (report !== undefined) return report
  }
  const sentence = output.trim()
  const done = after('finished', sentence) ?? after('settled', sentence)
  const busy = after('still busy', sentence) ?? after('still running', sentence)
  const cold = after('no live session', sentence) ?? after('never started', sentence)
  // `timed out` and `returned early` are the two reasons a wait ends with
  // someone still out; only the first one means the budget ran out.
  const timedOut = /^timed out\b/u.test(sentence) ? true : /^returned early\b/u.test(sentence) ? false : undefined
  return {
    ...done !== undefined ? { done } : {},
    ...busy !== undefined ? { busy } : {},
    ...cold !== undefined ? { cold } : {},
    ...timedOut !== undefined ? { timedOut } : {},
  }
}

/** What one dossier call reports: whose record, its totals, and the one entry a forget dropped. */
export interface DossierReport {
  /** The canonical name the tool resolved the member to. */
  readonly name?: string
  readonly delivered?: number
  readonly reworks?: number
  /** How many entries the dossier holds. */
  readonly entries?: number
  /** The entry id a `team_forget` dropped. */
  readonly removed?: string
  /** How many entries remain after that drop. */
  readonly remaining?: number
  /** The tool answered that this name carries no record at all. */
  readonly empty?: boolean
}

function dossierRecord(record: Fields): DossierReport | undefined {
  const stats = fields(record['stats'])
  const name = text(record['name'])
  const delivered = count(stats?.['delivered']) ?? count(record['delivered'])
  const reworks = count(stats?.['reworks']) ?? count(record['reworks'])
  const rows = record['entries']
  const entries = count(rows) ?? (Array.isArray(rows) ? rows.length : undefined)
  const removed = text(record['removed'])
  const remaining = count(record['remaining'])
  if (name === undefined && delivered === undefined && reworks === undefined && entries === undefined
    && removed === undefined && remaining === undefined) return undefined
  return {
    ...name !== undefined ? { name } : {},
    ...delivered !== undefined ? { delivered } : {},
    ...reworks !== undefined ? { reworks } : {},
    ...entries !== undefined ? { entries } : {},
    ...removed !== undefined ? { removed } : {},
    ...remaining !== undefined ? { remaining } : {},
  }
}

/** `<name>: <n> delivered, <n> reworked[, <n> entries]` — the profile's first line. */
const PROFILE = /^(?<name>[^:\n]+?): (?<delivered>\d+) delivered, (?<reworks>\d+) reworked(?:, (?<entries>\d+) entries)?$/mu

/** `<name> has no dossier yet — nothing recorded under this name`. */
const NO_DOSSIER = /^(?<name>[^:\n]+?) has no dossier yet\b/mu

/** `dropped entry <id>; <n> entries left in the dossier`. */
const DROPPED = /^dropped entry (?<removed>\S+); (?<remaining>\d+) entries left\b/mu

function dossierText(output: string): DossierReport {
  const profile = PROFILE.exec(output)
  if (profile?.groups !== undefined) {
    const name = text(profile.groups['name'])
    return {
      ...name !== undefined ? { name } : {},
      delivered: Number(profile.groups['delivered']),
      reworks: Number(profile.groups['reworks']),
      ...profile.groups['entries'] === undefined ? {} : { entries: Number(profile.groups['entries']) },
    }
  }
  const empty = NO_DOSSIER.exec(output)
  if (empty?.groups !== undefined) {
    const name = text(empty.groups['name'])
    return { ...name !== undefined ? { name } : {}, empty: true }
  }
  const dropped = DROPPED.exec(output)
  if (dropped?.groups !== undefined) {
    const removed = text(dropped.groups['removed'])
    return {
      ...removed !== undefined ? { removed } : {},
      remaining: Number(dropped.groups['remaining']),
    }
  }
  return {}
}

/**
 * One dossier result, from its fact when a tool projects one and from its
 * rendered lines otherwise.
 * @param meta - the settled call's `meta`, when it has one.
 * @param output - the settled call's text content.
 * @returns every field the source actually carried.
 */
export function dossierReport(meta: unknown, output: string): DossierReport {
  for (const candidate of candidates(meta)) {
    const report = dossierRecord(candidate)
    if (report !== undefined) return report
  }
  return dossierText(output)
}
