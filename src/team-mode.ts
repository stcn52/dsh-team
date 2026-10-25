/**
 * Team mode: the preset-scoped plugin that makes "team mode" behave like a
 * mode instead of depending on the user typing `/agent-teams`.
 *
 * Two contributions, both mounted inside the team preset's own scope — the
 * preset scope is the parent every Agent bound to that preset joins
 * (`@deepseek-ai/dsh-agent-preset-registry` binds the agent scope under the
 * retained preset scope), so neither contribution leaks into another preset:
 *
 * 1. a prompt section stating the hard rules, at order 119 (after the persona,
 *    before plan policy and the tool guidance), and
 * 2. a monotonic `tools.guard` that refuses self-directed work while the
 *    calling agent still has no teammate.
 *
 * The `team` service is injected softly rather than declared: a composition
 * may mount this row before — or without — dsh-team, and the row must then
 * keep its prompt and install no guard instead of failing the mount. The guard
 * itself is defensive about what it observes: an execution with no agent (the
 * global registry view) and a subagent execution pass through untouched, which
 * is also what keeps ordinary subagents working when they inherit a preset
 * scope through their parent.
 *
 * @module dsh-team/team-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { TeamService } from './service.ts'
import type {} from './types.ts'

export const name = 'team-mode'

/**
 * The two seams this row binds. `team` is deliberately NOT declared here: it
 * is injected softly in {@link apply}, because a deployment may mount this row
 * without dsh-team and must still load.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * The single denial every gated call receives before the first teammate
 * exists. One sentence, held verbatim by the tests: the model reads it as the
 * next action, not as a generic failure.
 */
export const TEAM_MODE_DENIAL =
  '团队模式：还没有 teammate。先用 team_spawn 建团队，再调查/执行；纯问答可以直接回答。'

/**
 * Tools that stay callable before the first teammate exists: the whole
 * `team_*` surface (the way OUT of the gate) plus the advisory tools that do
 * not investigate the repository. Everything else — bash, read, write, edit,
 * glob, grep, web, jobs, subagent — waits for a team.
 */
export const TEAM_MODE_ALLOWED: readonly string[] = [
  'skill',
  'todo_write',
  'ask_user_question',
  'progress_update',
  'present',
  'workflow',
]

const ALLOWED = new Set(TEAM_MODE_ALLOWED)

/** Placement of the hard rules: after the persona (0), before plan policy (500). */
export const TEAM_MODE_ORDER = 119

/** The hard rules injected into every turn of a team-mode session. */
export const TEAM_MODE_SECTION = [
  '团队模式（硬规则，优先于任何工具描述与默认工作习惯）：',
  '- 非平凡请求（调查、修改、执行、多步任务）的第一个动作必须是 team_spawn 建立团队。团队建立之前，不要用 bash/read/grep/glob/edit 之类的工具自行调查或执行；团队建立前的这类调用会被 tools 门禁直接拒绝，理由会告诉你下一步做什么。',
  '- 纯问答、寒暄、概念解释可以直接回答，不需要建团队；要读代码或查文件才能回答的问题算调查，先建团队。',
  '- 不要用 subagent / subagent_fork 代替 teammate：子代理不是团队成员，没有名字、共享任务板与持久档案。跨多个独立子任务时仍可用 workflow，但团队本身用 team_spawn。',
  '- 每个 teammate 的 brief 写清三件事：素材从哪取、用什么方法与工具、交付时拿什么证据自证。按任务形态指定 provider/model，并在派活时说明一句理由。',
  '- 你负责复核成员交回的原始证据，不要把结论原样转述给用户；成员完成立即 team_dismiss，保持团队最小。',
].join('\n')

/** Whether `tool` may run before the team exists (all `team_*` plus the advisory set). */
export function allowedBeforeTeam(tool: string): boolean {
  return tool.startsWith('team_') || ALLOWED.has(tool)
}

/**
 * The monotonic check behind the guard, kept pure so a test can exercise the
 * decision without a tool registry: a call is denied only when it has an
 * ordinary (non-subagent) agent, is not otherwise allowed, and that agent has
 * no teammate yet.
 * @param team - the team service to ask about the calling agent.
 * @param execution - the identity-protected call handed to the guard.
 * @returns the denial reason, or `undefined` to leave the call allowed.
 */
export function noTeamDenial(
  team: TeamService,
  execution: Readonly<ToolExecution>,
): string | undefined {
  const agent = execution.agent
  if (agent === undefined) return undefined
  if (agent.session.header.origin === 'subagent') return undefined
  if (allowedBeforeTeam(execution.name)) return undefined
  return team.list(agent).members.length === 0 ? TEAM_MODE_DENIAL : undefined
}

/**
 * Mount the hard rules and the no-teammate gate into the calling scope.
 *
 * Both registrations go through `ctx.effect`, so disposing the preset (a
 * recomposition, an unload, HMR) takes them back out exactly. The guard lands
 * in the preset scope's tool layer, which the tool runtime consults on the
 * agent chain of every bound agent; the guard re-checks the agent itself, so a
 * call that reaches it from another scope is judged on that agent's team.
 *
 * @param ctx - the preset-scoped context this row is mounted in.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'team-mode',
      order: TEAM_MODE_ORDER,
      text: () => TEAM_MODE_SECTION,
    }),
    'team-mode: hard rules',
  )

  ctx.inject(['team'], (teamCtx: Context) => {
    teamCtx.effect(
      () => teamCtx.tools.guard(execution => noTeamDenial(teamCtx.team, execution)),
      'team-mode: no-teammate guard',
    )
  })
}
