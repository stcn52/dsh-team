/**
 * The model-facing team tools. Two audiences, one service: a leader session
 * gets the full set on its own agent scope, and a teammate gets the mailbox
 * subset inside its child scope, so neither an ordinary subagent nor a
 * teammate ever sees a tool it cannot use.
 *
 * Every mutating tool projects the WHOLE post-change entity through
 * `presentationMeta`, mirrored into finalized content for PTC-mode calls.
 * That projection is the durable record for a tool-driven change. A change
 * that starts in the panel instead commits a `plugin:dsh-team/member` record
 * through `appendPluginRecord` (see ./fold.ts and ./service.ts); ./fold.ts
 * folds both paths into one roster.
 *
 * @module dsh-team/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { TeamMemberFact } from './fold.ts'
import { DISPATCH_FACT_PREFIX } from './fold-dispatch.ts'
import { TeamError } from './errors.ts'
import type { DossierEntry, MemberDossiers } from './dossier.ts'
import type { TeamSeat, TeamService } from './service.ts'
import { SHARED_AREA, type TeamWorkspace } from './workspace.ts'

/** The acting agent; a team tool without one is a composition mistake. */
function actor(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('team tools require an acting agent')
  return agent
}

/** Pending-call card with the team treatment. */
function call(title: string, rawInput?: unknown): ToolCallView {
  return { card: 'generic', title, kind: 'other', ...rawInput !== undefined ? { rawInput } : {} }
}

/** Completed-call card carrying one line of prose. */
function done(title: string, text?: string): ToolResultView {
  return {
    card: 'generic',
    title,
    ...text !== undefined ? { content: [{ type: 'text', text }] } : {},
  }
}

/** First text block of a failed result, for the failure card. */
function failureText(result: { readonly content: readonly unknown[] }): string {
  const first = result.content[0]
  return first !== null && typeof first === 'object' && (first as { type?: unknown }).type === 'text'
    ? String((first as { text?: unknown }).text ?? 'failed')
    : 'failed'
}

/** Member facts as one output value and one durable fact share them. */
const MEMBER_PROPERTIES = {
  memberId: { type: 'string', required: true },
  name: { type: 'string', required: true },
  role: { type: 'string' },
  relation: { type: 'string', required: true, enum: ['managed', 'peer'] },
  provider: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  skills: { type: 'array', items: { type: 'string' } },
} as const

/** Task facts as one output value and one durable fact share them. */
const TASK_PROPERTIES = {
  taskId: { type: 'string', required: true },
  title: { type: 'string', required: true },
  assigneeId: { type: 'string' },
  status: { type: 'string', required: true, enum: ['pending', 'active', 'done'] },
  note: { type: 'string' },
} as const

/**
 * Drop the undefined optional members a JSON fact must not carry. Shared with
 * `./admin.ts`: a teammate spawned by a tool and one spawned by the HTTP panel
 * are projected by the same code, so their answers cannot drift apart.
 */
export function memberValue(member: TeamMemberFact): {
  memberId: string; name: string; role?: string; relation: 'managed' | 'peer'
  provider?: string; model?: string; effort?: string; skills?: string[]
} {
  return {
    memberId: member.memberId,
    name: member.name,
    relation: member.relation,
    ...member.role !== undefined ? { role: member.role } : {},
    ...member.provider !== undefined ? { provider: member.provider } : {},
    ...member.model !== undefined ? { model: member.model } : {},
    ...member.effort !== undefined ? { effort: member.effort } : {},
    ...member.skills !== undefined ? { skills: member.skills } : {},
  }
}

/**
 * PTC mode skips presentationMeta but durably logs finalized content. Carry
 * the same fact there, after the readable result, using only the harness's
 * existing text vocabulary. Native content and the code program's value keep
 * their usual shapes. Finalization sees the accepted outcome, so failed or
 * policy-blocked calls never publish a successful fact.
 */
function withDispatchFact(tool: ToolDefinition): ToolDefinition {
  const project = tool.output.presentationMeta
  if (project === undefined) return tool
  return {
    ...tool,
    finalizeContent(exec, result) {
      if (exec.parent === undefined || result.isError) return undefined
      try {
        const fact = project(exec.arguments, result.value)
        return [...result.content, { type: 'text', text: DISPATCH_FACT_PREFIX + JSON.stringify(fact) }]
      } catch {
        // A projection error must not turn an accepted side effect into a
        // retryable failure. Historical prose remains available to the fold.
        return undefined
      }
    },
  }
}

/**
 * `team_spawn` — start a teammate. Leader-only: a teammate that could spawn
 * would own a team its leader cannot see.
 * @param ctx - context carrying the team service.
 * @returns the tool definition.
 */
export function spawnTool(ctx: Context): ToolDefinition {
  return withDispatchFact(defineTool({
    name: 'team_spawn',
    description:
      'Add a teammate to your agent team. A teammate is a long-lived agent with its own session, its own '
      + 'memory and its own tools; it works in the background while you keep working, and it stays available '
      + 'until you dismiss it. Give it a name you will address it by and a first task. relation "managed" '
      + 'means it may only message you; "peer" means it may also message the other teammates directly and '
      + 'coordinate with them without going through you. Prefer a teammate over a one-shot subagent when the '
      + 'work needs several rounds, a durable owner, or someone the rest of the team can talk to. This is where '
      + 'a team begins: until one team_spawn has succeeded there is no team, no roster and no task list, and '
      + 'every other team_* tool has nothing to act on — call this one first.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name you and the team will address it by, e.g. Alice.' },
      task: { type: 'string', required: true, description: 'The first task, self-contained: the teammate does not see your conversation.' },
      relation: {
        type: 'string',
        required: true,
        enum: ['managed', 'peer'],
        description: 'managed: reports only to you. peer: may also message other teammates directly.',
      },
      role: { type: 'string', description: 'Optional role, e.g. reviewer. Shown to the whole team.' },
      persona: { type: 'string', description: 'Optional persona replacing the deployment persona for this teammate only.' },
      provider: {
        type: 'string',
        description: 'Optional LLM provider route for this teammate, e.g. a locally served "qwen-local". '
          + 'Default inherits your own provider. Naming another provider requires model too — model ids are '
          + 'provider-scoped. A provider this deployment never registered is refused at spawn, with the '
          + 'registered routes listed.',
      },
      model: {
        type: 'string',
        description: 'Optional model id; default inherits your own model. Interpreted by the selected provider, '
          + 'so a local route needs its own model id rather than your model.',
      },
      reasoning_effort: { type: 'string', description: 'Optional provider-owned reasoning effort for this teammate, e.g. high. Rejected when the model does not offer it.' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional skill names this teammate must load before working, e.g. ["deep-brief"]. '
          + 'Give each member only the skills its job needs; the assignment is recorded on the roster and the '
          + 'member is told to load them first. Names are checked by the member\'s own skill tool, not here.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: MEMBER_PROPERTIES },
      render: (_args, value) => [{
        type: 'text',
        text: `teammate ${value.name} joined as a ${value.relation} member and started on its task. `
          + `Address it as "${value.name}" or "${value.memberId}".`,
      }],
      presentationMeta: (_args, value) => ({ team: 'member-added', member: value }),
    },
    presentCall: args => call(`Spawn teammate ${args.name}`, {
      relation: args.relation,
      ...args.role !== undefined ? { role: args.role } : {},
      ...args.provider !== undefined ? { provider: args.provider } : {},
      ...args.model !== undefined ? { model: args.model } : {},
      task: args.task,
    }),
    presentResult: (args, result) => result.isError
      ? done(`Spawn teammate ${args.name}`, `failed: ${failureText(result)}`)
      : done(`${args.name} joined the team`, args.role === undefined ? args.relation : `${args.role} · ${args.relation}`),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const member = await ctx.team.spawn(actor(exec.agent), {
        name: args.name,
        task: args.task,
        relation: args.relation,
        ...args.role !== undefined ? { role: args.role } : {},
        ...args.persona !== undefined ? { persona: args.persona } : {},
        ...args.provider !== undefined ? { provider: args.provider } : {},
        ...args.model !== undefined ? { model: args.model } : {},
        ...args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {},
        ...args.skills !== undefined ? { skills: args.skills } : {},
      }, exec.signal)
      return memberValue(member)
    },
  }))
}

/**
 * `team_send` — the mailbox, shared by the leader and every teammate. The
 * service decides what the caller's relation allows.
 * @param ctx - context carrying the team service.
 * @param audience - whose description this registration serves.
 * @returns the tool definition.
 */
export function sendTool(ctx: Context, audience: 'leader' | 'member'): ToolDefinition {
  const description = audience === 'leader'
    ? 'Send a message to one teammate you have already spawned — with no team yet there is nobody to write '
      + 'to, so team_spawn comes first. It becomes that teammate\'s next turn: if it is busy, the message '
      + 'waits until the current turn ends, so it cannot redirect work already underway. Delivery is '
      + 'asynchronous — this returns once the message is accepted, never the teammate\'s answer; the reply '
      + 'arrives later as its own message to you.'
    : 'Send a message to another team member. Address the leader as "leader", or a teammate by its name. '
      + 'The message becomes the recipient\'s next turn; you get no answer back from this call. Use it to ask '
      + 'a peer for input, hand work over, or raise something with the leader mid-task. Finished work goes to '
      + 'the leader through team_send. A conversation between teammates carries a budget: it '
      + 'may only relay so far and you may not keep going back and forth with the same member about it, so '
      + 'ask for what you actually need in one message. Messaging the leader is never refused — when a peer '
      + 'exchange stops converging, that is the way out.'
  return withDispatchFact(defineTool({
    name: 'team_send',
    description,
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: a teammate name, a member id, or "leader".' },
      message: { type: 'string', required: true, description: 'Self-contained message; the recipient does not see your conversation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          name: { type: 'string', required: true },
          hop: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `message queued as the next turn of ${value.name}` }],
      presentationMeta: (args, value) => ({
        team: 'message',
        messageId: value.messageId,
        to: value.to,
        text: args.message,
        hop: value.hop,
      }),
    },
    presentCall: args => call(`Message ${args.to}`, args.message),
    presentResult: (args, result) => result.isError
      ? done(`Message ${args.to}`, `not delivered: ${failureText(result)}`)
      : done(`Message sent to ${args.to}`),
    async execute(args, exec) {
      const sent = await ctx.team.send(actor(exec.agent), args.to, args.message, exec.signal)
      return {
        messageId: sent.messageId,
        to: sent.recipient.id,
        name: sent.recipient.name,
        hop: sent.chain.hop,
      }
    },
  }))
}

/**
 * `team_task` — the shared task list. Writes are the leader's; teammates read
 * it through `team_list` and send outcomes through `team_send`.
 * @param ctx - context carrying the team service.
 * @returns the tool definition.
 */
export function taskTool(ctx: Context): ToolDefinition {
  return withDispatchFact(defineTool({
    name: 'team_task',
    description:
      'Create or update one row of the shared team task list — the list every teammate can read, so it is '
      + 'where multi-teammate work is coordinated without routing every detail through messages. The list '
      + 'belongs to a live team, so spawn the teammates first: a row nobody is on the roster to read changes '
      + 'nothing, and assigning one to a name that is not on the roster is refused. Omit task_id '
      + 'to create a row (title required); pass task_id to update one. Assign with a teammate name or member '
      + 'id. A teammate closes its own row by sending the outcome to the leader, so you rarely set status yourself.',
    parameters: {
      title: { type: 'string', description: 'Task title; required when creating.' },
      assignee: { type: 'string', description: 'Teammate name or member id; omit to leave the task unassigned.' },
      task_id: { type: 'string', description: 'Existing task id to update; omit to create a new task.' },
      status: { type: 'string', enum: ['pending', 'active', 'done'], description: 'Task state; defaults to pending on creation.' },
      note: { type: 'string', description: 'Short note recorded with the task, e.g. why it was closed.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: TASK_PROPERTIES },
      render: (_args, value) => [{
        type: 'text',
        text: `task ${value.taskId} "${value.title}" is ${value.status}`
          + (value.assigneeId === undefined ? ' and unassigned' : ` for ${value.assigneeId}`),
      }],
      presentationMeta: (_args, value) => ({ team: 'task', task: value }),
    },
    presentCall: args => call(
      args.task_id === undefined ? `New task: ${args.title ?? ''}` : `Update task ${args.task_id}`,
      { ...args.assignee !== undefined ? { assignee: args.assignee } : {}, ...args.status !== undefined ? { status: args.status } : {} },
    ),
    presentResult: (args, result) => result.isError
      ? done('Team task', `failed: ${failureText(result)}`)
      : done(args.task_id === undefined ? `Task added: ${args.title ?? ''}` : `Task ${args.task_id} updated`),
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const task = ctx.team.upsertTask(actor(exec.agent), {
        ...args.task_id !== undefined ? { taskId: args.task_id } : {},
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.assignee !== undefined ? { assigneeId: args.assignee } : {},
        ...args.status !== undefined ? { status: args.status } : {},
        ...args.note !== undefined ? { note: args.note } : {},
      })
      return Promise.resolve({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        ...task.assigneeId !== undefined ? { assigneeId: task.assigneeId } : {},
        ...task.note !== undefined ? { note: task.note } : {},
      })
    },
  }))
}

/**
 * `team_relation` — widen or tighten one teammate's autonomy.
 * @param ctx - context carrying the team service.
 * @returns the tool definition.
 */
export function relationTool(ctx: Context): ToolDefinition {
  return withDispatchFact(defineTool({
    name: 'team_relation',
    description:
      'Change how much one teammate may talk to the rest of the team; the teammate must already be on the '
      + 'roster, so this never applies before you have spawned one. "peer" lets it message other teammates '
      + 'directly and self-coordinate; "managed" routes all of its traffic back through you. Widen when a '
      + 'teammate needs to work with another one; tighten when you want every hand-off to pass your desk.',
    parameters: {
      member: { type: 'string', required: true, description: 'Teammate name or member id.' },
      relation: { type: 'string', required: true, enum: ['managed', 'peer'], description: 'The new relation.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: MEMBER_PROPERTIES },
      render: (_args, value) => [{ type: 'text', text: `${value.name} is now a ${value.relation} member` }],
      presentationMeta: (_args, value) => ({ team: 'member-updated', member: value }),
    },
    presentCall: args => call(`Set ${args.member} to ${args.relation}`),
    presentResult: (args, result) => result.isError
      ? done(`Set ${args.member} to ${args.relation}`, `failed: ${failureText(result)}`)
      : done(`${args.member} is now ${args.relation}`),
    isConcurrencySafe: () => false,
    execute(args, exec) {
      return Promise.resolve(memberValue(ctx.team.setRelation(actor(exec.agent), args.member, args.relation)))
    },
  }))
}

/**
 * `team_dismiss` — release one teammate, or the whole team.
 * @param ctx - context carrying the team service.
 * @returns the tool definition.
 */
export function dismissTool(ctx: Context): ToolDefinition {
  return withDispatchFact(defineTool({
    name: 'team_dismiss',
    description:
      'Dismiss one teammate, or the whole team when you name nobody — there is nothing to dismiss until you '
      + 'have spawned someone. A dismissed teammate stops what it is '
      + 'doing and receives no further messages; its transcript stays readable. Dismiss teammates whose work '
      + 'is finished — an idle teammate costs nothing to keep, but a stale one invites you to message it again.',
    parameters: {
      member: { type: 'string', description: 'Teammate name or member id; omit to dismiss the whole team.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ended: { type: 'boolean', required: true }, memberId: { type: 'string' } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ended ? 'the team is disbanded' : `teammate ${String(value.memberId)} is dismissed`,
      }],
      presentationMeta: (_args, value) => value.ended
        ? { team: 'ended' }
        : { team: 'member-removed', memberId: String(value.memberId) },
    },
    presentCall: args => call(args.member === undefined ? 'Disband the team' : `Dismiss ${args.member}`),
    presentResult: (args, result) => result.isError
      ? done('Dismiss', `failed: ${failureText(result)}`)
      : done(args.member === undefined ? 'Team disbanded' : `${args.member} dismissed`),
    isConcurrencySafe: () => false,
    execute(args, exec) {
      return Promise.resolve(ctx.team.dismiss(actor(exec.agent), args.member))
    },
  }))
}

/**
 * `team_list` — the shared read every member uses to decide who to talk to.
 * @param ctx - context carrying the team service.
 * @param audience - whose reading of an empty team this registration serves.
 * @returns the tool definition.
 */
export function listTool(ctx: Context, audience: 'leader' | 'member' = 'leader'): ToolDefinition {
  const description = audience === 'leader'
    ? 'Read your team: every member with its role, relation and live state (running, idle, or ready to wake), '
      + 'the shared task list, and the recent mailbox traffic. Use it before messaging or assigning work, and '
      + 'to check whether a teammate is still busy. It reads a team you built yourself — before your first '
      + 'team_spawn it reports an empty team, so do not call it to find out whether you have one.'
    : 'Read the team: every member with its role, relation and live state (running, idle, or ready to wake), '
      + 'the shared task list, and the recent mailbox traffic the leader can see. Use it before messaging or '
      + 'assigning work, and to check whether a teammate is still busy.'
  return defineTool({
    name: 'team_list',
    description,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ...MEMBER_PROPERTIES,
                status: { type: 'string', required: true, enum: ['running', 'idle', 'ready'] },
              },
            },
          },
          tasks: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: TASK_PROPERTIES },
          },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
                text: { type: 'string', required: true },
                hop: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.active
          ? `${value.members.length} teammate(s), ${value.tasks.filter(task => task.status !== 'done').length} open task(s)`
          : audience === 'leader'
            ? 'no team yet — team_spawn starts one'
            : 'the team is not readable from here right now; its main session is not loaded',
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'Read the team', kind: 'read' }),
    presentResult: (_args, result) => result.isError ? done('Read the team', 'failed') : done('Team state'),
    execute(_args, exec) {
      const team = ctx.team.list(actor(exec.agent))
      return Promise.resolve({
        active: team.active,
        members: team.members.map(member => ({ ...memberValue(member), status: member.status })),
        tasks: team.tasks.map(task => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          ...task.assigneeId !== undefined ? { assigneeId: task.assigneeId } : {},
          ...task.note !== undefined ? { note: task.note } : {},
        })),
        messages: team.messages.map(message => ({
          from: message.from ?? 'leader',
          to: message.to ?? 'leader',
          text: message.text,
          ...message.hop !== undefined ? { hop: message.hop } : {},
        })),
      })
    },
  })
}

/** The notes one `team_board` read returns for a named key. */
function pickNote<T extends { readonly key: string }>(held: readonly T[], key: string): readonly T[] {
  const wanted = key.trim()
  return held.filter(entry => entry.key === wanted)
}

/** Board entry facts as one output value and one durable fact share them. */
const BOARD_PROPERTIES = {
  key: { type: 'string', required: true },
  authorId: { type: 'string', required: true },
  authorName: { type: 'string', required: true },
  updatedAt: { type: 'number', required: true },
  preview: { type: 'string', required: true },
} as const

/**
 * How one workspace tool learns where its caller sits. A leader resolves
 * through the live team; a teammate's registration closes over the seat it was
 * composed with, so its workspace keeps working even while the leader session
 * is not loaded — which is exactly when a teammate most needs somewhere to put
 * its result.
 */
export type SeatResolver = (agent: Agent) => TeamSeat

/** The team's workspace, the area, and the signature one call addresses. */
function place(seat: TeamSeat, priv: boolean): {
  readonly leaderId: string
  readonly area: string
  readonly author: { readonly id: string; readonly name: string }
} {
  return {
    leaderId: seat.leaderId,
    area: priv ? seat.memberId : SHARED_AREA,
    author: { id: seat.memberId, name: seat.name },
  }
}

/**
 * `team_note` — write or drop one note in a virtual workspace.
 * @param workspace - the open workspace domain.
 * @param audience - whose description this registration serves.
 * @param seatOf - where the caller sits (see {@link SeatResolver}).
 * @returns the tool definition.
 */
export function noteTool(
  workspace: TeamWorkspace,
  audience: 'leader' | 'member',
  seatOf: SeatResolver,
): ToolDefinition {
  const shared = audience === 'leader'
    ? 'Every teammate reads and writes the shared board, so it is where a decision belongs once you have made '
      + 'it — leaving a note costs no turn, while messaging someone costs one of theirs. It is worth writing '
      + 'to once you have teammates: before your first team_spawn nobody is there to read it.'
    : 'Every member reads and writes the shared board. Put a conclusion there instead of messaging it around: '
      + 'a note costs nobody a turn, and it is still there after you have finished and gone idle.'
  return withDispatchFact(defineTool({
    name: 'team_note',
    description:
      'Write one note into a team workspace. These workspaces are the team\'s own — they are NOT files and '
      + 'they are not in the user\'s working tree. ' + shared + ' With private=true the note goes to your own '
      + 'pad instead, which nobody else can read: use it to keep your own state across turns. Writing a key '
      + 'that already exists replaces it whole; omit text to drop the note.',
    parameters: {
      key: { type: 'string', required: true, description: 'Short name of the note, e.g. "api decision". Writing the same key again replaces it.' },
      text: { type: 'string', description: 'The whole note. Omit to delete the note instead.' },
      private: { type: 'boolean', description: 'true writes your own private pad; default false writes the shared board.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          area: { type: 'string', required: true, enum: ['shared', 'private'] },
          removed: { type: 'boolean', required: true },
          board: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: BOARD_PROPERTIES } },
          at: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed
          ? `dropped "${value.key}" from the ${value.area} workspace`
          : `wrote "${value.key}" to the ${value.area} workspace`,
      }],
      // The whole shared index, from whichever session made the call: the
      // durable workspace lives outside every log, so each session records the
      // snapshot it actually saw.
      presentationMeta: (_args, value) => ({ team: 'board', entries: value.board, at: value.at }),
    },
    presentCall: args => call(
      args.text === undefined ? `Drop note ${args.key}` : `Note: ${args.key}`,
      args.private === true ? { private: true } : undefined,
    ),
    presentResult: (args, result) => result.isError
      ? done(`Note: ${args.key}`, `failed: ${failureText(result)}`)
      : done(args.text === undefined ? `Dropped ${args.key}` : `Noted ${args.key}`, args.private === true ? 'private' : 'shared'),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const spot = place(seatOf(actor(exec.agent)), args.private === true)
      const now = Date.now()
      if (args.text === undefined) {
        await workspace.remove(spot.leaderId, spot.area, args.key)
      } else {
        await workspace.write(spot.leaderId, spot.area, args.key, args.text, spot.author, now)
      }
      return {
        key: args.key.trim(),
        area: args.private === true ? 'private' as const : 'shared' as const,
        removed: args.text === undefined,
        board: [...await workspace.index(spot.leaderId)],
        at: now,
      }
    },
  }))
}

/**
 * `team_board` — read a virtual workspace.
 * @param workspace - the open workspace domain.
 * @param audience - whose description this registration serves.
 * @param seatOf - where the caller sits (see {@link SeatResolver}).
 * @returns the tool definition.
 */
export function boardTool(
  workspace: TeamWorkspace,
  audience: 'leader' | 'member',
  seatOf: SeatResolver,
): ToolDefinition {
  return withDispatchFact(defineTool({
    name: 'team_board',
    description:
      'Read a team workspace: the shared board every member writes to, or your own private pad. Without a key '
      + 'you get the index — every note with who wrote it and when — and with a key you get that note in full. '
      + (audience === 'leader'
        ? 'Read the board before assigning work: a teammate that has already recorded its conclusion there '
          + 'does not need to be asked for it again. The board belongs to the team, so before your first '
          + 'team_spawn it is empty and reading it tells you nothing.'
        : 'Read the board before messaging anyone: what you were about to ask for may already be written down, '
          + 'and a note costs nobody a turn.'),
    parameters: {
      key: { type: 'string', description: 'Read one note in full; omit for the index of the whole area.' },
      private: { type: 'boolean', description: 'true reads your own private pad; default false reads the shared board.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          area: { type: 'string', required: true, enum: ['shared', 'private'] },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { ...BOARD_PROPERTIES, text: { type: 'string' } },
            },
          },
          board: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: BOARD_PROPERTIES } },
          at: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? `the ${value.area} workspace is empty`
          : value.entries
            .map(entry => `## ${entry.key} — ${entry.authorName}\n${entry.text ?? entry.preview}`)
            .join('\n\n'),
      }],
      presentationMeta: (_args, value) => ({ team: 'board', entries: value.board, at: value.at }),
    },
    presentCall: args => ({
      card: 'generic',
      title: args.key === undefined ? 'Read the team workspace' : `Read note ${args.key}`,
      kind: 'read',
    }),
    presentResult: (_args, result) => result.isError
      ? done('Read the team workspace', 'failed')
      : done('Team workspace'),
    async execute(args, exec) {
      const spot = place(seatOf(actor(exec.agent)), args.private === true)
      const held = await workspace.read(spot.leaderId, spot.area)
      const wanted = args.key === undefined ? held : pickNote(held, args.key)
      return {
        area: args.private === true ? 'private' as const : 'shared' as const,
        entries: wanted.map(entry => ({
          key: entry.key,
          authorId: entry.authorId,
          authorName: entry.authorName,
          updatedAt: entry.updatedAt,
          preview: entry.text.split('\n')[0] ?? '',
          text: entry.text,
        })),
        board: [...await workspace.index(spot.leaderId)],
        at: Date.now(),
      }
    },
  }))
}

/** One dossier entry as both the profile read and its fact shape carry it. */
const ENTRY_PROPERTIES = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, enum: ['lesson', 'fact', 'feedback'] },
  text: { type: 'string', required: true },
  evidence: { type: 'string', required: true },
  createdAt: { type: 'number', required: true },
  reinforced: { type: 'number', required: true },
} as const

/** The dossier stats, shared by the profile read and the review result. */
const STATS_PROPERTIES = {
  delivered: { type: 'number', required: true },
  reworks: { type: 'number', required: true },
} as const

/** Dossier record as a tool output value; an unread name reads as an empty career. */
function profileValue(name: string, entries: readonly DossierEntry[] | undefined, stats: { delivered: number; reworks: number } | undefined): {
  name: string
  stats: { delivered: number; reworks: number }
  entries: DossierEntry[]
} {
  return {
    name,
    stats: stats ?? { delivered: 0, reworks: 0 },
    entries: entries ? [...entries] : [],
  }
}

/**
 * How the dossier tools learn whose record a call addresses. A teammate's
 * registration closes over the name it was composed with — the dossier, like
 * the workspace, must keep working while the leader session is unloaded. A
 * leader addresses a roster member, by name or id; the roster resolves the
 * canonical display name, because the dossier is keyed by name and the leader
 * may hold only the id.
 */
export type DossierNameResolver = (agent: Agent, member?: string) => string

/**
 * The leader-side resolver: roster address (id or name) to canonical name.
 * @param ctx - context carrying the team service.
 * @returns a resolver that refuses anything off the roster.
 */
export function dossierNameOf(ctx: Context): DossierNameResolver {
  return (agent, member) => {
    const address = (member ?? '').trim()
    if (address === '') {
      throw new TeamError('UNKNOWN_MEMBER', 'name the teammate whose dossier you mean')
    }
    const wanted = address.toLowerCase()
    const found = ctx.team.list(agent).members.find(
      row => row.memberId === address || row.name.toLowerCase() === wanted,
    )
    if (found === undefined) throw new TeamError('UNKNOWN_MEMBER', address)
    return found.name
  }
}

/**
 * `team_learn` — a member records in its own dossier. Member-only: the
 * dossier is what the member carries, and only its own work earns an entry.
 * @param dossiers - the open dossier domain.
 * @param nameOf - the member's own name, resolved at call time so a dismissed
 *   member's stray call errors instead of filing under a stale name.
 * @returns the tool definition.
 */
export function learnTool(dossiers: MemberDossiers, nameOf: () => string): ToolDefinition {
  return defineTool({
    name: 'team_learn',
    description:
      'Record one reusable lesson or fact in your own durable dossier. The dossier follows the name, not the '
      + 'session: it is the one thing that survives your dismissal, and the next member spawned under this '
      + 'name starts by reading it. Record what would change how you work next time, and evidence — what you '
      + 'observed or verified, not what you hope. One to three entries per finished job is enough; routine '
      + 'progress and anything a fresh read of the repo already states are noise. Repeating a point you '
      + 'already recorded reinforces it instead of duplicating it. You can only add entries: the delivered '
      + 'and rework stats belong to your leader\'s review.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['lesson', 'fact'],
        description: 'lesson: how to work better next time. fact: a durable truth about the terrain you worked on.',
      },
      text: { type: 'string', required: true, description: 'The reusable point in one or two sentences, written so whoever inherits this name can act on it.' },
      evidence: { type: 'string', required: true, description: 'What you observed or verified that makes this worth keeping: a command you ran and what it printed, a file you read, a failure you watched happen.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', required: true },
          deduplicated: { type: 'boolean', required: true },
          entries: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deduplicated
          ? `already in your dossier — entry ${value.entryId} reinforced instead (${value.entries} entries held)`
          : `recorded entry ${value.entryId} in your dossier (${value.entries} entries held)`,
      }],
    },
    presentCall: args => call(`Learn a ${args.kind}`, { kind: args.kind, text: args.text, evidence: args.evidence }),
    presentResult: (_args, result) => result.isError
      ? done('Learn', `failed: ${failureText(result)}`)
      : done('Dossier updated'),
    isConcurrencySafe: () => false,
    async execute(args) {
      const outcome = await dossiers.learn(nameOf(), {
        kind: args.kind,
        text: args.text,
        evidence: args.evidence,
      })
      return { entryId: outcome.entry.id, deduplicated: outcome.deduplicated, entries: outcome.entries }
    },
  })
}

/** The profile read, shared verbatim by both audience registrations. */
const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    stats: { type: 'object', required: true, additionalProperties: false, properties: STATS_PROPERTIES },
    entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPERTIES } },
  },
} as const

/** The one render both `team_profile` registrations share. */
function profileRender(
  _args: unknown,
  value: { name: string; stats: { delivered: number; reworks: number }; entries: DossierEntry[] },
) {
  return [{
    type: 'text' as const,
    text: value.entries.length === 0 && value.stats.delivered === 0 && value.stats.reworks === 0
      ? `${value.name} has no dossier yet — nothing recorded under this name`
      : `${value.name}: ${value.stats.delivered} delivered, ${value.stats.reworks} reworked, `
        + `${value.entries.length} entries\n`
        + value.entries.map(entry => `[${entry.kind} ${entry.id}] ${entry.text} (evidence: ${entry.evidence})`).join('\n'),
  }]
}

/**
 * `team_profile` — read a dossier. The audience split is the hard invariant:
 * the member registration declares no `member` parameter and can only ever
 * read its own record; only the leader names whose career to look at. Two
 * registrations rather than conditional parameters: the parameter map is part
 * of the tool's type, and a member must not even see a parameter it may not
 * use — a parameter it can fill is a parameter it can reach another name
 * with.
 * @param dossiers - the open dossier domain.
 * @param audience - whose reach this registration serves.
 * @param nameOf - where the caller's (or the named member's) dossier name comes from.
 * @returns the tool definition.
 */
export function profileTool(
  dossiers: MemberDossiers,
  audience: 'leader' | 'member',
  nameOf: DossierNameResolver,
): ToolDefinition {
  const output = { schema: PROFILE_SCHEMA, render: profileRender }
  if (audience === 'leader') {
    return defineTool({
      name: 'team_profile',
      description:
        'Read one teammate\'s durable dossier: the delivered/rework stats and every entry with its id. '
        + 'Read-only — team_review records outcomes, team_forget drops one entry. The dossier follows the '
        + 'name across teams and restarts, so this is what a member carries with it; reading it before you '
        + 'assign work tells you what this name already knows.',
      parameters: {
        member: { type: 'string', required: true, description: 'Teammate name or member id.' },
      },
      output,
      presentCall: args => ({ card: 'generic', title: `Read ${args.member}'s dossier`, kind: 'read' }),
      presentResult: (_args, result) => result.isError ? done('Read the dossier', 'failed') : done('Dossier'),
      async execute(args, exec) {
        const name = nameOf(actor(exec.agent), args.member)
        const record = await dossiers.read(name)
        return profileValue(record?.name ?? name, record?.entries, record?.stats)
      },
    })
  }
  return defineTool({
    name: 'team_profile',
    description:
      'Read your own dossier: the stats your leaders have built up under your name, and every entry you '
      + 'or your earlier selves recorded, with ids. Read-only; team_learn adds entries. There is no member '
      + 'parameter because there is no other dossier you may read.',
    parameters: {},
    output,
    presentCall: () => ({ card: 'generic', title: 'Read your dossier', kind: 'read' }),
    presentResult: (_args, result) => result.isError ? done('Read the dossier', 'failed') : done('Dossier'),
    async execute(_args, exec) {
      const name = nameOf(actor(exec.agent))
      const record = await dossiers.read(name)
      return profileValue(record?.name ?? name, record?.entries, record?.stats)
    },
  })
}

/**
 * `team_review` — the leader records an outcome. The only door to the stats:
 * `accepted` and `rework` move delivered/reworks, and an optional note is
 * kept as feedback the next member under that name reads first.
 * @param dossiers - the open dossier domain.
 * @param nameOf - roster address to canonical name.
 * @returns the tool definition.
 */
export function reviewTool(dossiers: MemberDossiers, nameOf: DossierNameResolver): ToolDefinition {
  return defineTool({
    name: 'team_review',
    description:
      'Record what you made of one teammate\'s work in its durable dossier: accepted raises its delivered '
        + 'count, rework raises its rework count, and an optional note is kept as feedback that member (and '
        + 'whoever later wears the name) reads before its own lessons. This is how a team teaches its names: '
        + 'the stats and the feedback survive every dismissal and restart. Review the work you actually '
        + 'judged — these numbers are the dossier\'s spine, and only this tool moves them.',
    parameters: {
      member: { type: 'string', required: true, description: 'Teammate name or member id.' },
      outcome: { type: 'string', required: true, enum: ['accepted', 'rework'], description: 'accepted: the work landed. rework: it came back.' },
      note: { type: 'string', description: 'Optional feedback kept as a dossier entry: what to do differently next time, said once and concretely.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          stats: { type: 'object', required: true, additionalProperties: false, properties: STATS_PROPERTIES },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.name}: ${value.stats.delivered} delivered, ${value.stats.reworks} reworked`,
      }],
    },
    presentCall: args => call(`Review ${args.member}: ${args.outcome}`, args.note === undefined ? undefined : { note: args.note }),
    presentResult: (args, result) => result.isError
      ? done(`Review ${args.member}`, `failed: ${failureText(result)}`)
      : done(`${args.member} reviewed (${args.outcome})`),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const record = await dossiers.review(
        nameOf(actor(exec.agent), args.member),
        args.outcome,
        args.note,
      )
      return { name: record.name, stats: record.stats }
    },
  })
}

/**
 * `team_forget` — the leader drops one entry by id. Leader-only: a wrong
 * lesson teaches the wrong thing, and only the leader can tell a lesson from
 * a wish.
 * @param dossiers - the open dossier domain.
 * @param nameOf - roster address to canonical name.
 * @returns the tool definition.
 */
export function forgetTool(dossiers: MemberDossiers, nameOf: DossierNameResolver): ToolDefinition {
  return defineTool({
    name: 'team_forget',
    description:
      'Drop one entry from a teammate\'s dossier by its id — ids come from team_profile, or from the digest '
        + 'the member itself sees. Use it when a note is wrong or obsolete: a lesson that no longer holds '
        + 'teaches the wrong thing to everyone who inherits the name. The stats are untouched; only the '
        + 'leader forgets.',
    parameters: {
      member: { type: 'string', required: true, description: 'Teammate name or member id.' },
      entry_id: { type: 'string', required: true, description: 'The entry id, e.g. "e3", as team_profile showed it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
          remaining: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `dropped entry ${value.removed}; ${value.remaining} entries left in the dossier`,
      }],
    },
    presentCall: args => call(`Forget ${args.member}'s entry ${args.entry_id}`),
    presentResult: (args, result) => result.isError
      ? done(`Forget ${args.member}'s entry`, `failed: ${failureText(result)}`)
      : done(`Entry ${args.entry_id} forgotten`),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const remaining = await dossiers.forget(nameOf(actor(exec.agent), args.member), args.entry_id)
      return { removed: args.entry_id.trim(), remaining }
    },
  })
}
