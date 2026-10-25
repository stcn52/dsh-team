/**
 * The plugin row itself: its declared dependencies and its deployment knobs.
 *
 * @module dsh-team/tests/plugin
 */

import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('row', () => {
  it('is one row that declares every seam it registers into', () => {
    expect(name).toBe('team')
    expect(inject).toEqual(['agents', 'subagents', 'sessionProjections', 'tools', 'systemPrompt'])
  })
})

describe('config', () => {
  it('runs on defaults, so a deployment adds the row with no knobs', () => {
    expect(Config({})).toEqual({
      provider: 'spawn', maxTeammates: 8, maxRecentMessages: 50, maxChainHops: 4, maxChainRoundTrips: 2,
      maxWorkspaceEntries: 32, maxNoteChars: 4000, teammateProvider: '', teammateModel: '',
    })
  })

  it('takes the deployment values it is given', () => {
    expect(Config({ provider: 'fork', maxTeammates: 3, maxRecentMessages: 100, maxChainHops: 2 }))
      .toEqual({
        provider: 'fork', maxTeammates: 3, maxRecentMessages: 100, maxChainHops: 2, maxChainRoundTrips: 2,
        maxWorkspaceEntries: 32, maxNoteChars: 4000, teammateProvider: '', teammateModel: '',
      })
  })

  it('fails loud on a value outside the range it can honour', () => {
    expect(() => Config({ maxTeammates: 0 })).toThrow()
    expect(() => Config({ maxTeammates: 65 })).toThrow()
    expect(() => Config({ maxRecentMessages: 0 })).toThrow()
    expect(() => Config({ maxTeammates: 2.5 })).toThrow()
  })
})
