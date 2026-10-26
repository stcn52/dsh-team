/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamMemberView } from '../contract.ts'
import { TeamAdmin, type TeamAdminProps } from './TeamAdmin.tsx'
import { en, type TeamKey } from './locales.ts'

function t(key: TeamKey, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, String(value)), en[key])
}

const alice: TeamMemberView = { memberId: 'member-1', name: 'Alice', role: 'reviewer', relation: 'managed', joinedAt: 1 }

/** The shape `request()` reads off a fetch result. */
function reply(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(members: readonly TeamMemberView[] = []): void {
  render(<TeamAdmin sessionId="leader-1" members={members} t={t as unknown as TeamAdminProps['t']} />)
}

function addButton(): HTMLElement {
  return screen.getByRole('button', { name: en['admin.add'] })
}

function openForm(): void {
  fireEvent.click(addButton())
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText(en['admin.name']) as HTMLInputElement
}

function taskField(): HTMLTextAreaElement {
  return screen.getByLabelText(en['admin.task']) as HTMLTextAreaElement
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: en['admin.submit'] })
}

/** Every documented refusal, with the guidance the panel must show for it. */
const refusals: readonly (readonly [number, string])[] = [
  [401, en['admin.error.unauthorized']],
  [403, en['admin.error.forbidden']],
  [409, en['admin.error.conflict']],
  [400, 'Invalid request: memberId is required'],
  [502, 'Service failure: provider unavailable'],
]

describe('team admin', () => {
  it('posts the draft as a spawn request with skills split and blanks trimmed', async () => {
    fetchMock.mockResolvedValueOnce(reply({ member: alice }))
    mount()
    openForm()
    fireEvent.change(nameField(), { target: { value: '  Alice ' } })
    fireEvent.change(taskField(), { target: { value: 'Review the storage layer ' } })
    fireEvent.change(screen.getByLabelText(en['admin.relation']), { target: { value: 'peer' } })
    fireEvent.change(screen.getByLabelText(en['admin.role']), { target: { value: ' reviewer ' } })
    fireEvent.change(screen.getByLabelText(en['admin.provider']), { target: { value: 'deepseek' } })
    fireEvent.change(screen.getByLabelText(en['admin.model']), { target: { value: 'deepseek-flash' } })
    fireEvent.change(screen.getByLabelText(en['admin.effort']), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText(en['admin.skills']), { target: { value: 'deep-brief, work ,, review' } })
    fireEvent.click(submitButton())

    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Alice joined the team') })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/team/mutation')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      session: 'leader-1',
      op: 'spawn',
      name: 'Alice',
      task: 'Review the storage layer',
      relation: 'peer',
      role: 'reviewer',
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      skills: ['deep-brief', 'work', 'review'],
    })
    expect(nameField().value).toBe('')
    expect(taskField().value).toBe('')
  })

  it('leaves blank optional fields out of the spawn body', async () => {
    fetchMock.mockResolvedValueOnce(reply({ member: alice }))
    mount()
    openForm()
    fireEvent.change(nameField(), { target: { value: 'Lin' } })
    fireEvent.change(taskField(), { target: { value: 'Write the RFC' } })
    fireEvent.click(submitButton())

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      session: 'leader-1', op: 'spawn', name: 'Lin', task: 'Write the RFC', relation: 'managed',
    })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Lin joined the team') })
  })

  it('shows a service failure with the server detail and keeps the draft', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'provider capacity exhausted', code: 'spawn-failed' }, 502))
    mount()
    openForm()
    fireEvent.change(nameField(), { target: { value: 'Alice' } })
    fireEvent.change(taskField(), { target: { value: 'Review' } })
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Service failure: provider capacity exhausted')
    })
    expect(screen.getByRole('alert').getAttribute('data-code')).toBe('spawn-failed')
    expect(nameField().value).toBe('Alice')
    expect(taskField().value).toBe('Review')
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a missing name or task without calling the server', async () => {
    mount()
    openForm()
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Give the teammate a name first.')
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nameField().getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(nameField(), { target: { value: 'Alice' } })
    expect(nameField().getAttribute('aria-invalid')).toBe('false')
    fireEvent.click(submitButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Describe the first task.')
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes a teammate through the dismiss route', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ended: true, memberId: alice.memberId }))
    mount([alice])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' }))

    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Alice was removed') })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/team/mutation')
    expect(JSON.parse(String(init.body))).toEqual({ session: 'leader-1', op: 'dismiss', memberId: 'member-1' })
  })

  it('switches a managed teammate to peer through the relation route', async () => {
    fetchMock.mockResolvedValueOnce(reply({ member: { ...alice, relation: 'peer' } }))
    mount([alice])
    fireEvent.click(screen.getByRole('button', { name: 'Switch Alice to Peer' }))

    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Alice is now Peer') })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/team/mutation')
    expect(JSON.parse(String(init.body))).toEqual({ session: 'leader-1', op: 'setRelation', memberId: 'member-1', relation: 'peer' })
  })

  it.each(refusals)('turns an HTTP %i refusal into the guidance it promises', async (status, expected) => {
    const detail = status === 400 ? 'memberId is required' : 'provider unavailable'
    fetchMock.mockResolvedValueOnce(reply({ error: detail, code: `refused-${status}` }, status))
    mount([alice])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(expected) })
    expect(screen.getByRole('alert').getAttribute('data-code')).toBe(`refused-${status}`)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('focuses the first field when the form opens and Escape closes only the draft', () => {
    mount([alice])
    openForm()
    expect(document.activeElement).toBe(nameField())

    fireEvent.keyDown(nameField(), { key: 'Escape' })

    expect(screen.queryByLabelText(en['admin.name'])).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Alice' })).toBeTruthy()
    expect(document.activeElement).toBe(addButton())
  })

  it('disables the invite while the request is in flight', async () => {
    let settle: ((value: Response) => void) | undefined
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve }))
    mount()
    openForm()
    fireEvent.change(nameField(), { target: { value: 'Bob' } })
    fireEvent.change(taskField(), { target: { value: 'Ship it' } })
    fireEvent.click(submitButton())

    const inFlight = screen.getByRole('button', { name: en['admin.submitting'] }) as HTMLButtonElement
    expect(inFlight.disabled).toBe(true)

    await act(async () => { settle?.(reply({ member: alice })) })

    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('Bob joined the team')
  })
})
