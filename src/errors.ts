/**
 * Team failures the model reads back as tool errors. One class with a closed
 * code set: the code is the stable fact, the message is the sentence the model
 * acts on.
 *
 * @module dsh-team/errors
 */

/** Every way a team operation refuses. */
export type TeamErrorCode =
  | 'NO_TEAM'
  | 'LEADER_AWAY'
  | 'NESTED_TEAM'
  | 'MAX_TEAMMATES'
  | 'DUPLICATE_NAME'
  | 'UNKNOWN_MEMBER'
  | 'UNKNOWN_TASK'
  | 'TASK_TITLE_REQUIRED'
  | 'SELF_MESSAGE'
  | 'UNAUTHORIZED'
  | 'UNKNOWN_PROVIDER'
  | 'MODEL_REQUIRED'
  | 'UNKNOWN_EFFORT'
  | 'CHAIN_EXHAUSTED'
  | 'PING_PONG'
  | 'REPEATED_MESSAGE'
  | 'INVALID_NOTE_KEY'
  | 'NOTE_TOO_LONG'
  | 'WORKSPACE_FULL'
  | 'UNKNOWN_NOTE'

/** Stable sentence per code; `detail` appends the caller-specific part. */
const MESSAGES: Record<TeamErrorCode, string> = {
  NO_TEAM: 'no team here yet — spawn a teammate with team_spawn to start one',
  LEADER_AWAY:
    'your team is intact but its main session is not loaded right now, so nothing can be delivered through '
    + 'it. Your work is not lost: write what you have to the shared workspace with team_note, which needs '
    + 'nobody else, and stop — the leader reads it when it comes back',
  NESTED_TEAM: 'a teammate cannot lead its own team; ask your leader to spawn one instead',
  MAX_TEAMMATES: 'the team is full — dismiss a teammate before spawning another',
  DUPLICATE_NAME: 'a teammate with that name is already on the roster',
  UNKNOWN_MEMBER: 'no teammate with that id or name is on the roster',
  UNKNOWN_TASK: 'no task with that id is on the shared task list',
  TASK_TITLE_REQUIRED: 'a new task needs a title',
  SELF_MESSAGE: 'a member cannot message itself',
  UNAUTHORIZED: 'this team operation is not available to you',
  UNKNOWN_PROVIDER:
    'no LLM provider with that id is registered here — spawn with the leader\'s own route, or name one of '
    + 'the registered providers',
  MODEL_REQUIRED:
    'a teammate on a provider other than the leader\'s needs an explicit model id: model ids are '
    + 'provider-scoped, so the leader\'s model usually does not exist on the other route',
  UNKNOWN_EFFORT: 'that reasoning effort is not offered by the selected model',
  CHAIN_EXHAUSTED:
    'this conversation has relayed as far as it may between teammates — settle it yourself and report to '
    + 'the leader, which is never refused',
  PING_PONG:
    'you have already said your piece to this member in this conversation — decide with what you have, or '
    + 'raise it with the leader',
  REPEATED_MESSAGE: 'you already sent that exact message in this conversation; sending it again changes nothing',
  INVALID_NOTE_KEY: 'that note name cannot be stored',
  NOTE_TOO_LONG: 'that note is longer than this workspace accepts — keep the conclusion, drop the transcript',
  WORKSPACE_FULL: 'this workspace area is full',
  UNKNOWN_NOTE: 'no note with that name is in this workspace area',
}

/** One refused team operation. */
export class TeamError extends Error {
  /**
   * @param code - the stable refusal code.
   * @param detail - the caller-specific part appended to the stable sentence.
   */
  constructor(readonly code: TeamErrorCode, readonly detail?: string) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]}: ${detail}`)
    this.name = 'TeamError'
  }
}
