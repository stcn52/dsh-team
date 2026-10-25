/**
 * The leader-facing routing brief: how to decide which LLM route a teammate
 * runs on.
 *
 * A team's brain is one session on its own route; handing each piece of work to
 * a teammate on a suitable route is the brain's call, so it needs two things it
 * cannot get from the tool schema alone — the routes this deployment can
 * actually reach, and a rule for choosing between them. Both are rendered at
 * prompt-assembly time rather than snapshotted at registration, so a provider
 * mounted after the session started still shows up in the next turn's text.
 *
 * @module dsh-team/routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { TeamConfig } from './config.ts'

/** Sits with the other team guidance, before the persona. */
export const ROUTING_SECTION_ORDER = 117

/** How one registered route is named in prose. */
function routeName(provider: string | undefined, model: string | undefined): string {
  if (provider === undefined) return 'the deployment default route'
  return model === undefined ? provider : `${provider}/${model}`
}

/**
 * Compose the routing brief for one leader.
 * @param ctx - context that may carry the `llm` service.
 * @param agent - the leader session the brief is written for.
 * @param config - the validated row configuration.
 * @returns prompt text naming the reachable routes and how to choose one.
 */
export function routingBriefing(ctx: Context, agent: Agent, config: TeamConfig): string {
  const providers = ctx.get('llm')?.listProviders().map(entry => entry.id) ?? []
  const fallback = config.teammateProvider === ''
    ? 'your own route'
    : routeName(config.teammateProvider, config.teammateModel === '' ? undefined : config.teammateModel)
  return [
    'Teammate routing — you decide which model each teammate runs on:',
    `• This session runs on ${routeName(agent.options.provider, agent.options.model)}. A teammate may run on any `
    + 'other route: name provider + model when you spawn it.',
    providers.length === 0
      ? '• No provider directory is mounted here, so leave the route out and every teammate inherits yours.'
      : `• Routes registered in this deployment: ${providers.join(', ')}.`,
    `• A spawn that names no route lands on ${fallback}.`,
    '• Choose by the shape of the work, not by habit:',
    '  – mechanical, machine-checkable work (inventory, counting, format conversion, summarising logs or test '
    + 'output, template edits, checklist checks) belongs on a cheap or local route;',
    '  – judgement and long chains (cross-repository design, architecture calls, ambiguous debugging, multi-step '
    + 'planning, anything whose answer you will have to trust) belong on a frontier route;',
    '  – work that mixes both should be split: collection on the cheap route, conclusion on the frontier route.',
    '• A different provider needs its own model id; model ids are provider-scoped, and a spawn that omits the '
    + 'model is refused.',
    '• Put the chosen route and a one-clause reason into the task you give the teammate, so the team record shows '
    + 'why that model got the work.',
  ].join('\n')
}

/**
 * Register the routing brief on one leader session.
 * @param ctx - context carrying the `llm` service, if any.
 * @param config - the validated row configuration.
 * @param agent - the leader session to equip.
 * @returns the disposer removing the section.
 */
export function installLeaderRouting(ctx: Context, config: TeamConfig, agent: Agent): () => void {
  return agent.ctx.systemPrompt.section({
    name: 'team-routing',
    order: ROUTING_SECTION_ORDER,
    text: () => routingBriefing(ctx, agent, config),
  })
}
