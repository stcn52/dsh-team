/**
 * The virtual workspaces: what a note is worth once it is stored, what the
 * bounds refuse, and what the leader's panel gets to see.
 *
 * @module dsh-team/tests/workspace
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TeamError } from '../src/errors.ts'
import type { TeamConfig } from '../src/config.ts'
import { SHARED_AREA, TeamWorkspace, type WorkspaceEntry } from '../src/workspace.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 8, maxRecentMessages: 20, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 3, maxNoteChars: 40, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}

const alice = { id: 'child-1', name: 'Alice' }
const bob = { id: 'child-2', name: 'Bob' }

/** The one table of the domain, as the storage form would hand it over. */
class FakeTable {
  readonly rows = new Map<string, WorkspaceEntry>()

  get(key: string): WorkspaceEntry | undefined {
    return this.rows.get(key)
  }

  entries(): IterableIterator<[string, WorkspaceEntry]> {
    return [...this.rows.entries()][Symbol.iterator]()
  }

  async put(key: string, value: WorkspaceEntry): Promise<void> {
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
let workspace: TeamWorkspace

/** Assemble the workspace over a fake domain. */
function mount(config: TeamConfig = CONFIG): TeamWorkspace {
  table = new FakeTable()
  closed = 0
  const domain = {
    name: 'team_workspace',
    table: () => table,
    close: () => {
      closed += 1
      return Promise.resolve()
    },
  }
  const ctx = { storageDomain: { open: () => Promise.resolve(domain) } } as unknown as Context
  return new TeamWorkspace(ctx, config)
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

beforeEach(() => { workspace = mount() })

describe('the shared board', () => {
  it('keeps a note under its key, attributed to whoever wrote it', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'api decision', 'we keep v1', alice, 100)
    expect(await workspace.read('leader-1', SHARED_AREA)).toEqual([{
      leaderId: 'leader-1',
      area: SHARED_AREA,
      key: 'api decision',
      text: 'we keep v1',
      authorId: 'child-1',
      authorName: 'Alice',
      updatedAt: 100,
    }])
  })

  it('replaces a key whole, so the board never grows a second truth', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'plan', 'first', alice, 100)
    await workspace.write('leader-1', SHARED_AREA, 'plan', 'second', bob, 200)
    const held = await workspace.read('leader-1', SHARED_AREA)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ text: 'second', authorName: 'Bob' })
  })

  it('reads newest first', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'old', 'a', alice, 100)
    await workspace.write('leader-1', SHARED_AREA, 'new', 'b', alice, 300)
    expect((await workspace.read('leader-1', SHARED_AREA)).map(entry => entry.key)).toEqual(['new', 'old'])
  })

  it("is the team's own: another team reads none of it", async () => {
    await workspace.write('leader-1', SHARED_AREA, 'plan', 'ours', alice, 100)
    expect(await workspace.read('leader-2', SHARED_AREA)).toEqual([])
  })

  it('drops a note on request, and says so when there is none', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'plan', 'ours', alice, 100)
    await workspace.remove('leader-1', SHARED_AREA, 'plan')
    expect(await workspace.read('leader-1', SHARED_AREA)).toEqual([])
    expect(await refusalOf(() => workspace.remove('leader-1', SHARED_AREA, 'plan'))).toBe('UNKNOWN_NOTE')
  })
})

describe('private pads', () => {
  it("are the author's alone: the shared board never shows them", async () => {
    await workspace.write('leader-1', alice.id, 'my state', 'halfway', alice, 100)
    expect(await workspace.read('leader-1', SHARED_AREA)).toEqual([])
    expect(await workspace.read('leader-1', alice.id)).toHaveLength(1)
  })

  it("are not each other's: one member cannot read another pad", async () => {
    await workspace.write('leader-1', alice.id, 'my state', 'halfway', alice, 100)
    expect(await workspace.read('leader-1', bob.id)).toEqual([])
  })

  it('stay out of the panel index, which carries the shared area only', async () => {
    await workspace.write('leader-1', alice.id, 'secret', 'mine', alice, 100)
    await workspace.write('leader-1', SHARED_AREA, 'open', 'ours', alice, 100)
    expect((await workspace.index('leader-1')).map(entry => entry.key)).toEqual(['open'])
  })
})

describe('bounds', () => {
  it('refuses a note longer than the deployment accepts', async () => {
    expect(await refusalOf(() => workspace.write('leader-1', SHARED_AREA, 'k', 'x'.repeat(41), alice, 1)))
      .toBe('NOTE_TOO_LONG')
  })

  it('refuses a new key once the area is full, but still lets a key be replaced', async () => {
    for (const key of ['a', 'b', 'c']) await workspace.write('leader-1', SHARED_AREA, key, key, alice, 1)
    expect(await refusalOf(() => workspace.write('leader-1', SHARED_AREA, 'd', 'd', alice, 1)))
      .toBe('WORKSPACE_FULL')
    await workspace.write('leader-1', SHARED_AREA, 'a', 'replaced', alice, 2)
    expect((await workspace.read('leader-1', SHARED_AREA))[0]).toMatchObject({ key: 'a', text: 'replaced' })
  })

  it('counts each area against the bound on its own', async () => {
    for (const key of ['a', 'b', 'c']) await workspace.write('leader-1', SHARED_AREA, key, key, alice, 1)
    await workspace.write('leader-1', alice.id, 'mine', 'still fine', alice, 1)
    expect(await workspace.read('leader-1', alice.id)).toHaveLength(1)
  })

  it('refuses a key that would not survive as an address', async () => {
    expect(await refusalOf(() => workspace.write('leader-1', SHARED_AREA, 'two\nlines', 'x', alice, 1)))
      .toBe('INVALID_NOTE_KEY')
    expect(await refusalOf(() => workspace.write('leader-1', SHARED_AREA, '   ', 'x', alice, 1)))
      .toBe('INVALID_NOTE_KEY')
  })

  it('takes a key with the spaces trimmed off it', async () => {
    await workspace.write('leader-1', SHARED_AREA, '  plan  ', 'x', alice, 1)
    expect((await workspace.read('leader-1', SHARED_AREA))[0]?.key).toBe('plan')
  })
})

describe('clearing', () => {
  beforeEach(async () => {
    await workspace.write('leader-1', SHARED_AREA, 'open', 'ours', alice, 1)
    await workspace.write('leader-1', alice.id, 'mine', 'hers', alice, 1)
    await workspace.write('leader-2', SHARED_AREA, 'other team', 'theirs', bob, 1)
  })

  it('drops one dismissed member pad and leaves the board standing', async () => {
    await workspace.clear('leader-1', alice.id)
    expect(await workspace.read('leader-1', alice.id)).toEqual([])
    expect(await workspace.read('leader-1', SHARED_AREA)).toHaveLength(1)
  })

  it('drops every area of a disbanded team, and no other team', async () => {
    await workspace.clear('leader-1')
    expect(await workspace.read('leader-1', SHARED_AREA)).toEqual([])
    expect(await workspace.read('leader-1', alice.id)).toEqual([])
    expect(await workspace.read('leader-2', SHARED_AREA)).toHaveLength(1)
  })
})

describe('the panel index', () => {
  it('carries the first non-empty line, never the whole note', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'plan', '\n  the headline  \nthe body', alice, 100)
    expect(await workspace.index('leader-1')).toEqual([{
      key: 'plan',
      authorId: 'child-1',
      authorName: 'Alice',
      updatedAt: 100,
      preview: 'the headline',
    }])
  })
})

describe('lifecycle', () => {
  it('releases the domain handle, so the next open of the name succeeds', async () => {
    await workspace.write('leader-1', SHARED_AREA, 'plan', 'x', alice, 1)
    workspace.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(1)
  })
})
