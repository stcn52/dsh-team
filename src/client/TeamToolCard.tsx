import { useId, useMemo, useState } from 'react'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readFact } from '../fold.ts'
import { MemberAvatar } from './MemberAvatar.tsx'
import type { TeamInjected, TeamPanelState } from './TeamStage.tsx'
import {
  IconTeam16, IconTeamMailbox16, IconTeamPeer16, IconTeamSend16, IconTeamTask16, IconTeamWorkspace16,
} from './icons.tsx'
import type { TeamKey } from './locales.ts'
import { dossierReport, waitReport } from './toolResult.ts'
import theme from './TeamStage.module.css'
import css from './TeamChat.module.css'

/**
 * Every tool this plugin renders a card for. A wire name missing here falls to
 * the host's generic row, which prints the call's arguments as raw JSON — the
 * reason this list is covered by a completeness test instead of being trusted.
 */
export const TEAM_TOOLS = [
  'team_spawn', 'team_send', 'team_task', 'team_relation',
  'team_dismiss', 'team_list', 'team_note', 'team_board',
  'team_wait', 'team_learn', 'team_profile', 'team_review', 'team_forget',
] as const

/**
 * Every tool the host half registers, mirrored by hand from the `name:` fields
 * in `src/tools.ts` (`team_profile` is registered twice, once per audience, so
 * the unique count is one lower than the registration count).
 *
 * Hard-coded rather than imported on purpose: this module is reachable from the
 * browser bundle, and the client half may not value-import a host module
 * (`tsdown.config.ts` fails the build for it). `tests/tool-card-catalog.spec.tsx`
 * re-reads `src/tools.ts` and fails when the two lists drift, so a new host tool
 * cannot quietly degrade to the generic card again.
 */
export const TEAM_TOOL_NAMES = [
  'team_spawn', 'team_send', 'team_task', 'team_relation', 'team_dismiss',
  'team_list', 'team_wait', 'team_note', 'team_board', 'team_learn',
  'team_profile', 'team_review', 'team_forget',
] as const

type TeamTool = typeof TEAM_TOOLS[number]
type Translate = PropsLocale<'team'>['t']

export type TeamToolCardProps = ToolCallViewProps & PropsLocale<'team'> & TeamInjected & {
  readonly useTeam: SnapshotSelectorHook<TeamPanelState>
}

const TITLES: Record<TeamTool, TeamKey> = {
  team_spawn: 'tool.spawn', team_send: 'tool.send', team_task: 'tool.task',
  team_relation: 'tool.relation', team_dismiss: 'tool.dismiss', team_list: 'tool.list',
  team_note: 'tool.note', team_board: 'tool.board', team_wait: 'tool.wait',
  team_learn: 'tool.learn', team_profile: 'tool.profile', team_review: 'tool.review',
  team_forget: 'tool.forget',
}

const SUCCEEDED: Record<TeamTool, TeamKey> = {
  team_spawn: 'tool.joined', team_send: 'tool.sent', team_task: 'tool.updated',
  team_relation: 'tool.updated', team_dismiss: 'tool.ended', team_list: 'tool.read',
  team_note: 'tool.saved', team_board: 'tool.read', team_wait: 'tool.waited',
  team_learn: 'tool.learned', team_profile: 'tool.read', team_review: 'tool.reviewed',
  team_forget: 'tool.forgotten',
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    // Partial call arguments remain inspectable until the tool supplies valid JSON.
    return {}
  }
}

function argument(args: Record<string, unknown>, name: string): string | undefined {
  return typeof args[name] === 'string' && args[name] !== '' ? args[name] as string : undefined
}

/** A string-list argument, tolerant of a partial call that has not closed its array yet. */
function argumentList(args: Record<string, unknown>, name: string): readonly string[] {
  const value = args[name]
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string' && row !== '') : []
}

interface Participant {
  readonly id: string | undefined
  readonly seat: number | undefined
  readonly name: string
}

function participant(state: TeamPanelState, reference: string | undefined, fallback: string, t: Translate): Participant {
  if (reference !== undefined && (reference === 'leader' || reference === state.leaderId)) {
    return { id: state.leaderId, seat: -1, name: t('member.leader') }
  }
  const seat = state.members.findIndex(member => member.memberId === reference || member.name === reference)
  const member = state.members[seat]
  return { id: member?.memberId, seat: member === undefined ? undefined : seat, name: member?.name ?? fallback }
}

function presentation(tool: TeamTool, block: ToolCallBlock, state: TeamPanelState, sessionId: string, t: Translate) {
  const settled = 'kind' in block
  const raw = (settled ? block.call?.argsRaw : block.phase === 'start' ? block.argsRaw : undefined) ?? ''
  const args = parseArgs(raw)
  const status: 'running' | 'stopped' | 'error' | 'ok' = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const fact = settled && !block.isError ? readFact(block.meta) : undefined
  const output = settled ? block.content.filter(content => content.type === 'text').map(content => content.text).join('\n') : ''
  let title = t(TITLES[tool])
  let summary = ''
  let caption = ''
  let people: Participant[] = []
  const who = (reference: string | undefined, fallback = reference ?? t('presence.title')) => participant(state, reference, fallback, t)

  switch (tool) {
    case 'team_spawn': {
      const member = fact?.team === 'member-added' ? fact.member : undefined
      const name = member?.name ?? argument(args, 'name') ?? t('tool.teammate')
      people = [who(member?.memberId, name)]
      summary = argument(args, 'task') ?? name
      caption = member === undefined ? argument(args, 'role') ?? '' : member.role ?? ''
      break
    }
    case 'team_send': {
      // A broadcast addresses a LIST, and the projection expands it into one
      // `message` fact per mailbox — so no single fact carries the whole
      // address list. Read the names off the arguments instead of falling back
      // to the generic "teammate" label.
      const address = args['to']
      const reference = fact?.team === 'message'
        ? fact.to
        : typeof address === 'string'
          ? address
          : Array.isArray(address)
            ? address.filter(name => typeof name === 'string').join(', ')
            : undefined
      people = [who(sessionId, t('tool.sender')), who(reference, argument(args, 'to') ?? t('tool.teammate'))]
      summary = fact?.team === 'message' ? fact.text : argument(args, 'message') ?? ''
      caption = t('tool.recipient', { name: people[1]!.name })
      break
    }
    case 'team_task': {
      const task = fact?.team === 'task' ? fact.task : undefined
      const assignee = task === undefined ? argument(args, 'assignee') : task.assigneeId
      summary = task?.title ?? argument(args, 'title') ?? argument(args, 'task_id') ?? ''
      if (assignee !== undefined) people = [who(assignee)]
      const taskStatus = task?.status
      caption = taskStatus === undefined ? '' : t(`task.${taskStatus}`)
      break
    }
    case 'team_relation': {
      const member = fact?.team === 'member-updated' ? fact.member : undefined
      people = [who(member?.memberId ?? argument(args, 'member'), member?.name ?? argument(args, 'member') ?? t('tool.teammate'))]
      const relation = member?.relation ?? argument(args, 'relation')
      summary = people[0]!.name
      caption = relation === 'peer' ? t('relation.peer') : relation === 'managed' ? t('relation.managed') : ''
      break
    }
    case 'team_dismiss': {
      const member = argument(args, 'member')
      const id = fact?.team === 'member-removed' ? fact.memberId : member
      if (id !== undefined) people = [who(id, member ?? id)]
      summary = people[0]?.name ?? t('presence.title')
      break
    }
    case 'team_list':
      summary = t('tool.overview')
      break
    case 'team_note':
      if (raw !== '' && args['text'] === undefined && argument(args, 'key') !== undefined) title = t('tool.removeNote')
      summary = argument(args, 'key') ?? ''
      caption = t(args['private'] === true ? 'tool.private' : 'tool.shared')
      break
    case 'team_board':
      summary = argument(args, 'key') ?? (fact?.team === 'board' && args['private'] !== true ? t('tool.notes', { count: fact.entries.length }) : '')
      caption = t(args['private'] === true ? 'tool.private' : 'tool.shared')
      break
    case 'team_wait': {
      // The result names members, not ids, and a request in flight has no
      // result yet — so the card reads the fact when the tool projects one and
      // the rendered sentence otherwise, and falls back to the request itself.
      const report = waitReport(settled ? block.meta : undefined, output)
      const entries: string[] = []
      if (report.done !== undefined && report.done.length > 0) entries.push(t('tool.waitDone', { count: report.done.length }))
      if (report.busy !== undefined && report.busy.length > 0) entries.push(t('tool.waitBusy', { count: report.busy.length }))
      if (report.cold !== undefined && report.cold.length > 0) entries.push(t('tool.waitCold', { count: report.cold.length }))
      if (report.timedOut === true) entries.push(t('tool.waitTimedOut'))
      const requested = argumentList(args, 'members')
      summary = entries.length > 0
        ? entries.join(' · ')
        : requested.length > 0 ? t('tool.waitFor', { names: requested.join(', ') }) : t('tool.waitNone')
      // The counts answer "did everyone come back"; the names answer "who do I
      // still owe a look at", which is what the next call has to name again.
      const named = [
        report.busy !== undefined && report.busy.length > 0 ? t('tool.waitBusyNames', { names: report.busy.join(', ') }) : '',
        report.cold !== undefined && report.cold.length > 0 ? t('tool.waitColdNames', { names: report.cold.join(', ') }) : '',
      ]
      caption = named.filter(line => line !== '').join(' · ')
      break
    }
    case 'team_learn': {
      // The lesson is the arguments, so a running call already says what it
      // will record: no result text reaches the card, and none is needed.
      const evidence = argument(args, 'evidence')
      const kind = t(args['kind'] === 'fact' ? 'tool.kindFact' : 'tool.kindLesson')
      summary = argument(args, 'text') ?? ''
      caption = evidence === undefined ? kind : `${kind} · ${t('tool.evidence', { text: evidence })}`
      break
    }
    case 'team_profile': {
      const report = dossierReport(settled ? block.meta : undefined, output)
      const reference = argument(args, 'member') ?? report.name
      if (reference === undefined) {
        summary = ''
        break
      }
      people = [who(reference, report.name ?? reference)]
      summary = people[0]!.name
      caption = report.empty === true
        ? t('tool.profileEmpty')
        : report.delivered !== undefined && report.reworks !== undefined && report.entries !== undefined
          ? t('tool.profileStats', { delivered: report.delivered, reworks: report.reworks, count: report.entries })
          : ''
      break
    }
    case 'team_review': {
      const reference = argument(args, 'member')
      const note = argument(args, 'note')
      if (reference !== undefined) people = [who(reference, reference)]
      // The feedback is the point of the card; the member's name already rides
      // on the portrait, and the outcome is the caption. A failure keeps the
      // tool's own message and drops both, so no raw JSON reaches the reader.
      summary = note ?? people[0]?.name ?? reference ?? ''
      const outcome = args['outcome']
      caption = outcome === 'accepted' ? t('tool.reviewAccepted') : outcome === 'rework' ? t('tool.reviewRework') : ''
      break
    }
    case 'team_forget': {
      const report = dossierReport(settled ? block.meta : undefined, output)
      const reference = argument(args, 'member')
      if (reference !== undefined) people = [who(reference, reference)]
      summary = report.removed ?? argument(args, 'entry_id') ?? ''
      const name = people[0]?.name
      caption = name === undefined
        ? ''
        : report.remaining === undefined
          ? t('tool.forgotFrom', { name })
          : `${t('tool.forgotFrom', { name })} · ${t('tool.remaining', { count: report.remaining })}`
      break
    }
  }

  const failure = status === 'error' || status === 'stopped'
  const resultLabel = tool === 'team_note' && args['text'] === undefined && argument(args, 'key') !== undefined
    ? 'tool.removed' : SUCCEEDED[tool]
  return {
    title, summary, caption: failure ? '' : caption, people, status, raw, output,
    stateLabel: t(status === 'ok' ? resultLabel : `tool.${status}`),
    error: failure ? output || (settled && block.error ? `${block.error.name}: ${block.error.code}` : t('tool.error')) : '',
  }
}

function ToolIcon({ tool }: { readonly tool: TeamTool }) {
  if (tool === 'team_send') return <IconTeamSend16 size={16} />
  if (tool === 'team_task' || tool === 'team_learn') return <IconTeamTask16 size={16} />
  if (tool === 'team_wait') return <IconTeamMailbox16 size={16} />
  if (tool === 'team_note' || tool === 'team_board' || tool === 'team_profile'
    || tool === 'team_review' || tool === 'team_forget') return <IconTeamWorkspace16 size={16} />
  if (tool === 'team_relation') return <IconTeamPeer16 size={16} />
  return <IconTeam16 size={16} />
}

export function TeamToolCard(props: TeamToolCardProps) {
  const { block, toolName, sessionId, openMember, openLeader, inspect, t } = props
  const team = props.useTeam(snapshot => snapshot)
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const tool = toolName as TeamTool
  const card = useMemo(() => presentation(tool, block, team, sessionId, t), [tool, block, team, sessionId, t])
  const participantNode = (person: Participant, index: number) => {
    const { id, name, seat } = person
    const { leaderId } = team
    const portrait = <><MemberAvatar seat={seat} name={name} /><span className={css.toolPersonName}>{name}</span></>
    return id !== undefined && leaderId !== undefined ? (
      <button
        key={`${id}-${index}`}
        type="button"
        className={css.toolPerson}
        aria-label={id === leaderId ? t('member.openLeader') : t('member.open', { name })}
        title={name}
        onClick={() => {
          if (id === leaderId) openLeader(leaderId)
          else openMember(leaderId, id)
        }}
      >{portrait}</button>
    ) : <span key={index} className={css.toolPerson} title={name}>{portrait}</span>
  }

  return (
    <article className={`${theme.theme} ${css.toolCard}`} data-team-tool={tool} data-state={card.status}>
      <div className={css.toolHeader}>
        <span className={css.toolIcon}><ToolIcon tool={tool} /></span>
        <strong>{card.title}</strong>
        <span className={css.toolState} role="status">{card.stateLabel}</span>
        <button type="button" className={css.iconButton} aria-label={t(expanded ? 'tool.collapse' : 'tool.expand')} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => { setExpanded(value => !value) }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
        </button>
      </div>
      <div className={css.toolBody}>
        <div className={css.toolCopy}>
          {card.summary !== '' && <p className={css.toolSummary} title={card.summary}>{card.summary}</p>}
          {card.caption !== '' && <span className={css.toolCaption}>{card.caption}</span>}
          {card.error !== '' && <p className={css.toolError}>{card.error}</p>}
        </div>
        {card.people.length > 0 && (
          <div className={css.toolPeople} data-team-participants>
            {card.people.map((person, index) => (
              <span key={index} className={css.toolParticipant}>
                {index > 0 && <span className={css.personArrow} aria-hidden>→</span>}
                {participantNode(person, index)}
              </span>
            ))}
          </div>
        )}
      </div>
      {expanded && (
        <div id={detailsId} className={css.toolDetails}>
          {card.raw !== '' && <div><span>{t('tool.input')}</span><pre>{card.raw}</pre></div>}
          {card.output !== '' && <div><span>{t('tool.output')}</span><pre>{card.output}</pre></div>}
          {inspect !== undefined && <button type="button" className={css.inspectButton} onClick={inspect}>{t('tool.inspect')}<span aria-hidden>↗</span></button>}
        </div>
      )}
    </article>
  )
}
