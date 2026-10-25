import { t as TeamService } from "./service-BG3yFUSQ.js";
import { Context } from "@deepseek-ai/cordis";
import { ToolExecution } from "@deepseek-ai/dsh-tools";
//#region src/team-mode.d.ts
declare const name = "team-mode";
/**
 * The two seams this row binds. `team` is deliberately NOT declared here: it
 * is injected softly in {@link apply}, because a deployment may mount this row
 * without dsh-team and must still load.
 */
declare const inject: string[];
/**
 * The single denial every gated call receives before the first teammate
 * exists. One sentence, held verbatim by the tests: the model reads it as the
 * next action, not as a generic failure.
 */
declare const TEAM_MODE_DENIAL = "团队模式：还没有 teammate。先用 team_spawn 建团队，再调查/执行；纯问答可以直接回答。";
/**
 * Tools that stay callable before the first teammate exists: the whole
 * `team_*` surface (the way OUT of the gate) plus the advisory tools that do
 * not investigate the repository. Everything else — bash, read, write, edit,
 * glob, grep, web, jobs, subagent — waits for a team.
 */
declare const TEAM_MODE_ALLOWED: readonly string[];
/** Placement of the hard rules: after the persona (0), before plan policy (500). */
declare const TEAM_MODE_ORDER = 119;
/** The hard rules injected into every turn of a team-mode session. */
declare const TEAM_MODE_SECTION: string;
/** Whether `tool` may run before the team exists (all `team_*` plus the advisory set). */
declare function allowedBeforeTeam(tool: string): boolean;
/**
 * The monotonic check behind the guard, kept pure so a test can exercise the
 * decision without a tool registry: a call is denied only when it has an
 * ordinary (non-subagent) agent, is not otherwise allowed, and that agent has
 * no teammate yet.
 * @param team - the team service to ask about the calling agent.
 * @param execution - the identity-protected call handed to the guard.
 * @returns the denial reason, or `undefined` to leave the call allowed.
 */
declare function noTeamDenial(team: TeamService, execution: Readonly<ToolExecution>): string | undefined;
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
declare function apply(ctx: Context): void;
//#endregion
export { TEAM_MODE_ALLOWED, TEAM_MODE_DENIAL, TEAM_MODE_ORDER, TEAM_MODE_SECTION, allowedBeforeTeam, apply, inject, name, noTeamDenial };