import { t as TeamService } from "./service-l7vGDLWJ.js";
import { ToolExecution } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
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
 *
 * The three goal tools are bookkeeping on the session's own objective: a
 * leader that dismissed its last teammate still has to be able to read back
 * where the goal stood, and answering that never touches the working tree.
 */
declare const TEAM_MODE_ALLOWED: readonly string[];
/**
 * Whole families that stay callable before the first teammate exists, matched
 * by prefix because their rows are composed independently (a deployment may
 * mount any subset of them, and new members appear without this file moving).
 *
 * Both families are accounting, not investigation: `mnemon_*` reads and writes
 * the durable memory/dossier stores, `schedule_*` manages reminders in the
 * session. Neither opens a repository file, runs a command, or delegates work,
 * which is what the gate exists to stop — refusing them only stranded a leader
 * that had just dismissed its last teammate, mid-record, with a refusal that
 * told it to spawn a team it no longer needed.
 */
declare const TEAM_MODE_ALLOWED_PREFIXES: readonly string[];
/** Placement of the hard rules: after the persona (0), before plan policy (500). */
declare const TEAM_MODE_ORDER = 119;
/** The hard rules injected into every turn of a team-mode session. */
declare const TEAM_MODE_SECTION: string;
/**
 * Whether `tool` may run before the team exists: the whole `team_*` surface,
 * the exact advisory set, and the bookkeeping families in
 * {@link TEAM_MODE_ALLOWED_PREFIXES}.
 */
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
export { TEAM_MODE_ALLOWED, TEAM_MODE_ALLOWED_PREFIXES, TEAM_MODE_DENIAL, TEAM_MODE_ORDER, TEAM_MODE_SECTION, allowedBeforeTeam, apply, inject, name, noTeamDenial };