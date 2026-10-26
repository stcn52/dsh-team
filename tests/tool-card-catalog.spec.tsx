/** @vitest-environment jsdom */
/**
 * The card catalog: every tool the host registers has a card here, and the
 * cards for the wait and dossier tools read their results without dumping raw
 * JSON into the conversation.
 *
 * Two of these tests are the reason this file exists:
 *
 * - the completeness test re-reads `src/tools.ts`, so a tool added on the host
 *   side fails here instead of silently degrading to the generic row;
 * - the reader tests feed the REAL `output.render` sentences of `src/tools.ts`
 *   into the client readers, so the text patterns those readers rely on are
 *   pinned to what the host actually prints rather than to a copy of it.
 *
 * @module dsh-team/tests/tool-card-catalog
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { useSyncExternalStore } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { TEAM_TOOLS, TEAM_TOOL_NAMES, TeamToolCard, type TeamToolCardProps } from '../src/client/TeamToolCard.tsx'
import type { TeamPanelState } from '../src/client/TeamStage.tsx'
import { en, type TeamKey } from '../src/client/locales.ts'
import { dossierReport, waitReport } from '../src/client/toolResult.ts'
import type { MemberDossiers } from '../src/dossier.ts'
import { forgetTool, profileTool, reviewTool, waitTool } from '../src/tools.ts'

afterEach(cleanup)

const alice = { memberId: 'alice', name: 'Alice', role: 'Reviewer', relation: 'peer' as const, joinedAt: 1 }
const bob = { memberId: 'bob', name: 'Bob', role: 'Developer', relation: 'managed' as const, joinedAt: 2 }
const state: TeamPanelState = { leaderId: 'leader', currentId: 'leader', members: [alice, bob], tasks: [], messages: [], board: [] }

function t(key: TeamKey, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, String(value)), en[key])
}

function hook<T>(store: SnapshotStore<T>): SnapshotSelectorHook<T> {
  return select => select(useSyncExternalStore(store.subscribe, store.getSnapshot))
}

/** One settled call as the conversation view builds it. */
function result(name: string, args: Record<string, unknown>, extra: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', callId: 'call-1', name, args: PartialArguments.fromText(JSON.stringify(args)),
    call: { name, argsRaw: JSON.stringify(args) },
    seq: 2, time: 2000, callTime: 1000, content: [], isError: false, subCalls: [], ...extra,
  }
}

/** One still-running call, whose arguments may not have finished arriving. */
function started(name: string, args: Record<string, unknown>): ToolCallBlock {
  const raw = JSON.stringify(args)
  return { phase: 'start', callId: 'call-1', name, argsRaw: raw, args: PartialArguments.fromText(raw), time: 1000, turn: 1, step: 1, subCalls: [] }
}

function toolCard(toolName: string, block: ToolCallBlock): ReturnType<typeof render> {
  const team = createSnapshotStore(state)
  const props = {
    sessionId: 'leader', callId: 'call-1', toolName, block, useTeam: hook(team),
    openMember: () => {}, openLeader: () => {}, inspect: () => {}, t,
  } as unknown as TeamToolCardProps
  return render(<TeamToolCard {...props} />)
}

/** The text of a tool's rendered output, exactly as the conversation folds it. */
function rendered(view: ToolOutputDefinition, args: unknown, value: unknown): string {
  return view.render(args, value as never)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('the team tool catalog', () => {
  it('covers every tool the host registers, so no card falls back to raw JSON', async () => {
    // Read from the project root rather than `import.meta.url`: the jsdom pool
    // rewrites module URLs, so a file URL cannot be derived from it here.
    const source = await readFile(resolve(process.cwd(), 'src/tools.ts'), 'utf8')
    const registered = [...source.matchAll(/\bname: '(team_[a-z0-9_]+)'/gu)].map(match => match[1]!)
    const unique = [...new Set(registered)]

    // The host half registers team_profile twice (leader and member audience).
    expect(registered.length).toBeGreaterThan(unique.length)
    // Both directions: nothing registered is missing a card, and no card is stale.
    expect([...TEAM_TOOL_NAMES].sort()).toEqual(unique.sort())
    expect([...TEAM_TOOLS].sort()).toEqual(unique.sort())
    expect(new Set(TEAM_TOOLS).size).toBe(TEAM_TOOLS.length)
    expect(new Set(TEAM_TOOL_NAMES).size).toBe(TEAM_TOOL_NAMES.length)
  })

  it.each([...TEAM_TOOL_NAMES])('renders a titled, labelled card for %s', (tool) => {
    const view = toolCard(tool, result(tool, {}))

    expect(view.container.querySelector('strong')?.textContent).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBeTruthy()
    expect(view.container.querySelector('article')?.getAttribute('data-team-tool')).toBe(tool)
  })
})

describe('team_wait card', () => {
  it('reports how many settled, who is still working, and that the budget ran out', () => {
    toolCard('team_wait', result('team_wait', { members: ['Alice', 'Bob'] }, {
      content: [{ type: 'text', text: 'timed out — still busy: Bob; never started: Carol; finished: Alice' }],
    }))

    expect(screen.getByText('1 finished · 1 still working · 1 no live session · Timed out')).toBeTruthy()
    expect(screen.getByText('Still working: Bob · No live session: Carol')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Waited')
  })

  it('names the request while the wait is still blocking', () => {
    toolCard('team_wait', started('team_wait', { members: ['Alice', 'Bob'] }))

    expect(screen.getByText('Waiting for Alice, Bob')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('In progress')
  })

  it('reads the not-resident list from a projected fact, and tolerates its absence', () => {
    toolCard('team_wait', result('team_wait', {}, {
      meta: { team: 'wait', done: ['Alice'], busy: [], cold: ['Carol'], timedOut: false },
    }))

    expect(screen.getByText('1 finished · 1 no live session')).toBeTruthy()
    expect(screen.getByText('No live session: Carol')).toBeTruthy()
  })

  it('still says something when the result carries neither a fact nor a sentence', () => {
    toolCard('team_wait', result('team_wait', {}))

    expect(screen.getByText('No one to wait for')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Waited')
  })
})

describe('dossier cards', () => {
  it('shows the lesson and its evidence instead of the raw arguments', () => {
    const view = toolCard('team_learn', result('team_learn', {
      kind: 'lesson',
      text: 'Read the failing spec before the source',
      evidence: 'vitest run printed one red test',
    }))

    expect(screen.getByText('Read the failing spec before the source')).toBeTruthy()
    expect(screen.getByText('Lesson · Evidence: vitest run printed one red test')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Recorded')
    // The JSON stays behind the disclosure, not in the card's reading surface.
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it('shows whose dossier it is, the totals, and the entry count', () => {
    toolCard('team_profile', result('team_profile', { member: 'alice' }, {
      content: [{ type: 'text', text: 'Alice: 2 delivered, 1 reworked, 5 entries\n[e1 lesson] ship it (evidence: tests)' }],
    }))

    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.getByText('2 delivered · 1 reworked · 5 entries')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Read')
  })

  it('says a name carries no dossier at all', () => {
    toolCard('team_profile', result('team_profile', { member: 'bob' }, {
      content: [{ type: 'text', text: 'Bob has no dossier yet — nothing recorded under this name' }],
    }))

    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0)
    expect(screen.getByText('No dossier yet for this member')).toBeTruthy()
  })

  it('shows the verdict and the feedback a review recorded', () => {
    toolCard('team_review', result('team_review', {
      member: 'Alice', outcome: 'accepted', note: 'Ship the second half as its own change',
    }))

    expect(screen.getByText('Ship the second half as its own change')).toBeTruthy()
    expect(screen.getByText('Outcome: accepted')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Reviewed')
  })

  it('shows the dropped entry, whose dossier it left, and what remains', () => {
    toolCard('team_forget', result('team_forget', { member: 'Alice', entry_id: 'e3' }, {
      content: [{ type: 'text', text: 'dropped entry e3; 4 entries left in the dossier' }],
    }))

    expect(screen.getByText('e3')).toBeTruthy()
    expect(screen.getByText('Dropped from Alice’s dossier · 4 left')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Forgotten')
  })

  it('keeps a failure to prose and drops the success caption', () => {
    toolCard('team_review', result('team_review', { member: 'Alice', outcome: 'rework' }, {
      isError: true,
      content: [{ type: 'text', text: 'Alice is no longer on the team' }],
    }))

    expect(screen.getByRole('status').textContent).toBe('Failed')
    expect(screen.getByText('Alice is no longer on the team')).toBeTruthy()
    expect(screen.queryByText('Outcome: rework')).toBeNull()
  })
})

describe('the result readers', () => {
  /** A ctx whose only service is the wait double these definitions never call. */
  function ctxOf(): Context {
    const ctx = new Context()
    ctx.provide('team', { wait: async () => ({ done: [], busy: [], timedOut: false }) })
    return ctx
  }

  /** Definitions only: constructing them never opens storage or reads a dossier. */
  const dossiers = {} as unknown as MemberDossiers
  const nameOf = (): string => 'Alice'

  it('reads the sentences the wait tool really renders', () => {
    const tool = waitTool(ctxOf())
    const timedOut = { done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true }
    const finished = { done: ['Alice', 'Bob'], busy: [], cold: [], timedOut: false }

    expect(waitReport(undefined, rendered(tool.output, {}, timedOut)))
      .toEqual({ done: ['Alice'], busy: ['Bob'], cold: ['Carol'], timedOut: true })
    expect(waitReport(undefined, rendered(tool.output, {}, finished)))
      .toEqual({ done: ['Alice', 'Bob'] })
    expect(waitReport(undefined, rendered(tool.output, {}, { done: [], busy: [], cold: [], timedOut: false })))
      .toEqual({})
  })

  it('reads the sentences the dossier tools really render', () => {
    const profile = profileTool(dossiers, 'leader', nameOf)
    const held = { name: 'Alice', stats: { delivered: 2, reworks: 1 }, entries: [{ id: 'e1', kind: 'lesson', text: 'x', evidence: 'y' }] }
    const empty = { name: 'Alice', stats: { delivered: 0, reworks: 0 }, entries: [] }
    const forget = forgetTool(dossiers, nameOf)
    const review = reviewTool(dossiers, nameOf)

    expect(dossierReport(undefined, rendered(profile.output, {}, held)))
      .toEqual({ name: 'Alice', delivered: 2, reworks: 1, entries: 1 })
    expect(dossierReport(undefined, rendered(profile.output, {}, empty)))
      .toEqual({ name: 'Alice', empty: true })
    expect(dossierReport(undefined, rendered(forget.output, {}, { removed: 'e3', remaining: 4 })))
      .toEqual({ removed: 'e3', remaining: 4 })
    // A review result has no entry list: it must not read as a profile.
    expect(dossierReport(undefined, rendered(review.output, {}, { name: 'Alice', stats: { delivered: 2, reworks: 1 } })))
      .toEqual({ name: 'Alice', delivered: 2, reworks: 1 })
  })

  it('prefers a projected fact, including the not-resident list', () => {
    expect(waitReport({ team: 'wait', done: [], busy: ['Bob'], cold: ['Carol'], timedOut: true }, 'ignored'))
      .toEqual({ done: [], busy: ['Bob'], cold: ['Carol'], timedOut: true })
    expect(dossierReport({ stats: { delivered: 3, reworks: 0 }, entries: 4 }, 'ignored'))
      .toEqual({ delivered: 3, reworks: 0, entries: 4 })
  })

  it('treats an unrecognised shape as absent rather than as a guess', () => {
    expect(waitReport(undefined, '')).toEqual({})
    expect(waitReport({ team: 'wait', done: 'nope', busy: [1, 'Bob'] }, '')).toEqual({ busy: ['Bob'] })
    expect(waitReport(null, '{"done":["Alice"]}')).toEqual({})
    expect(dossierReport(null, '{"stats":{"delivered":2}}')).toEqual({})
    expect(dossierReport({ name: 42, stats: 'nope' }, 'a line nobody renders')).toEqual({})
  })
})
