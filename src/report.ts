/**
 * How a delivered message becomes a REPORT: the one place the team decides what
 * a finished member actually said, and how much of it a tool result may carry.
 *
 * This seam is lifted out of `./service.ts` for a reason the wait made concrete:
 * reporting is now a DECISION, not a label. `team_wait` counts a member done only
 * when something readable exists (see `TeamService.bucketOf`), so the function
 * that answers "what did it say" also answers "is this member finished". Keeping
 * that judgement, the settlement-template stripping, and the size bound in one
 * small module means the two uses cannot drift: the bucket and the text are read
 * through the same code path, with the same freshness evidence supplied by the
 * caller.
 *
 * Everything here is pure and dependency-free apart from the message types: it
 * reads a `UserMessage` (a queued notice, a spliced log row, a relayed
 * `team_send`) or a durable mailbox row, and returns text or undefined. It never
 * touches the team state, the registry, or the clock — the caller decides when to
 * ask, this module only decides what the answer is.
 *
 * @module dsh-team/report
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { TeamMessageView } from './contract.ts'

/**
 * Longest report text one `team_wait` answer carries, in characters.
 *
 * A finished member's closing message is the answer the leader was waiting for,
 * but a tool result becomes model-visible context on every later step of that
 * turn, so one verbose member could otherwise spend a whole context window on
 * its own transcript — and a wait over five members multiplies that by five.
 * The deadline is `WAIT_REPORT_MAX_CHARS` per report, head kept, tail replaced
 * by `…` (see {@link truncateReport}): the conclusion of a report starts where
 * the report starts, while the part that overflows is nearly always the
 * supporting detail a leader that needs it can ask for with one more message.
 */
export const WAIT_REPORT_MAX_CHARS = 2000

/**
 * The line the continuation manager puts in front of a settled child's own
 * closing words (`createSettlementMessage` in `@deepseek-ai/dsh-subagent`).
 * Everything after it is the member's text; everything before it is the
 * runtime's template, which is exactly what a report must not carry.
 */
const CLOSING_MARKER = 'Its closing message:'

/** What the same notice says instead of {@link CLOSING_MARKER} for a silent child. */
const NO_CLOSING_MESSAGE = 'It left no closing message.'

/** The line the same notice appends for a structured return value. */
const STRUCTURED_PREFIX = 'Structured result: '

/**
 * What every arm of the settlement template opens with.
 *
 * `settlementSummary()` in
 * `@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js` builds its line
 * as `Background subagent <childId>` plus one ending per `stopReason`, so this
 * subject — not any of the endings — is the part all of them share. It is the
 * only detector that survives the producer's own size bound: the notice stores
 * `boundContextSummary(summary)`, capped at `CONTEXT_SUMMARY_MAX_CHARS` (120)
 * with an ellipsis, which can cut the ending off a long child id while the
 * subject, at 20 characters, is always there.
 */
const SETTLEMENT_SUBJECT = 'Background subagent'

/**
 * The sentence one arm of that template ends with (a `completed`, continuable
 * child). Kept beside the subject because a re-shaped notice may carry the
 * sentence without opening with the subject, and because naming it is how the
 * next reader finds the phrase the first host trace happened to show.
 */
const SETTLEMENT_FINISHED = 'finished and will do no further work'

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
export function reportedBack(mailbox: readonly TeamMessageView[], memberId: string): boolean {
  for (let index = mailbox.length - 1; index >= 0; index -= 1) {
    const row = mailbox[index]!
    if (row.from === memberId) return true
    if (row.to === memberId) return false
  }
  return false
}

/**
 * The LAST mailbox row this member wrote, whose text is what it said.
 *
 * Mailbox rows are the durable surface: a report that reached the leader in an
 * earlier process is still here after a restart, with the delivered text (a
 * `team_send` reply) or the notice's one-line account on it. It is read LAST,
 * because a live queue or a spliced row is the same message with its full
 * content; this one is the fallback for the case where neither was observed.
 * @param mailbox - the leader's durable mailbox rows, newest last.
 * @param memberId - the member's session id, which is also a row's `from`.
 * @returns its newest own row, or undefined when it has none.
 */
export function mailboxRowOf(mailbox: readonly TeamMessageView[], memberId: string): TeamMessageView | undefined {
  for (let index = mailbox.length - 1; index >= 0; index -= 1) {
    const row = mailbox[index]!
    if (row.from === memberId) return row
  }
  return undefined
}

/**
 * What one member's delivered message says, with the runtime's template removed
 * and the result bounded to {@link WAIT_REPORT_MAX_CHARS}.
 *
 * The content is read as blocks because that is what a message is: every `text`
 * block is the member's own words and they are joined with newlines, while a
 * non-text block (an image, an attachment) cannot be carried through a tool
 * result at all — it is skipped and counted, and the count is stated in the text
 * so the leader knows something was dropped rather than silently losing it.
 *
 * Two shapes arrive here, and only one of them is templated:
 * - a `team_send` relay (`team-message`), whose content IS what the member wrote;
 * - a settlement notice (`subagent-settled`), which the harness builds as
 *   `summary`, then `Its closing message:`, then the child's closing text, then
 *   possibly `Structured result: …` and a diagnostic. The member's words are
 *   what sits after the marker — everything before it is the runtime speaking
 *   about the member, and a report that carried it would attribute a template
 *   sentence to the teammate.
 *
 * A member that has not reported yet must answer `undefined` here, and so must a
 * member that settled without leaving any words: this function reports what the
 * member said, and neither of them said anything. The notice's `summary` is the
 * runtime's OWN sentence (`settlementSummary()`), so using it as a fallback —
 * which this function used to do whenever the body was empty — handed a template
 * back as an answer and put a member that had said nothing into `done`. The
 * fallback is therefore conditional: it is used only when the summary is an
 * account rather than the template (see {@link isSettlementTemplate}), and with
 * nothing readable the caller learns there is no report, which is what keeps the
 * member out of `done`.
 * @param message - one delivered message, from the inbox queue or a spliced row.
 * @returns the report text, or undefined when the message carries nothing.
 */
export function reportTextOf(message: UserMessage): string | undefined {
  const texts: string[] = []
  let omitted = 0
  for (const block of message.content) {
    if (block.type !== 'text') {
      omitted += 1
      continue
    }
    if (block.text.trim() !== '') texts.push(block.text)
  }
  const source = typeof message.source === 'object' && message.source !== null
    ? message.source as Record<string, unknown>
    : undefined
  const summary = typeof source?.['summary'] === 'string' && source['summary'].trim() !== ''
    ? source['summary'].trim()
    : undefined
  const templated = source?.['kind'] === 'subagent-settled'
  const body = templated ? settlementReport(texts, summary) : texts.join('\n').trim()
  if (body === undefined) return undefined
  return truncateReport(omitted === 0 ? body : `${body}\n${nonTextNote(omitted)}`)
}

/**
 * Is this text the runtime's own settlement template rather than something the
 * member wrote?
 *
 * Both halves are needed. The subject catches every arm of `settlementSummary()`
 * — completed (continuable or not), aborted, max-tokens, refusal, error, and the
 * merge-extensible default — including the arms whose ending the notice's
 * 120-character bound has cut off. The finished sentence catches a notice that
 * carries the ending without opening with the subject. Neither test can fire on
 * a `team_send` relay: this decision is only reached for `subagent-settled`.
 * @param text - one line the runtime wrote about the member, or the member's own.
 * @returns true when the text is the template.
 */
function isSettlementTemplate(text: string): boolean {
  const line = text.trim()
  return line.startsWith(SETTLEMENT_SUBJECT) || line.includes(SETTLEMENT_FINISHED)
}

/**
 * What a settlement notice says in the member's own words, or undefined when it
 * says nothing of the member's.
 *
 * The body is read first, because the body is where the member's words are. It
 * is emptied of the runtime's opening line BEFORE {@link closingWords} looks for
 * the marker ({@link withoutSettlementLine}), which matters in the one shape the
 * identity test cannot catch: the notice's `summary` is the bounded projection
 * of the same line, so a long child id makes the summary a prefix of the block
 * and the block then survives a `line !== summary` filter — a half template
 * reported as an answer. Whatever the marker slicing leaves is the member's own
 * text, and only non-empty text is a report.
 *
 * The summary is the fallback for a notice whose member left no closing text at
 * all — and only when it is an account, not the template. A silent child whose
 * summary is `Background subagent … finished…` is a finished member with nothing
 * to hand back, so it answers `undefined`; a notice built by a caller that puts
 * its own account there still reports that account.
 * @param texts - the message's non-empty text blocks, in order.
 * @param summary - the notice's own one-line account, when it has one.
 * @returns the member's words, or undefined when there are none.
 */
function settlementReport(texts: readonly string[], summary: string | undefined): string | undefined {
  const own = texts.map(withoutSettlementLine).filter(text => text !== '')
  const closing = closingWords(own, summary)
  if (closing !== '' && !isSettlementTemplate(closing)) return closing
  if (summary === undefined) return undefined
  const account = withoutSettlementLine(summary)
  return account === '' ? undefined : account
}

/**
 * One text the runtime wrote, with its own opening line removed.
 *
 * Three shapes reach this function. The opening line alone — every arm of the
 * template, whether or not the size bound truncated its ending — contributes
 * nothing, so it becomes the empty string and the caller drops it. The opening
 * line with the member's closing words stuck to it, which a notice whose blocks
 * were joined produces, keeps everything after the line. Any other text — the
 * marker, the member's body, a diagnostic — is returned unchanged, because
 * removing it is not this function's judgement to make: the marker and the
 * runtime's trailers are {@link closingWords}'s, and they are already its.
 * @param text - one text block or the notice's summary.
 * @returns the member-owned remainder, or an empty string when none is left.
 */
function withoutSettlementLine(text: string): string {
  if (!isSettlementTemplate(text)) return text
  const marker = text.indexOf(CLOSING_MARKER)
  const remainder = marker >= 0 ? text.slice(marker + CLOSING_MARKER.length) : text
  return remainder
    .split('\n')
    .filter(line => !isSettlementTemplate(line)
      && line !== NO_CLOSING_MESSAGE
      && !line.startsWith(STRUCTURED_PREFIX))
    .join('\n')
    .trim()
}

/**
 * The member's own words inside one settlement notice, template removed.
 *
 * The marker is the precise half: `Its closing message:` is what the continuation
 * manager puts directly in front of the child's text, so slicing at it cannot
 * mistake a member's sentence for a template line, and the two runtime trailers
 * after the child's words (`Structured result: …`, a diagnostic) are dropped by
 * what they are. Stripping lines by pattern is only the fallback, for a notice
 * that carries no marker at all (an older row, or a re-shaped notice whose writer
 * kept the summary but dropped the separator).
 * @param texts - the message's non-empty text blocks, in order.
 * @param summary - the notice's own one-line account, when it has one.
 * @returns the member's words, or an empty string when it wrote none.
 */
function closingWords(texts: readonly string[], summary: string | undefined): string {
  const marker = texts.indexOf(CLOSING_MARKER)
  if (marker >= 0) {
    return texts
      .slice(marker + 1)
      .filter(line => !line.startsWith(STRUCTURED_PREFIX) && line !== NO_CLOSING_MESSAGE)
      .join('\n')
      .trim()
  }
  return texts
    .filter(line => line !== summary && line !== NO_CLOSING_MESSAGE && !line.startsWith(STRUCTURED_PREFIX))
    .join('\n')
    .trim()
}

/** How a skipped block is disclosed inside the report text. */
function nonTextNote(count: number): string {
  return `[+${count} non-text block${count === 1 ? '' : 's'} omitted]`
}

/**
 * Bound one report to {@link WAIT_REPORT_MAX_CHARS}, head kept and the cut marked.
 *
 * The ellipsis is inside the bound, not after it, so the ceiling is one number a
 * caller can rely on; `…` rather than a sentence of our own keeps the truncation
 * visible without pretending to be the member's own words.
 * @param text - the report text, of any length.
 * @returns the text itself when it fits, else its head and `…`.
 */
export function truncateReport(text: string): string {
  if (text.length <= WAIT_REPORT_MAX_CHARS) return text
  return `${text.slice(0, WAIT_REPORT_MAX_CHARS - 1)}…`
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
export function reportSenderOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'team-message' && kind !== 'subagent-settled') return undefined
  const sender = record['senderSessionId']
  return typeof sender === 'string' ? sender : undefined
}
