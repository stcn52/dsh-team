//#region src/team-mode.ts
const name = "team-mode";
/**
* The two seams this row binds. `team` is deliberately NOT declared here: it
* is injected softly in {@link apply}, because a deployment may mount this row
* without dsh-team and must still load.
*/
const inject = ["tools", "systemPrompt"];
/**
* The single denial every gated call receives before the first teammate
* exists. One sentence, held verbatim by the tests: the model reads it as the
* next action, not as a generic failure.
*/
const TEAM_MODE_DENIAL = "团队模式：还没有 teammate。先用 team_spawn 建团队，再调查/执行；纯问答可以直接回答。";
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
const TEAM_MODE_ALLOWED = [
	"skill",
	"todo_write",
	"ask_user_question",
	"progress_update",
	"present",
	"workflow",
	"create_goal",
	"get_goal",
	"update_goal"
];
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
const TEAM_MODE_ALLOWED_PREFIXES = ["mnemon_", "schedule_"];
const ALLOWED = new Set(TEAM_MODE_ALLOWED);
/** Placement of the hard rules: after the persona (0), before plan policy (500). */
const TEAM_MODE_ORDER = 119;
/** The hard rules injected into every turn of a team-mode session. */
const TEAM_MODE_SECTION = [
	"团队模式（硬规则，优先于任何工具描述与默认工作习惯）：",
	"- 非平凡请求（调查、修改、执行、多步任务）的第一个动作必须是 team_spawn 建立团队。团队建立之前，不要用 bash/read/grep/glob/edit 之类的工具自行调查或执行；团队建立前的这类调用会被 tools 门禁直接拒绝，理由会告诉你下一步做什么。",
	"- 纯问答、寒暄、概念解释可以直接回答，不需要建团队；要读代码或查文件才能回答的问题算调查，先建团队。",
	"- 不要用 subagent / subagent_fork 代替 teammate：子代理不是团队成员，没有名字、共享任务板与持久档案。跨多个独立子任务时仍可用 workflow，但团队本身用 team_spawn。",
	"- 每个 teammate 的 brief 写清三件事：素材从哪取、用什么方法与工具、交付时拿什么证据自证。按任务形态指定 provider/model，并在派活时说明一句理由。",
	"- 你负责复核成员交回的原始证据，不要把结论原样转述给用户；成员完成立即 team_dismiss，保持团队最小。"
].join("\n");
/**
* Whether `tool` may run before the team exists: the whole `team_*` surface,
* the exact advisory set, and the bookkeeping families in
* {@link TEAM_MODE_ALLOWED_PREFIXES}.
*/
function allowedBeforeTeam(tool) {
	if (tool.startsWith("team_") || ALLOWED.has(tool)) return true;
	return TEAM_MODE_ALLOWED_PREFIXES.some((prefix) => tool.startsWith(prefix));
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
function noTeamDenial(team, execution) {
	const agent = execution.agent;
	if (agent === void 0) return void 0;
	if (agent.session.header.origin === "subagent") return void 0;
	if (allowedBeforeTeam(execution.name)) return void 0;
	return team.list(agent).members.length === 0 ? TEAM_MODE_DENIAL : void 0;
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
function apply(ctx) {
	ctx.effect(() => ctx.systemPrompt.section({
		name: "team-mode",
		order: 119,
		text: () => TEAM_MODE_SECTION
	}), "team-mode: hard rules");
	ctx.inject(["team"], (teamCtx) => {
		teamCtx.effect(() => teamCtx.tools.guard((execution) => noTeamDenial(teamCtx.team, execution)), "team-mode: no-teammate guard");
	});
}
//#endregion
export { TEAM_MODE_ALLOWED, TEAM_MODE_ALLOWED_PREFIXES, TEAM_MODE_DENIAL, TEAM_MODE_ORDER, TEAM_MODE_SECTION, allowedBeforeTeam, apply, inject, name, noTeamDenial };
