/**
 * Direct teammate administration inside the conversation-header roster: invite
 * a teammate, remove one, or switch its relationship. Every action goes through
 * the host's owner-only `/api/team` routes, so it rides the same-origin cookie
 * the page already holds: this module never handles a token and never adds an
 * auth header. The roster itself still arrives from the host projection, so the
 * panel never folds sessions or keeps its own copy.
 *
 * @module dsh-team/client/TeamAdmin
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamMemberView, TeamRelation } from '../contract.ts'
import css from './TeamChat.module.css'

type Translate = PropsLocale<'team'>['t']

/** Root of the owner-only team API; every call here is same-origin and cookie-carrying. */
const TEAM_API = '/api/team'

/** The `op: 'spawn'` body of `POST /api/team/mutation`. */
interface SpawnRequest {
  session: string
  op: 'spawn'
  name: string
  task: string
  relation: TeamRelation
  role?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  skills?: readonly string[]
}

/** Text the draft form holds; skills stays a comma-separated line until submit. */
interface FormText {
  name: string
  task: string
  role: string
  provider: string
  model: string
  effort: string
  skills: string
}

const EMPTY_FORM: FormText = { name: '', task: '', role: '', provider: '', model: '', effort: '', skills: '' }

interface Notice {
  readonly kind: 'ok' | 'error'
  readonly text: string
  /** The server's stable code, kept for diagnosis rather than shown as prose. */
  readonly code?: string
}

/** The server's `{ error }` text, or the status when the body carries none. */
function failureText(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { readonly error?: unknown }).error
    if (typeof error === 'string' && error.trim() !== '') return error
  }
  return `HTTP ${status}`
}

/** A refused call: the status is what tells the panel which guidance to show. */
class TeamApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code: string | undefined) {
    super(message)
    this.name = 'TeamApiError'
    this.status = status
    this.code = code
  }
}

/** The optional stable code from an `{ error, code }` failure body. */
function failureCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const code = (payload as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * One team API call: JSON in, JSON out, non-2xx thrown with the server's own
 * text plus its status. `credentials: 'same-origin'` is the default here, and
 * it is stated so nobody later "fixes" auth by inventing a header.
 */
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${TEAM_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new TeamApiError(failureText(payload, response.status), response.status, failureCode(payload))
  return payload as T
}

/** Split the comma-separated skills line the way the host expects an array. */
function skillList(line: string): string[] {
  return line.split(',').map(skill => skill.trim()).filter(skill => skill !== '')
}

/** The spawn mutation, with blank optional fields left out entirely. */
function spawnRequest(session: string, form: FormText, relation: TeamRelation): SpawnRequest {
  const body: SpawnRequest = { session, op: 'spawn', name: form.name.trim(), task: form.task.trim(), relation }
  const role = form.role.trim()
  if (role !== '') body.role = role
  const provider = form.provider.trim()
  if (provider !== '') body.provider = provider
  const model = form.model.trim()
  if (model !== '') body.model = model
  const reasoningEffort = form.effort.trim()
  if (reasoningEffort !== '') body.reasoningEffort = reasoningEffort
  const skills = skillList(form.skills)
  if (skills.length > 0) body.skills = skills
  return body
}

/**
 * The notice a failed call deserves: 401 means the cookie is gone, 403 that the
 * fence said no, 409 that the leader is not resident or the change raced, 400
 * that the input was refused, and 502 that the service itself failed.
 */
function failureNotice(error: unknown, t: Translate): Notice {
  if (error instanceof TeamApiError) {
    const detail = error.message
    const text = ((): string => {
      switch (error.status) {
        case 401: return t('admin.error.unauthorized')
        case 403: return t('admin.error.forbidden')
        case 409: return t('admin.error.conflict')
        case 400: return t('admin.error.invalid', { message: detail })
        case 502: return t('admin.error.failed', { message: detail })
        default: return detail
      }
    })()
    return error.code === undefined ? { kind: 'error', text } : { kind: 'error', text, code: error.code }
  }
  const text = error instanceof Error && error.message.trim() !== '' ? error.message : t('admin.unknownError')
  return { kind: 'error', text }
}

export interface TeamAdminProps {
  /** Leader session id: every admin route takes it as `session`. */
  readonly sessionId: string
  /** The teammates the host currently projects; the leader is not one of them. */
  readonly members: readonly TeamMemberView[]
  readonly t: Translate
  /** Start with the draft form expanded, used by the empty-team header entry. */
  readonly defaultOpen?: boolean
}

export function TeamAdmin(props: TeamAdminProps) {
  const { sessionId, members, t } = props
  const [open, setOpen] = useState(props.defaultOpen === true)
  const [form, setForm] = useState<FormText>(EMPTY_FORM)
  const [relation, setRelation] = useState<TeamRelation>('managed')
  const [pending, setPending] = useState<string>()
  const [notice, setNotice] = useState<Notice>()
  const [invalid, setInvalid] = useState<'name' | 'task'>()
  const addButton = useRef<HTMLButtonElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const base = useId()
  const formId = `${base}-form`
  const id = (name: string): string => `${base}-${name}`

  useEffect(() => {
    if (open) firstField.current?.focus({ preventScroll: true })
  }, [open])

  const edit = (key: keyof FormText) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const value = event.target.value
    setForm(current => {
      const next = { ...current }
      next[key] = value
      return next
    })
    if (key === 'name' || key === 'task') setInvalid(current => (current === key ? undefined : current))
  }

  const closeForm = (): void => {
    setOpen(false)
    setForm(EMPTY_FORM)
    setRelation('managed')
    setInvalid(undefined)
    addButton.current?.focus({ preventScroll: true })
  }

  /** Escape leaves the draft without collapsing the whole roster panel. */
  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeForm()
  }

  const spawn = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (pending !== undefined) return
    const name = form.name.trim()
    const task = form.task.trim()
    if (name === '' || task === '') {
      const missing = name === '' ? 'name' : 'task'
      setInvalid(missing)
      setNotice({ kind: 'error', text: t(missing === 'name' ? 'admin.nameRequired' : 'admin.taskRequired') })
      return
    }
    setPending('spawn')
    setNotice(undefined)
    try {
      await request<{ readonly member: TeamMemberView }>('/mutation', spawnRequest(sessionId, form, relation))
      setForm(EMPTY_FORM)
      setRelation('managed')
      setInvalid(undefined)
      setNotice({ kind: 'ok', text: t('admin.spawned', { name }) })
    } catch (error) {
      setNotice(failureNotice(error, t))
    } finally {
      setPending(undefined)
    }
  }

  const remove = async (member: TeamMemberView): Promise<void> => {
    if (pending !== undefined) return
    setPending(member.memberId)
    setNotice(undefined)
    try {
      await request('/mutation', { session: sessionId, op: 'dismiss', memberId: member.memberId })
      setNotice({ kind: 'ok', text: t('admin.dismissed', { name: member.name }) })
    } catch (error) {
      setNotice(failureNotice(error, t))
    } finally {
      setPending(undefined)
    }
  }

  const switchRelation = async (member: TeamMemberView, next: TeamRelation): Promise<void> => {
    if (pending !== undefined) return
    setPending(member.memberId)
    setNotice(undefined)
    try {
      await request('/mutation', { session: sessionId, op: 'setRelation', memberId: member.memberId, relation: next })
      setNotice({ kind: 'ok', text: t('admin.relationChanged', { name: member.name, relation: t(`relation.${next}`) }) })
    } catch (error) {
      setNotice(failureNotice(error, t))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <section className={css.admin} aria-label={t('admin.title')} data-team-admin>
      <div className={css.adminHead}>
        <span className={css.adminTitle}>{t('admin.title')}</span>
        <button
          ref={addButton}
          type="button"
          className={css.adminAdd}
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          onClick={() => {
            if (open) closeForm()
            else {
              setNotice(undefined)
              setOpen(true)
            }
          }}
        >
          <span aria-hidden>+</span>{t('admin.add')}
        </button>
      </div>
      {notice !== undefined && (
        <p
          className={css.adminNotice}
          data-kind={notice.kind}
          data-code={notice.code}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      {open && (
        <form
          id={formId}
          className={css.adminForm}
          aria-label={t('admin.form')}
          onSubmit={event => { void spawn(event) }}
          onKeyDown={onFormKeyDown}
        >
          <div className={css.adminFields}>
            <div className={`${css.adminField} ${css.adminWide}`}>
              <label className={css.adminLabel} htmlFor={id('name')}>{t('admin.name')}</label>
              <input
                ref={firstField}
                id={id('name')}
                className={css.adminInput}
                value={form.name}
                onChange={edit('name')}
                placeholder={t('admin.namePlaceholder')}
                aria-required
                aria-invalid={invalid === 'name'}
                autoComplete="off"
              />
            </div>
            <div className={`${css.adminField} ${css.adminWide}`}>
              <label className={css.adminLabel} htmlFor={id('task')}>{t('admin.task')}</label>
              <textarea
                id={id('task')}
                className={`${css.adminInput} ${css.adminTextarea}`}
                rows={3}
                value={form.task}
                onChange={edit('task')}
                placeholder={t('admin.taskPlaceholder')}
                aria-required
                aria-invalid={invalid === 'task'}
              />
            </div>
            <div className={css.adminField}>
              <label className={css.adminLabel} htmlFor={id('relation')}>{t('admin.relation')}</label>
              <select
                id={id('relation')}
                className={css.adminInput}
                value={relation}
                onChange={event => { setRelation(event.target.value === 'peer' ? 'peer' : 'managed') }}
              >
                <option value="managed">{t('relation.managed')}</option>
                <option value="peer">{t('relation.peer')}</option>
              </select>
            </div>
            <div className={css.adminField}>
              <label className={css.adminLabel} htmlFor={id('role')}>{t('admin.role')}</label>
              <input
                id={id('role')}
                className={css.adminInput}
                value={form.role}
                onChange={edit('role')}
                placeholder={t('admin.rolePlaceholder')}
                autoComplete="off"
              />
            </div>
            <div className={css.adminField}>
              <label className={css.adminLabel} htmlFor={id('provider')}>{t('admin.provider')}</label>
              <input
                id={id('provider')}
                className={css.adminInput}
                value={form.provider}
                onChange={edit('provider')}
                placeholder={t('admin.placeholderFollow')}
                autoComplete="off"
              />
            </div>
            <div className={css.adminField}>
              <label className={css.adminLabel} htmlFor={id('model')}>{t('admin.model')}</label>
              <input
                id={id('model')}
                className={css.adminInput}
                value={form.model}
                onChange={edit('model')}
                placeholder={t('admin.placeholderFollow')}
                autoComplete="off"
              />
            </div>
            <div className={css.adminField}>
              <label className={css.adminLabel} htmlFor={id('effort')}>{t('admin.effort')}</label>
              <input
                id={id('effort')}
                className={css.adminInput}
                value={form.effort}
                onChange={edit('effort')}
                placeholder={t('admin.effortPlaceholder')}
                autoComplete="off"
              />
            </div>
            <div className={`${css.adminField} ${css.adminWide}`}>
              <label className={css.adminLabel} htmlFor={id('skills')}>{t('admin.skills')}</label>
              <input
                id={id('skills')}
                className={css.adminInput}
                value={form.skills}
                onChange={edit('skills')}
                placeholder={t('admin.skillsPlaceholder')}
                autoComplete="off"
              />
            </div>
          </div>
          <div className={css.adminActions}>
            <button type="button" className={css.adminGhost} onClick={closeForm}>{t('admin.cancel')}</button>
            <button type="submit" className={css.adminPrimary} disabled={pending === 'spawn'}>
              {pending === 'spawn' ? t('admin.submitting') : t('admin.submit')}
            </button>
          </div>
        </form>
      )}
      <div className={css.adminMembers} role="group" aria-label={t('admin.members')}>
        {members.length === 0
          ? <p className={css.adminEmpty}>{t('admin.noMembers')}</p>
          : members.map(member => {
            const next: TeamRelation = member.relation === 'peer' ? 'managed' : 'peer'
            const busy = pending === member.memberId
            return (
              <div
                key={member.memberId}
                className={css.adminMember}
                data-member-id={member.memberId}
                data-pending={busy}
              >
                <span className={css.adminMemberName}>{member.name}</span>
                <span className={css.adminMemberMeta}>
                  <span data-relation={member.relation}>{t(`relation.${member.relation}`)}</span>
                  {member.role !== undefined && member.role !== '' ? ` · ${member.role}` : ''}
                </span>
                <span className={css.adminMemberActions}>
                  <button
                    type="button"
                    className={css.adminMiniButton}
                    aria-label={t('admin.switchRelation', { name: member.name, relation: t(`relation.${next}`) })}
                    disabled={pending !== undefined}
                    onClick={() => { void switchRelation(member, next) }}
                  >
                    {t(`relation.${next}`)}
                  </button>
                  <button
                    type="button"
                    className={css.adminMiniButton}
                    data-danger
                    aria-label={t('admin.remove', { name: member.name })}
                    disabled={pending !== undefined}
                    onClick={() => { void remove(member) }}
                  >
                    {t('admin.removeLabel')}
                  </button>
                </span>
              </div>
            )
          })}
      </div>
    </section>
  )
}
