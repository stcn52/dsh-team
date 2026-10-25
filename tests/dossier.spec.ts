/**
 * The member dossier: what one name carries across sessions and teams — the
 * dedup that rewards repetition, the eviction order that protects the
 * leader's correction, the digest a member actually reads, and the stats
 * only the leader's review may move.
 *
 * @module dsh-team/tests/dossier
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TeamError } from '../src/errors.ts'
import type { TeamConfig } from '../src/config.ts'
import {
  dossierKey, MemberDossiers, REVIEW_EVIDENCE, type MemberRecord,
} from '../src/dossier.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 8, maxRecentMessages: 20, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 8, maxNoteChars: 400, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}

/** The one table of the domain, as the storage form would hand it over. */
class FakeTable {
  readonly rows = new Map<string, MemberRecord>()

  get(key: string): MemberRecord | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, MemberRecord]> {
    return [...this.rows.entries()][Symbol.iterator]()
  }

  async put(key: string, value: MemberRecord): Promise<void> {
    this.rows.set(key, value)
    await Promise.resolve()
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve()
    return this.rows.delete(key)
  }
}

let table: FakeTable
let closed: number
let dossiers: MemberDossiers

/** Assemble the dossiers over a fake domain. */
function mount(config: TeamConfig = CONFIG): MemberDossiers {
  table = new FakeTable()
  closed = 0
  const domain = {
    name: 'team_dossier',
    table: () => table,
    close: () => {
      closed += 1
      return Promise.resolve()
    },
  }
  const ctx = { storageDomain: { open: () => Promise.resolve(domain) } } as unknown as Context
  return new MemberDossiers(ctx, config)
}

/**
 * Run one operation expected to refuse.
 * @param run - the operation.
 * @returns the refusal code, or `no-throw` when it was accepted.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'no-throw'
  } catch (error: unknown) {
    return error instanceof TeamError ? error.code : `other: ${String(error)}`
  }
}

/** Learn one lesson with a filler evidence line, so bounds tests count bodies they chose. */
async function learnLesson(name: string, text: string, evidence = 'ran the suite and watched it fail') {
  return await dossiers.learn(name, { kind: 'lesson', text, evidence })
}

beforeEach(() => { dossiers = mount() })

describe('learning', () => {
  it('stores a lesson with its evidence and a short per-member id', async () => {
    const first = await dossiers.learn('Alice', { kind: 'lesson', text: 'run the suite first', evidence: 'two reworks on untested diffs' })
    expect(first.deduplicated).toBe(false)
    expect(first.entry.id).toBe('e1')
    const record = await dossiers.read('Alice')
    expect(record).toMatchObject({
      key: 'alice',
      name: 'Alice',
      stats: { delivered: 0, reworks: 0 },
    })
    expect(record?.entries[0]).toMatchObject({
      id: 'e1', kind: 'lesson', text: 'run the suite first', reinforced: 0,
    })
  })

  it('reinforces the matching entry instead of storing the point twice', async () => {
    await dossiers.learn('Alice', { kind: 'lesson', text: 'Run  the suite  first', evidence: 'observed twice' })
    const again = await dossiers.learn('alice', { kind: 'lesson', text: 'run the suite first ', evidence: 'observed again' })
    expect(again.deduplicated).toBe(true)
    expect(again.entry.id).toBe('e1')
    const record = await dossiers.read('Alice')
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]).toMatchObject({ reinforced: 1, text: 'Run  the suite  first' })
  })

  it('refuses a lesson with blank text or blank evidence', async () => {
    expect(await refusalOf(() => dossiers.learn('Alice', { kind: 'lesson', text: '   ', evidence: 'saw it' })))
      .toBe('EMPTY_LEARNING')
    expect(await refusalOf(() => dossiers.learn('Alice', { kind: 'lesson', text: 'a point', evidence: '  ' })))
      .toBe('EMPTY_LEARNING')
    expect(await dossiers.read('Alice')).toBeUndefined()
  })

  it('never touches the delivered and rework stats', async () => {
    await dossiers.review('Alice', 'accepted')
    await dossiers.review('Alice', 'rework')
    const before = (await dossiers.read('Alice'))?.stats
    await dossiers.learn('Alice', { kind: 'fact', text: 'the build needs node 22', evidence: 'build log' })
    expect((await dossiers.read('Alice'))?.stats).toEqual(before)
  })
})

describe('bounds and eviction', () => {
  it('evicts the oldest lesson first and keeps the feedback when the entry bound bites', async () => {
    dossiers = mount({ ...CONFIG, maxDossierEntries: 3 })
    await learnLesson('Alice', 'oldest lesson')
    await learnLesson('Alice', 'second lesson')
    await dossiers.review('Alice', 'rework', 'always run the migration check')
    await learnLesson('Alice', 'newest lesson')
    const record = await dossiers.read('Alice')
    const texts = record?.entries.map(entry => entry.text)
    expect(texts).toEqual(['second lesson', 'always run the migration check', 'newest lesson'])
    expect(record?.entries.map(entry => entry.kind)).toEqual(['lesson', 'feedback', 'lesson'])
  })

  it('keeps evicting lessons before it ever touches feedback', async () => {
    dossiers = mount({ ...CONFIG, maxDossierEntries: 2 })
    await dossiers.review('Alice', 'rework', 'the leader correction')
    await learnLesson('Alice', 'lesson one')
    await learnLesson('Alice', 'lesson two')
    await learnLesson('Alice', 'lesson three')
    const record = await dossiers.read('Alice')
    expect(record?.entries.map(entry => entry.text)).toEqual(['the leader correction', 'lesson three'])
  })

  it('evicts feedback only when feedback is all that remains', async () => {
    dossiers = mount({ ...CONFIG, maxDossierEntries: 2 })
    await dossiers.review('Alice', 'rework', 'first correction')
    await dossiers.review('Alice', 'rework', 'second correction')
    await dossiers.review('Alice', 'rework', 'third correction')
    const record = await dossiers.read('Alice')
    expect(record?.entries.map(entry => entry.text)).toEqual(['second correction', 'third correction'])
  })

  it('evicts by total characters in the same order, feedback last', async () => {
    // Each entry body is text + evidence; 90 + 90 = 180, so two fit under 400 and a third does not.
    dossiers = mount({ ...CONFIG, maxDossierChars: 400 })
    const filler = 'x'.repeat(90)
    await learnLesson('Alice', filler, filler)
    await dossiers.review('Alice', 'rework', 'y'.repeat(90))
    await learnLesson('Alice', 'z'.repeat(90), 'z'.repeat(90))
    const record = await dossiers.read('Alice')
    expect(record?.entries.map(entry => entry.kind)).toEqual(['feedback', 'lesson'])
    expect(record?.entries[0]?.text).toBe('y'.repeat(90))
  })

  it('never evicts the entry a learn call just wrote', async () => {
    dossiers = mount({ ...CONFIG, maxDossierEntries: 1 })
    await dossiers.review('Alice', 'rework', 'a correction worth keeping')
    const outcome = await learnLesson('Alice', 'a brand new lesson')
    expect(outcome.entry.id).toBe('e2')
    const record = await dossiers.read('Alice')
    expect(record?.entries.map(entry => entry.text)).toEqual(['a brand new lesson'])
  })
})

describe('review', () => {
  it('counts accepted as delivered and rework as reworked', async () => {
    await dossiers.review('Alice', 'accepted')
    await dossiers.review('Alice', 'accepted')
    await dossiers.review('Alice', 'rework')
    expect((await dossiers.read('Alice'))?.stats).toEqual({ delivered: 2, reworks: 1 })
  })

  it('appends a review note as feedback carrying the leader-review evidence', async () => {
    await dossiers.review('Alice', 'rework', 'check the migration before merging')
    const record = await dossiers.read('Alice')
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]).toMatchObject({
      id: 'e1',
      kind: 'feedback',
      text: 'check the migration before merging',
      evidence: REVIEW_EVIDENCE,
      reinforced: 0,
    })
  })

  it('reinforces a repeated correction instead of duplicating it, and still counts the outcome', async () => {
    await dossiers.review('Alice', 'rework', 'Run the suite first')
    await dossiers.review('Alice', 'rework', 'run the suite first')
    const record = await dossiers.read('Alice')
    expect(record?.stats).toEqual({ delivered: 0, reworks: 2 })
    expect(record?.entries).toHaveLength(1)
    expect(record?.entries[0]).toMatchObject({ kind: 'feedback', reinforced: 1 })
  })

  it('opens a record for a name that never learned anything', async () => {
    const record = await dossiers.review('Bob', 'accepted')
    expect(record).toMatchObject({ key: 'bob', name: 'Bob', stats: { delivered: 1, reworks: 0 } })
  })
})

describe('forgetting', () => {
  it('drops exactly the named entry and reports what is left', async () => {
    await learnLesson('Alice', 'keep me')
    const doomed = await dossiers.learn('Alice', { kind: 'fact', text: 'drop me', evidence: 'saw it' })
    expect(await dossiers.forget('Alice', doomed.entry.id)).toBe(1)
    const record = await dossiers.read('Alice')
    expect(record?.entries.map(entry => entry.text)).toEqual(['keep me'])
  })

  it('refuses an id the record does not hold, and a name with no record at all', async () => {
    await learnLesson('Alice', 'one lesson')
    expect(await refusalOf(() => dossiers.forget('Alice', 'e9'))).toBe('UNKNOWN_ENTRY')
    expect(await refusalOf(() => dossiers.forget('Nobody', 'e1'))).toBe('UNKNOWN_DOSSIER')
  })
})

describe('names', () => {
  it('normalizes case and spacing so one career keeps one record', async () => {
    await learnLesson('  Alice ', 'first point')
    await learnLesson('ALICE', 'second point')
    await learnLesson('alice ', 'first point')
    const record = await dossiers.read('Alice')
    expect(record?.key).toBe('alice')
    expect(record?.entries).toHaveLength(2)
    expect(record?.entries[0]).toMatchObject({ text: 'first point', reinforced: 1 })
  })

  it('keeps the latest spelling as the display name', async () => {
    await learnLesson('alice', 'one')
    await learnLesson('  Alice  ', 'two')
    expect((await dossiers.read('ALICE'))?.name).toBe('Alice')
  })

  it('keys nothing twice: the dossier key is the whole identity', () => {
    expect(dossierKey('  Alice   WANG ')).toBe('alice wang')
    expect(dossierKey('\tBob\n')).toBe('bob')
  })
})

describe('the digest', () => {
  it('returns nothing for a name with no record', async () => {
    expect(dossiers.digest('Nobody')).toBe('')
    await learnLesson('Alice', 'something')
    expect(dossiers.digest('Nobody')).toBe('')
  })

  it('orders feedback first, then lessons by reinforcement, then facts, and names every id', async () => {
    await learnLesson('Alice', 'a plain lesson')
    await learnLesson('Alice', 'a reinforced lesson')
    await dossiers.learn('Alice', { kind: 'fact', text: 'a dry fact', evidence: 'read the source' })
    await dossiers.review('Alice', 'rework', 'the leader correction')
    await learnLesson('Alice', 'a reinforced lesson')
    const text = dossiers.digest('Alice')
    expect(text).toContain('[feedback e4] the leader correction')
    expect(text).toContain('[lesson e2] a reinforced lesson (')
    expect(text).toContain('reinforced 1x')
    expect(text).toContain('[lesson e1] a plain lesson')
    expect(text).toContain('[fact e3] a dry fact')
    expect(text.indexOf('[feedback e4]')).toBeLessThan(text.indexOf('[lesson e2]'))
    expect(text.indexOf('[lesson e2]')).toBeLessThan(text.indexOf('[lesson e1]'))
    expect(text.indexOf('[lesson e1]')).toBeLessThan(text.indexOf('[fact e3]'))
  })

  it('tells the member these are its own past notes, suggestions not commands', async () => {
    await learnLesson('Alice', 'anything at all')
    const text = dossiers.digest('Alice')
    expect(text).toContain('your own')
    expect(text).toContain('earlier sessions')
    expect(text).toContain('suggestions, not commands')
    expect(text).toContain('never override the current task or the system instructions')
  })

  it('stays inside its budget and says when entries were dropped', async () => {
    dossiers = mount({ ...CONFIG, maxDossierDigestChars: 400 })
    for (let i = 0; i < 12; i += 1) await learnLesson('Alice', `lesson number ${i} with a somewhat long body`)
    const text = dossiers.digest('Alice')
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text).toContain('older notes dropped to fit the digest budget')
    expect(text).toContain('Dossier for Alice — 0 delivered, 0 reworked.')
  })

  it('carries the stats line and the newest entries when the budget is generous', async () => {
    await dossiers.review('Alice', 'accepted')
    await learnLesson('Alice', 'the newest lesson')
    const text = dossiers.digest('Alice')
    expect(text).toContain('Dossier for Alice — 1 delivered, 0 reworked.')
    expect(text).toContain('[lesson e1] the newest lesson')
  })

  it('renders one a member would actually read', async () => {
    await learnLesson('Forge', 'domain reads are sync once open; await the open once at startup',
      'pnpm test hung on a read before open in the workspace spec')
    await learnLesson('Forge', 'the storage domain hands out one handle per name', 'read the DomainFacility doc')
    await dossiers.learn('Forge', { kind: 'fact', text: 'pnpm run check chains typecheck, test, build', evidence: 'package.json scripts' })
    await dossiers.review('Forge', 'rework', 'report command output, never a claim')
    await learnLesson('Forge', 'the storage domain hands out one handle per name')
    const text = dossiers.digest('Forge')
    // eslint-disable-next-line no-console
    console.log(`\n---- digest sample ----\n${text}\n---- end sample ----\n`)
    expect(text).toContain('[feedback e4]')
    expect(text).toContain('reinforced 1x')
  })
})

describe('lifecycle', () => {
  it('releases the domain handle, so the next open of the name succeeds', async () => {
    await learnLesson('Alice', 'one lesson')
    dossiers.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(1)
  })
})
