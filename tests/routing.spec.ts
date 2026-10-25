/**
 * The leader routing brief: what a team brain is told about the routes it may
 * hand work to, and how it should choose between them.
 *
 * @module dsh-team/tests/routing
 */

import { describe, expect, it } from 'vitest'
import type { TeamConfig } from '../src/config.ts'
import { installLeaderRouting, routingBriefing, ROUTING_SECTION_ORDER } from '../src/routing.ts'
import { FakeLlm, fakeAgent } from './harness.ts'

const CONFIG: TeamConfig = {
  provider: 'spawn', maxTeammates: 8, maxRecentMessages: 50, maxChainHops: 4, maxChainRoundTrips: 2,
  maxWorkspaceEntries: 8, maxNoteChars: 400, maxDossierEntries: 40, maxDossierChars: 6000,
  maxDossierDigestChars: 1200, teammateProvider: '', teammateModel: '',
}

/** A leader session on a named route, with the provider directory mounted. */
function leader(route: { provider?: string; model?: string }, providers: readonly string[]) {
  const agent = fakeAgent('leader-1', route)
  agent.ctx.provide('llm', new FakeLlm([], providers))
  return agent
}

describe('routingBriefing', () => {
  it('names the leader route, the reachable routes, and the fallback', () => {
    const text = routingBriefing(
      leader({ provider: 'deepseek-official', model: 'deepseek-flash' }, ['deepseek-official', 'qwen-local']).ctx,
      leader({ provider: 'deepseek-official', model: 'deepseek-flash' }, []).agent,
      CONFIG,
    )
    expect(text).toContain('This session runs on deepseek-official/deepseek-flash')
    expect(text).toContain('Routes registered in this deployment: deepseek-official, qwen-local')
    expect(text).toContain('lands on your own route')
  })

  it('names the configured teammate route as the fallback', () => {
    const agent = leader({ provider: 'deepseek-official', model: 'deepseek-flash' }, ['qwen-local'])
    const text = routingBriefing(agent.ctx, agent.agent, {
      ...CONFIG, teammateProvider: 'qwen-local', teammateModel: 'qwen3.8-flash-next-iq3_s',
    })
    expect(text).toContain('lands on qwen-local/qwen3.8-flash-next-iq3_s')
  })

  it('degrades to inheritance language when no provider directory is mounted', () => {
    const agent = fakeAgent('leader-1', { provider: 'deepseek', model: 'chat' })
    const text = routingBriefing(agent.ctx, agent.agent, CONFIG)
    expect(text).toContain('No provider directory is mounted here')
    expect(text).not.toContain('Routes registered in this deployment')
  })

  it('states the selection rule in both directions', () => {
    const agent = leader({}, ['qwen-local'])
    const text = routingBriefing(agent.ctx, agent.agent, CONFIG)
    expect(text).toContain('mechanical, machine-checkable work')
    expect(text).toContain('judgement and long chains')
    expect(text).toContain('split: collection on the cheap route, conclusion on the frontier route')
  })
})

describe('installLeaderRouting', () => {
  it('registers one live section whose text follows the mounted providers', () => {
    const agent = leader({ provider: 'deepseek-official', model: 'deepseek-flash' }, ['deepseek-official'])
    const dispose = installLeaderRouting(agent.ctx, CONFIG, agent.agent)

    expect(agent.prompt.sections).toHaveLength(1)
    expect(agent.prompt.sections[0]?.name).toBe('team-routing')
    expect(agent.prompt.sections[0]?.order).toBe(ROUTING_SECTION_ORDER)
    expect(agent.prompt.sections[0]?.text()).toContain('deepseek-official')

    dispose()
    expect(agent.prompt.sections).toHaveLength(0)
  })
})
