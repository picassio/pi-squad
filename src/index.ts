/**
 * pi-squad — Multi-agent collaboration extension for Pi.
 *
 * Registers:
 * - squad tool (start a squad)
 * - squad_status tool (check progress)
 * - squad_message tool (send message to agent)
 * - squad_modify tool (add/remove/reassign tasks)
 * - Panel toggle keybinding
 * - Session lifecycle hooks
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Squad, Task, SquadConfig, PlannerOutput } from "./types.js";
import { DEFAULT_SQUAD_CONFIG, THINKING_LEVELS } from "./types.js";
import { Scheduler, type SchedulerEvent, type SchedulerSpawnContext } from "./scheduler.js";
import { runPlanner } from "./planner.js";
import { validatePlan, PLAN_STRUCTURE_RULES } from "./plan-rules.js";
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorConsultText, type AdvisorConsultInput } from "./advisor.js";
import { completeSimple, type Message, type TextContent } from "@earendil-works/pi-ai";
import { SquadPanel, type SquadPanelResult } from "./panel/squad-panel.js";
import { setupSquadWidget, type SquadWidgetState } from "./panel/squad-widget.js";
import * as store from "./store.js";
import { debug, logError } from "./logger.js";

// ============================================================================
// State
// ============================================================================

/** Master switch — when false, all squad tools, hooks, and widget are disabled */
let squadEnabled = true;
/** Registry of all running schedulers — supports multiple concurrent squads */
const schedulers = new Map<string, Scheduler>();
/** The currently viewed/focused squad (for widget, panel, status) */
let activeSquadId: string | null = null;
/** Whether an overlay panel is currently open (prevents double-open) */
let overlayOpen = false;
/** Stored ExtensionContext for widget updates from background scheduler events */
let uiCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null = null;
/** Component-based widget state + controls */
const widgetState: SquadWidgetState = { squadId: null, enabled: true };
let widgetControls: { requestUpdate: () => void; dispose: () => void } | null = null;

/** Reviewer instructions appended to squad-completed notifications —
 * makes the main session behave like the QA/verification agents do. */
const REVIEW_INSTRUCTIONS =
	"Before reporting success to the user, REVIEW the work like a QA agent would: " +
	"(1) check task outputs for QA verdicts (## Verdict: PASS/FAIL) and verification evidence (commands + results); " +
	"(2) if a task claimed done without evidence, run its Verify command yourself; " +
	"(3) report to the user what was verified (with evidence) and flag anything unverified — don't just relay the summary.";

/**
 * Resolve a model string (or null = session default) to its context window.
 * Reads uiCtx lazily so it always uses the live session's registry.
 */
function resolveContextWindow(model: string | null): number | undefined {
	const ctx = uiCtx;
	if (!ctx) return undefined;
	try {
		if (!model) return ctx.model?.contextWindow;
		// Strip a :<thinking> suffix if present
		let clean = model;
		const lastColon = model.lastIndexOf(":");
		if (lastColon > 0 && (THINKING_LEVELS as readonly string[]).includes(model.slice(lastColon + 1))) {
			clean = model.slice(0, lastColon);
		}
		const all = ctx.modelRegistry.getAll();
		const slash = clean.indexOf("/");
		if (slash > 0) {
			const provider = clean.slice(0, slash);
			const id = clean.slice(slash + 1);
			const m = all.find((x) => x.provider === provider && x.id === id);
			if (m) return m.contextWindow;
		}
		return all.find((x) => x.id === clean)?.contextWindow;
	} catch {
		return undefined;
	}
}

/** Main session's current model as "provider/id", if known */
function getMainSessionModel(): string | undefined {
	try {
		const m = uiCtx?.model;
		return m ? `${m.provider}/${m.id}` : undefined;
	} catch {
		return undefined;
	}
}

/** Main session's current thinking level (set inside the extension entry, needs `pi`) */
let getMainSessionThinking: () => string | undefined = () => undefined;

/**
 * Resolve the effective squad defaults from ~/.pi/squad/settings.json.
 * "main" follows the live main session; "pi-default" leaves values unset
 * (child pi resolves its own default); anything else is an explicit value.
 */
function resolveSquadDefaults(): { model?: string; thinking?: string } {
	const settings = store.loadSquadSettings();
	let model: string | undefined;
	if (settings.defaultModel === "main") model = getMainSessionModel();
	else if (settings.defaultModel !== "pi-default") model = settings.defaultModel;
	let thinking: string | undefined;
	if (settings.defaultThinking === "main") thinking = getMainSessionThinking();
	else if (settings.defaultThinking !== "pi-default") thinking = settings.defaultThinking;
	return { model, thinking };
}

/**
 * Consult the advisor model in-process via pi-ai (no subprocess).
 * Returns advice text or null when disabled/unresolvable.
 */
async function consultAdvisor(input: AdvisorConsultInput): Promise<string | null> {
	const ctx = uiCtx;
	if (!ctx) return null;
	const settings = store.loadSquadSettings();
	if (!settings.advisor.enabled) return null;

	try {
		// Resolve advisor model: "main" = the main session's live model object
		let model = settings.advisor.model === "main" ? ctx.model : undefined;
		if (!model && settings.advisor.model !== "main") {
			const ref = settings.advisor.model;
			const slash = ref.indexOf("/");
			if (slash > 0) model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		}
		if (!model) {
			logError("squad-advisor", `advisor model "${settings.advisor.model}" not resolvable`);
			return null;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			logError("squad-advisor", `no auth for advisor model ${model.provider}/${model.id}`);
			return null;
		}

		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: buildAdvisorConsultText(input) }],
			timestamp: Date.now(),
		} as Message;

		const response = await completeSimple(
			model,
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages: [userMessage] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: settings.advisor.maxTokens,
				reasoning: settings.advisor.reasoning as never,
			},
		);

		const text = response.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		debug("squad-advisor", `consulted ${model.provider}/${model.id} for ${input.taskId}: in=${response.usage?.input ?? 0} out=${response.usage?.output ?? 0}`);
		return text || null;
	} catch (error) {
		logError("squad-advisor", `consult failed: ${(error as Error).message}`);
		return null;
	}
}

/** Spawn context shared by all Scheduler instances */
const schedulerSpawnContext: SchedulerSpawnContext = {
	resolveContextWindow,
	getDefaultModelThinking: resolveSquadDefaults,
	consultAdvisor,
};

/** Get the active scheduler (for the focused squad) */
function getActiveScheduler(): Scheduler | null {
	if (!activeSquadId) return null;
	return schedulers.get(activeSquadId) || null;
}


// ============================================================================
// Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	// Don't load in child agent processes (prevent recursive squad-in-squad)
	if (process.env.PI_SQUAD_CHILD === "1") return;

	// Wire main-session thinking lookup (needs `pi`, guarded against stale API)
	getMainSessionThinking = () => {
		try {
			return pi.getThinkingLevel();
		} catch {
			return undefined;
		}
	};

	// Bootstrap default agents on first load
	const defaultsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "agents", "_defaults");
	store.bootstrapAgents(defaultsDir);

	// Collect squad skill paths
	const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "skills");
	const squadSkillPaths = getSquadSkillPaths(skillsDir);

	// =========================================================================
	// Context Injection — give main agent awareness of squad state
	// =========================================================================

	// Inject squad awareness before each LLM call
	pi.on("before_agent_start", async (event, ctx) => {
		if (!squadEnabled) return;

		// When a squad is active, inject its status
		if (activeSquadId) {
			const squad = store.loadSquad(activeSquadId);
			if (!squad) return;
			const tasks = store.loadAllTasks(activeSquadId);
			if (tasks.length === 0) return;

			const doneCount = tasks.filter((t) => t.status === "done").length;
			const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

			const taskLines = tasks.map((t) => {
				const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "⏳" : t.status === "failed" ? "✗" : t.status === "blocked" ? "◻" : "·";
				let line = `  ${icon} ${t.id} (${t.agent}) [${t.status}]`;
				if (t.output) line += ` — ${t.output.split("\n")[0].slice(0, 80)}`;
				if (t.error) line += ` ERROR: ${t.error.slice(0, 60)}`;
				return line;
			}).join("\n");

			const squadContext = [
				`<squad_status>`,
				`Squad: ${squad.id} — ${squad.goal}`,
				`Status: ${squad.status} | ${doneCount}/${tasks.length} tasks | $${totalCost.toFixed(2)}`,
				taskLines,
				`</squad_status>`,
				`You have an active squad. Use squad_message to talk to agents, squad_status for details, squad_modify to change tasks.`,
			].join("\n");

			return {
				systemPrompt: event.systemPrompt + "\n\n" + squadContext,
			};
		}

		// When NO squad is active, nudge the agent to consider using squad for complex tasks
		const allAgents = store.loadAllAgentDefs(ctx.cwd).filter((a) => a.name !== "planner" && !a.disabled);
		const agentList = allAgents.map((a) => `${a.name} (${a.role})`).join(", ");
		const squadNudge = [
			`<squad_hint>`,
			`You have the "squad" tool available for multi-agent collaboration.`,
			`Use it when the user's request involves multiple concerns (e.g. backend + frontend + tests + docs),`,
			`would benefit from parallel execution, or is too large for a single agent context.`,
			`The squad tool decomposes work into tasks, assigns specialist agents, and runs them in parallel.`,
			`When in doubt about whether a task is complex enough, prefer using squad — it handles the coordination for you.`,
			allAgents.length > 0 ? `Available agents: ${agentList}. When providing tasks, the "agent" field must be one of these names.` : ``,
			`When you provide tasks yourself, you take the planner's role — follow its rules: contract/design task first for shared interfaces, final QA task for user-facing changes, 3-7 tasks, first task(s) with empty depends.`,
			`Structure descriptions as: Goal (outcome first), Context (files to read), Output (deliverable), Boundaries (what must not change), Verify (proving command).`,
			`</squad_hint>`,
		].filter(Boolean).join("\n");

		return {
			systemPrompt: event.systemPrompt + "\n\n" + squadNudge,
		};
	});

	// =========================================================================
	// Tool: squad
	// =========================================================================

	pi.registerTool({
		name: "squad",
		label: "Squad",
		description: [
			"Start a multi-agent squad for complex, multi-step tasks.",
			"ALWAYS use squad when a task involves 2+ of: backend, frontend, testing, docs, devops, security.",
			"Use when a task has natural parallelism, touches multiple files/systems, or would overflow a single agent's context.",
			"Examples that NEED squad: 'build a REST API with auth and tests', 'add a feature with frontend + backend + docs',",
			"'refactor the auth system and update tests', 'set up CI/CD with Docker and deployment'.",
			"Do NOT use for simple single-file changes, quick bug fixes, or tasks a single agent can handle in a few minutes.",
			"When in doubt about complexity, use squad — it's better to parallelize than to do everything sequentially.",
			"Non-blocking: returns immediately with the plan while agents work in background.",
			"If you provide tasks yourself (skipping the planner agent), follow the same rules the planner follows:",
			PLAN_STRUCTURE_RULES.replace(/\n- /g, " ").replace(/^- /, ""),
			"Plans are validated on submission — structural errors are rejected, rule violations come back as warnings.",
		].join(" "),
		promptSnippet: "squad({ goal, tasks?, agents? }): decompose complex work into parallel specialist agents → non-blocking, monitor via squad_status",
		promptGuidelines: [
			"Use squad when work spans 2+ concerns (backend+frontend+tests+docs) or has natural parallelism",
			"Skip squad for single-file changes, quick fixes, or anything one agent finishes in minutes",
			"Providing tasks yourself makes you the planner — follow the planner rules (contract task first, final QA task, 3-7 tasks)",
			"Act on ⚠️ plan warnings in the response — fix with squad_modify or address at review",
			"When the squad completes, review evidence like a QA agent before reporting success",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "What the squad should accomplish" }),
			agents: Type.Optional(
				Type.Record(
					Type.String(),
					Type.Object({
						model: Type.Optional(Type.String({ description: "Model override (e.g. 'github-copilot/claude-sonnet-5')" })),
						thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max" })),
					}),
					{ description: "Agent roster with optional model/thinking overrides. Keys must match agent names in .pi/squad/agents/" },
				),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.String(),
						description: Type.Optional(Type.String({ description: "Structure as: Goal (outcome first, not steps), Context (files/contracts to read), Output (deliverable), Boundaries (what must NOT change), Verify (command that proves it works). Include only the parts that help." })),
						agent: Type.String(),
						depends: Type.Optional(Type.Array(Type.String())),
						inheritContext: Type.Optional(Type.Boolean({ description: "Fork the current pi session so the agent inherits this conversation's full context. Use ONLY when the task depends on decisions/details discussed here that can't be restated briefly. Costly (agent pays the whole history as input each turn) and auto-skipped when the session exceeds 50% of the agent model's context window — prefer restating key context in the description." })),
					}),
					{ description: "Pre-defined task breakdown. If provided, skips the planner agent. Scope tasks to required work only — no optional polish." },
				),
			),
			config: Type.Optional(
				Type.Object({
					maxConcurrency: Type.Optional(Type.Number({ description: "Max parallel agents (default: 2)" })),
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!squadEnabled) return { content: [{ type: "text" as const, text: "Squad is disabled. Use /squad enable to re-enable." }], details: undefined };
			if (!uiCtx) uiCtx = ctx;

			// Check if the user cancelled before we start
			if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled." }], details: undefined };

			// Multiple squads can run concurrently — no guard needed

			// Resolve to absolute: the fork happens later from a child process whose
			// cwd may differ (e.g. when a relative --session-dir was used).
			const rawSessionFile = ctx.sessionManager.getSessionFile();
			const sessionFile = rawSessionFile ? path.resolve(rawSessionFile) : null;
			const squadId = store.makeTaskId(params.goal);
			if (store.squadExists(squadId)) {
				const uniqueId = `${squadId}-${Date.now().toString(36)}`;
				return await startSquad(uniqueId, params, ctx.cwd, squadSkillPaths, pi, sessionFile);
			}

			return await startSquad(squadId, params, ctx.cwd, squadSkillPaths, pi, sessionFile);
		},
	});

	// =========================================================================
	// Tool: squad_status
	// =========================================================================

	pi.registerTool({
		name: "squad_status",
		label: "Squad Status",
		description: "Check current squad status, task progress, and recent activity.",
		parameters: Type.Object({
			squadId: Type.Optional(Type.String({ description: "Specific squad ID (default: most recent)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let id = params.squadId || activeSquadId;

			// If no active squad, find the most recent one for this project
			if (!id) {
				const latest = store.findLatestSquad(ctx.cwd);
				if (latest) id = latest.id;
			}

			if (!id) {
				return { content: [{ type: "text" as const, text: "No squads found. Use the squad tool to start one." }], details: undefined };
			}

			// If scheduler is running, force a context refresh
			const sched = schedulers.get(id!);
				if (sched) sched.updateContext();

			const context = store.loadContext(id);
			if (!context) {
				return { content: [{ type: "text" as const, text: `Squad '${id}' not found or has no context yet.` }], details: undefined };
			}

			const taskLines = Object.entries(context.tasks)
				.map(([taskId, task]) => {
					const icon =
						task.status === "done" ? "✓" :
						task.status === "in_progress" ? "⏳" :
						task.status === "blocked" ? "◻" :
						task.status === "failed" ? "✗" :
						"·";
					let line = `${icon} ${taskId} (${task.agent}) — ${task.title} [${task.status}]`;
					if (task.blockedBy?.length) line += ` blocked by: ${task.blockedBy.join(", ")}`;
					return line;
				})
				.join("\n");

			const summary = [
				`Squad: ${id}`,
				`Status: ${context.status}`,
				`Elapsed: ${context.elapsed}`,
				`Cost: $${context.costs.total.toFixed(4)}`,
				"",
				"Tasks:",
				taskLines,
			].join("\n");

			return { content: [{ type: "text" as const, text: summary }], details: undefined };
		},
	});

	// =========================================================================
	// Tool: squad_message
	// =========================================================================

	pi.registerTool({
		name: "squad_message",
		label: "Squad Message",
		description: "Send a message to a specific agent or task in the running squad.",
		parameters: Type.Object({
			message: Type.String({ description: "Message to send" }),
			taskId: Type.Optional(Type.String({ description: "Target task ID" })),
			agent: Type.Optional(Type.String({ description: "Target agent name" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const activeScheduler = getActiveScheduler();
			if (!activeScheduler || !activeSquadId) {
				return { content: [{ type: "text" as const, text: "No active squad." }], details: undefined };
			}

			let taskId = params.taskId;

			// If agent specified but no taskId, find their current task
			if (!taskId && params.agent) {
				taskId = activeScheduler.getPool().getTaskIdForAgent(params.agent) || undefined;
			}

			if (!taskId) {
				return { content: [{ type: "text" as const, text: "Could not determine target task. Provide taskId or an agent name that is currently running." }], details: undefined };
			}

			const sent = await activeScheduler!.sendHumanMessage(taskId, params.message);
			const status = sent ? "delivered" : "queued for when the agent starts";

			return { content: [{ type: "text" as const, text: `Message ${status}: "${params.message}"` }], details: undefined };
		},
	});

	// =========================================================================
	// Tool: squad_modify
	// =========================================================================

	pi.registerTool({
		name: "squad_modify",
		label: "Squad Modify",
		description: "Modify the running squad: add_task, cancel_task, pause, resume, cancel (entire squad).",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("add_task"),
					Type.Literal("cancel_task"),
					Type.Literal("pause_task"),
					Type.Literal("resume_task"),
					Type.Literal("pause"),
					Type.Literal("resume"),
					Type.Literal("cancel"),
				],
				{ description: "Action to perform" },
			),
			taskId: Type.Optional(Type.String({ description: "Task ID for task-specific actions" })),
			task: Type.Optional(
				Type.Object({
					id: Type.String(),
					title: Type.String(),
					description: Type.Optional(Type.String()),
					agent: Type.String(),
					depends: Type.Optional(Type.Array(Type.String())),
					inheritContext: Type.Optional(Type.Boolean({ description: "Fork the current pi session so the agent inherits this conversation's context (see squad tool docs for caveats)" })),
				}, { description: "Task definition for add_task" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Resume can work without an active scheduler — it recreates one from disk
			if (params.action === "resume") {
				// Find a squad to resume: use activeSquadId or find the latest paused one
				const squadId = activeSquadId || store.findActiveSquads()
					.filter((s) => s.cwd === ctx.cwd && s.status === "paused")
					.sort((a, b) => b.created.localeCompare(a.created))[0]?.id;

				if (!squadId) {
					return { content: [{ type: "text" as const, text: "No paused squad found to resume." }], details: undefined };
				}

				// Create a fresh scheduler if needed
				if (!schedulers.has(squadId)) {
					const scheduler = new Scheduler(squadId, squadSkillPaths, schedulerSpawnContext);
					schedulers.set(squadId, scheduler);
					activeSquadId = squadId;

					// Activate widget
					widgetState.squadId = squadId;
					widgetState.enabled = true;
					widgetControls?.requestUpdate();

					// Wire up events (same as startSquad)
					scheduler.onEvent((event: SchedulerEvent) => {
						forceWidgetUpdate();
						switch (event.type) {
							case "squad_completed": {
								const tasks = store.loadAllTasks(squadId);
								const summary = tasks
									.filter((t) => t.status === "done")
									.map((t) => `- ${t.id} (${t.agent}): ${t.output?.slice(0, 150) || "done"}`)
									.join("\n");
								const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
								const s = schedulers.get(squadId); if (s) s.updateContext();
								pi.sendMessage({
									customType: "squad-completed",
									content: `[squad] Squad "${squadId}" completed all ${tasks.length} tasks.\n\nSummary:\n${summary}\n\nTotal cost: $${totalCost.toFixed(4)}\n\n${REVIEW_INSTRUCTIONS}`,
									display: true,
								});
								schedulers.delete(squadId);
								forceWidgetUpdate();
								break;
							}
							case "squad_failed": {
								const tasks = store.loadAllTasks(squadId);
								const failed = tasks.filter((t) => t.status === "failed");
								const done = tasks.filter((t) => t.status === "done");
								pi.sendMessage({
									customType: "squad-failed",
									content: `[squad] Squad "${squadId}" has stalled. ${done.length}/${tasks.length} done, ${failed.length} failed.\nFailed: ${failed.map((t) => `${t.id}: ${t.error?.slice(0, 100)}`).join("; ")}`,
									display: true,
								}, { triggerTurn: true });
								forceWidgetUpdate();
								break;
							}
							case "escalation": {
								pi.sendMessage({
									customType: "squad-escalation",
									content: `[squad] Agent '${event.agentName}' on task '${event.taskId}' needs attention:\n${event.message}`,
									display: true,
								}, { triggerTurn: true });
								break;
							}
						}
					});
				}

				const resumeSched = schedulers.get(squadId)!;
				resumeSched.resume().catch((err) => {
					logError("squad", `Resume error: ${(err as Error).message}`);
				});

				const tasks = store.loadAllTasks(squadId);
				const done = tasks.filter(t => t.status === "done").length;
				return { content: [{ type: "text" as const, text: `Squad "${squadId}" resumed (${done}/${tasks.length} done). Agents restarting in background.` }], details: undefined };
			}

			const activeScheduler = getActiveScheduler();
			if (!activeScheduler || !activeSquadId) {
				return { content: [{ type: "text" as const, text: "No active squad. Use squad_modify with action 'resume' to resume a paused squad, or start a new one with the squad tool." }], details: undefined };
			}

			switch (params.action) {
				case "add_task": {
					if (!params.task) {
						return { content: [{ type: "text" as const, text: "Provide a task definition for add_task." }], details: undefined };
					}
					// Validate against the live squad: deps must exist, agent must exist
					const existing = store.loadAllTasks(activeSquadId);
					const existingIds = new Set(existing.map((t) => t.id));
					if (existingIds.has(params.task.id)) {
						return { content: [{ type: "text" as const, text: `Task id '${params.task.id}' already exists in this squad.` }], details: undefined };
					}
					const badDeps = (params.task.depends || []).filter((d) => !existingIds.has(d));
					if (badDeps.length > 0) {
						return { content: [{ type: "text" as const, text: `Unknown dependency task(s): ${badDeps.join(", ")}. Existing tasks: ${[...existingIds].join(", ")}` }], details: undefined };
					}
					if (!store.loadAgentDef(params.task.agent, ctx.cwd)) {
						const available = store.loadAllAgentDefs(ctx.cwd).filter((a) => !a.disabled).map((a) => a.name).join(", ");
						return { content: [{ type: "text" as const, text: `Unknown agent '${params.task.agent}'. Available: ${available}` }], details: undefined };
					}
					const task: Task = {
						id: params.task.id,
						title: params.task.title,
						description: params.task.description || "",
						agent: params.task.agent,
						status: "pending",
						depends: params.task.depends || [],
						...(params.task.inheritContext ? { inheritContext: true } : {}),
						created: store.now(),
						started: null,
						completed: null,
						output: null,
						error: null,
						usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
					};
					store.createTask(activeSquadId, task);
					activeScheduler.updateContext();
					return { content: [{ type: "text" as const, text: `Task '${task.id}' added.` }], details: undefined };
				}

				case "cancel_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
					await activeScheduler.cancelTask(params.taskId);
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' cancelled.` }], details: undefined };
				}

				case "pause_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
					await activeScheduler.pauseTask(params.taskId);
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' paused.` }], details: undefined };
				}

				case "resume_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
					activeScheduler.resumeTask(params.taskId).catch((err) => {
						logError("squad", `Resume task error: ${(err as Error).message}`);
					});
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' resumed.` }], details: undefined };
				}

				case "pause": {
					const squad = store.loadSquad(activeSquadId);
					if (squad) {
						squad.status = "paused";
						store.saveSquad(squad);
					}
					await activeScheduler.stop();
					return { content: [{ type: "text" as const, text: "Squad paused. Use squad_modify with action 'resume' to continue." }], details: undefined };
				}

				// Note: "resume" is handled above, before the activeScheduler guard.

				case "cancel": {
					await activeScheduler.stop();
					const squad = store.loadSquad(activeSquadId);
					if (squad) {
						squad.status = "failed";
						store.saveSquad(squad);
					}
					schedulers.delete(activeSquadId);
					activeSquadId = null;
					return { content: [{ type: "text" as const, text: "Squad cancelled." }], details: undefined };
				}

				default:
					return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }], details: undefined };
			}
		},
	});

	// =========================================================================
	// Session Lifecycle
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;

		// Install component-based widget
		if (ctx.hasUI) {
			widgetControls = setupSquadWidget(ctx, widgetState);
		}

		// Clean up orphaned squads from crashed sessions:
		// If a squad is "running" but has no live scheduler, its parent died.
		// Suspend in-progress tasks and mark the squad as paused so it doesn't
		// block new squads or trigger confusing followUp messages.
		const orphaned = store.findActiveSquads()
			.filter((s) => s.cwd === ctx.cwd && s.status === "running");
		for (const squad of orphaned) {
			const tasks = store.loadAllTasks(squad.id);
			let hadInProgress = false;
			for (const task of tasks) {
				if (task.status === "in_progress") {
					store.updateTaskStatus(squad.id, task.id, "suspended");
					hadInProgress = true;
				}
			}
			if (hadInProgress) {
				squad.status = "paused";
				store.saveSquad(squad);
			}
		}

		// Notify about paused squads only if they have real completed work
		const paused = store.findActiveSquads()
			.filter((s) => s.cwd === ctx.cwd && s.status === "paused");
		if (paused.length > 0) {
			const squad = paused[0];
			const tasks = store.loadAllTasks(squad.id);
			const done = tasks.filter(t => t.status === "done").length;
			// Only notify if at least 1 task completed — worth resuming
			if (done > 0) {
				pi.sendMessage({
					customType: "squad-paused",
					content: `[squad] Found paused squad "${squad.id}" (${squad.goal}) — ${done}/${tasks.length} done. ` +
						`Use squad_modify with action "resume" to continue, or start a new squad.`,
					display: true,
				});
			}
		}

		// Register Ctrl+Q terminal input handler for panel toggle
		if (ctx.hasUI) {
			ctx.ui.onTerminalInput((data) => {
				if (data === "\x11") {
					// If overlay is already open, let the panel's own handler deal with it
					if (overlayOpen) return undefined;

					// Auto-pick a squad if none active
					if (!activeSquadId) {
						const latest = store.findLatestSquad(ctx.cwd)
							|| store.listSquads().map((id) => store.loadSquad(id)).filter((s): s is Squad => s !== null).sort((a, b) => b.created.localeCompare(a.created))[0];
						if (latest) {
							activateSquadView(latest.id, ctx);
						} else {
							ctx.ui.notify("No squads found. Use /squad or the squad tool.", "info");
							return { consume: true };
						}
					}

					if (activeSquadId) {
						openPanel(ctx, schedulers.get(activeSquadId) || new Scheduler(activeSquadId, squadSkillPaths, schedulerSpawnContext), activeSquadId);
					}
					return { consume: true };
				}
				return undefined;
			});
		}
	});

	pi.on("session_shutdown", async () => {
		widgetControls?.dispose();
		widgetControls = null;
		for (const [id, sched] of schedulers) {
			await sched.stop();
		}
		schedulers.clear();
		activeSquadId = null;
		uiCtx = null;
	});

	// =========================================================================
	// Slash Commands
	// =========================================================================

	pi.registerCommand("squad", {
		description: "Browse, select, and manage squads. Usage: /squad [list|all|select|agents|msg|widget|panel|cancel|clear]",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "list", label: "list", description: "List squads for current project" },
				{ value: "all", label: "all", description: "List all squads, select to activate" },
				{ value: "select", label: "select", description: "Pick a squad to view (interactive)" },
				{ value: "agents", label: "agents", description: "List, view, or edit agent definitions" },
				{ value: "defaults", label: "defaults", description: "Default model/thinking for agents (follow main session, pi default, or fixed)" },
				{ value: "advisor", label: "advisor", description: "Advisor-first rescue for stuck agents (on/off, model, limits)" },
				{ value: "msg", label: "msg", description: "Send message to agent: /squad msg [agent] text" },
				{ value: "widget", label: "widget", description: "Toggle live widget" },
				{ value: "panel", label: "panel", description: "Toggle overlay panel" },
				{ value: "cancel", label: "cancel", description: "Cancel running squad" },
				{ value: "clear", label: "clear", description: "Dismiss widget and deactivate squad" },
				{ value: "cleanup", label: "cleanup", description: "Delete squad data (select or all)" },
				{ value: "enable", label: "enable", description: "Enable pi-squad (tools, widget, system prompt)" },
				{ value: "disable", label: "disable", description: "Disable pi-squad completely" },
			];
			return subs.filter((s) => s.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "select";

			switch (sub) {
				case "list": {
					const squads = store.listSquadsForProject(ctx.cwd);
					if (squads.length === 0) {
						ctx.ui.notify(`No squads for this project`, "info");
						return;
					}
					const selected = await pickSquad(ctx, squads);
					if (selected) activateSquadView(selected.id, ctx);
					return;
				}

				case "all": {
					const all = store.listSquads()
						.map((id) => store.loadSquad(id))
						.filter((s): s is Squad => s !== null)
						.sort((a, b) => b.created.localeCompare(a.created));
					if (all.length === 0) {
						ctx.ui.notify("No squads found", "info");
						return;
					}
					const selected = await pickSquad(ctx, all, true);
					if (selected) activateSquadView(selected.id, ctx);
					return;
				}

				case "select": {
					// Interactive selector — show project squads first, fall back to all
					let squads = store.listSquadsForProject(ctx.cwd);
					let showProject = false;
					if (squads.length === 0) {
						squads = store.listSquads()
							.map((id) => store.loadSquad(id))
							.filter((s): s is Squad => s !== null)
							.sort((a, b) => b.created.localeCompare(a.created));
						showProject = true;
					}
					if (squads.length === 0) {
						ctx.ui.notify("No squads found", "info");
						return;
					}
					// If only one, activate it directly
					if (squads.length === 1) {
						activateSquadView(squads[0].id, ctx);
						return;
					}
					const selected = await pickSquad(ctx, squads, showProject);
					if (selected) activateSquadView(selected.id, ctx);
					return;
				}

				case "widget": {
					widgetState.enabled = !widgetState.enabled;
					if (widgetState.enabled) {
						if (!activeSquadId) {
							const latest = store.findLatestSquad(ctx.cwd);
							if (latest) activateSquadView(latest.id, ctx);
						}
					}
					// requestUpdate handles both enable (renders) and disable (clears)
					widgetControls?.requestUpdate();
					ctx.ui.notify(`Squad widget ${widgetState.enabled ? "enabled" : "disabled"}`, "info");
					return;
				}

				case "panel": {
					// Activate latest squad if none active
					if (!activeSquadId) {
						const latest = store.findLatestSquad(ctx.cwd);
						if (latest) {
							activateSquadView(latest.id, ctx);
						} else {
							ctx.ui.notify("No squads found", "info");
							return;
						}
					}
					if (activeSquadId) {
						const sched = schedulers.get(activeSquadId) || new Scheduler(activeSquadId, squadSkillPaths, schedulerSpawnContext);
						openPanel(ctx, sched, activeSquadId);
					}
					return;
				}

				case "msg": {
					if (!activeSquadId) {
						ctx.ui.notify("No active squad. Use /squad select first.", "info");
						return;
					}
					const msgSquad = store.loadSquad(activeSquadId);
					if (!msgSquad || msgSquad.status !== "running") {
						ctx.ui.notify("Squad is not running — messages only reach running agents.", "info");
						return;
					}
					// Parse: /squad msg [agent] message text
					const msgParts = parts.slice(1);
					let targetAgent: string | undefined;
					let msgText: string;

					if (msgParts.length === 0) {
						// Interactive: ask for message
						const input = await ctx.ui.input("Message to squad agent", "Type your message...");
						if (!input) return;
						msgText = input;
					} else {
						// Check if first word is an agent name
						const maybeAgent = store.loadAgentDef(msgParts[0], msgSquad.cwd);
						if (maybeAgent && msgParts.length > 1) {
							targetAgent = msgParts[0];
							msgText = msgParts.slice(1).join(" ");
						} else {
							msgText = msgParts.join(" ");
						}
					}

					// Find target task
					const msgTasks = store.loadAllTasks(activeSquadId);
					let targetTaskId: string | undefined;

					if (targetAgent) {
						const agentTask = msgTasks.find((t) => t.agent === targetAgent && t.status === "in_progress");
						targetTaskId = agentTask?.id;
						if (!targetTaskId) {
							ctx.ui.notify(`Agent '${targetAgent}' has no running task`, "warning");
							return;
						}
					} else {
						const runningTask = msgTasks.find((t) => t.status === "in_progress");
						targetTaskId = runningTask?.id;
						targetAgent = runningTask?.agent;
						if (!targetTaskId) {
							ctx.ui.notify("No running tasks to message", "warning");
							return;
						}
					}

					const msgSched = getActiveScheduler();
					if (msgSched) {
						await msgSched.sendHumanMessage(targetTaskId, msgText);
						ctx.ui.notify(`Sent to ${targetAgent}: "${msgText.slice(0, 50)}"`, "info");
					} else {
						store.appendMessage(activeSquadId, targetTaskId, {
							ts: store.now(),
							from: "human",
							type: "message",
							text: msgText,
						});
						ctx.ui.notify(`Logged to ${targetTaskId} (agent not running)`, "info");
					}
					forceWidgetUpdate();
					return;
				}

				case "cancel": {
					const cancelSched = getActiveScheduler();
					if (!cancelSched) {
						ctx.ui.notify("No running squad to cancel", "info");
						return;
					}
					await cancelSched.stop();
					const squad = store.loadSquad(activeSquadId!);
					if (squad) { squad.status = "failed"; store.saveSquad(squad); }
					if (activeSquadId) schedulers.delete(activeSquadId);
					forceWidgetUpdate();
					ctx.ui.notify("Squad cancelled", "info");
					return;
				}

				case "clear": {
					if (activeSquadId) schedulers.delete(activeSquadId);
					activeSquadId = null;
					widgetState.squadId = null;
					widgetControls?.dispose();
					ctx.ui.notify("Squad view cleared", "info");
					return;
				}

				case "cleanup": {
					const cleanupArg = parts[1];
					const allSquadIds = store.listSquads();

					if (allSquadIds.length === 0) {
						ctx.ui.notify("No squads to clean up", "info");
						return;
					}

					if (cleanupArg === "all") {
						// Stop any running schedulers first
						for (const [id, sched] of schedulers) {
							await sched.stop();
						}
						schedulers.clear();
						activeSquadId = null;
						widgetState.squadId = null;
						widgetControls?.requestUpdate();

						let count = 0;
						for (const id of allSquadIds) {
							fs.rmSync(store.getSquadDir(id), { recursive: true, force: true });
							count++;
						}
						ctx.ui.notify(`Deleted ${count} squad(s)`, "info");
						return;
					}

					// Interactive: pick squads to delete
					const squads = allSquadIds
						.map((id) => store.loadSquad(id))
						.filter((s): s is Squad => s !== null)
						.sort((a, b) => b.created.localeCompare(a.created));

					const options = [
						"🗑  Delete ALL squads",
						...squads.map((s) => {
							const tasks = store.loadAllTasks(s.id);
							const done = tasks.filter((t) => t.status === "done").length;
							const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
							const icon = s.status === "done" ? "✓" : s.status === "running" ? "⏳" : s.status === "failed" ? "✗" : "·";
							return `${icon} ${s.id} [${s.status}] ${done}/${tasks.length} $${cost.toFixed(2)}`;
						}),
					];

					const choice = await ctx.ui.select("Delete squad data", options);
					if (!choice) return;

					if (choice.startsWith("🗑")) {
						// Delete all
						for (const [id, sched] of schedulers) {
							await sched.stop();
						}
						schedulers.clear();
						activeSquadId = null;
						widgetState.squadId = null;
						widgetControls?.requestUpdate();
						let count = 0;
						for (const id of allSquadIds) {
							fs.rmSync(store.getSquadDir(id), { recursive: true, force: true });
							count++;
						}
						ctx.ui.notify(`Deleted ${count} squad(s)`, "info");
					} else {
						// Delete selected
						const idx = options.indexOf(choice) - 1; // -1 for the "Delete ALL" option
						if (idx >= 0 && idx < squads.length) {
							const squad = squads[idx];
							// Stop scheduler if running
							const sched = schedulers.get(squad.id);
							if (sched) {
								await sched.stop();
								schedulers.delete(squad.id);
							}
							if (activeSquadId === squad.id) {
								activeSquadId = null;
								widgetState.squadId = null;
								widgetControls?.requestUpdate();
							}
							fs.rmSync(store.getSquadDir(squad.id), { recursive: true, force: true });
							ctx.ui.notify(`Deleted: ${squad.id}`, "info");
						}
					}
					return;
				}

				case "enable": {
					squadEnabled = true;
					widgetControls?.requestUpdate();
					ctx.ui.notify("pi-squad enabled — tools, widget, and system prompt active", "info");
					return;
				}

				case "disable": {
					squadEnabled = false;
					// Stop all running schedulers
					for (const [id, sched] of schedulers) {
						await sched.stop();
					}
					schedulers.clear();
					activeSquadId = null;
					widgetState.squadId = null;
					widgetState.enabled = false;
					widgetControls?.requestUpdate();
					ctx.ui.notify("pi-squad disabled — all tools, widget, and system prompt injection stopped", "info");
					return;
				}

				case "defaults": {
					const settings = store.loadSquadSettings();
					const mainModel = getMainSessionModel() || "(unknown)";
					const mainThinking = getMainSessionThinking() || "(unknown)";
					const fmtPolicy = (v: string, live: string) =>
						v === "main" ? `follow main session (now: ${live})` : v === "pi-default" ? "pi default" : v;

					const which = await ctx.ui.select(
						`Squad defaults — model: ${fmtPolicy(settings.defaultModel, mainModel)} | thinking: ${fmtPolicy(settings.defaultThinking, mainThinking)}`,
						["Change default model", "Change default thinking", "Cancel"],
					);
					if (!which || which === "Cancel") return;

					if (which === "Change default model") {
						const choice = await ctx.ui.select("Default model for squad agents", [
							`Follow main session (now: ${mainModel})`,
							"pi default (child pi resolves its own)",
							"Custom model…",
						]);
						if (!choice) return;
						if (choice.startsWith("Follow")) settings.defaultModel = "main";
						else if (choice.startsWith("pi default")) settings.defaultModel = "pi-default";
						else {
							const custom = await ctx.ui.input("Model id (e.g. openai-codex/gpt-5.6-terra)", settings.defaultModel === "main" || settings.defaultModel === "pi-default" ? "" : settings.defaultModel);
							if (!custom || !custom.trim()) return;
							settings.defaultModel = custom.trim();
						}
						store.saveSquadSettings(settings);
						ctx.ui.notify(`Squad default model → ${fmtPolicy(settings.defaultModel, mainModel)}`, "info");
					} else {
						const choice = await ctx.ui.select("Default thinking for squad agents", [
							`Follow main session (now: ${mainThinking})`,
							"pi default (child pi resolves its own)",
							...THINKING_LEVELS,
						]);
						if (!choice) return;
						if (choice.startsWith("Follow")) settings.defaultThinking = "main";
						else if (choice.startsWith("pi default")) settings.defaultThinking = "pi-default";
						else settings.defaultThinking = choice;
						store.saveSquadSettings(settings);
						ctx.ui.notify(`Squad default thinking → ${fmtPolicy(settings.defaultThinking, mainThinking)}`, "info");
					}
					return;
				}

				case "advisor": {
					const settings = store.loadSquadSettings();
					const adv = settings.advisor;
					const mainModelLabel = getMainSessionModel() || "(unknown)";
					const modelLabel = adv.model === "main" ? `main session (now: ${mainModelLabel})` : adv.model;

					const choice = await ctx.ui.select(
						`Squad advisor — ${adv.enabled ? "ON" : "OFF"} | model: ${modelLabel} | ${adv.maxCallsPerTask} calls/task, ${adv.reasoning} reasoning`,
						[adv.enabled ? "Disable advisor" : "Enable advisor", "Change advisor model", "Change max calls per task", "Change reasoning effort", "Cancel"],
					);
					if (!choice || choice === "Cancel") return;

					if (choice.startsWith("Disable") || choice.startsWith("Enable")) {
						adv.enabled = !adv.enabled;
						ctx.ui.notify(`Squad advisor ${adv.enabled ? "enabled — stuck agents get a strong-model rescue before escalating" : "disabled — stuck agents escalate directly"}`, "info");
					} else if (choice === "Change advisor model") {
						const sel = await ctx.ui.select("Advisor model", [`Follow main session (now: ${mainModelLabel})`, "Custom model…"]);
						if (!sel) return;
						if (sel.startsWith("Follow")) adv.model = "main";
						else {
							const custom = await ctx.ui.input("Advisor model (provider/id)", adv.model === "main" ? "" : adv.model);
							if (!custom || !custom.trim()) return;
							adv.model = custom.trim();
						}
						ctx.ui.notify(`Advisor model → ${adv.model}`, "info");
					} else if (choice === "Change max calls per task") {
						const n = await ctx.ui.input("Max advisor calls per task", String(adv.maxCallsPerTask));
						const parsed = n ? Number.parseInt(n, 10) : NaN;
						if (!Number.isFinite(parsed) || parsed < 0) return;
						adv.maxCallsPerTask = parsed;
						ctx.ui.notify(`Advisor max calls/task → ${parsed}`, "info");
					} else {
						const lvl = await ctx.ui.select("Advisor reasoning effort", ["minimal", "low", "medium", "high", "xhigh"]);
						if (!lvl) return;
						adv.reasoning = lvl;
						ctx.ui.notify(`Advisor reasoning → ${lvl}`, "info");
					}
					store.saveSquadSettings(settings);
					return;
				}

				case "agents": {
					const agentArg = parts[1];
					const allAgents = store.loadAllAgentDefs(ctx.cwd);

					if (!agentArg) {
						// List all agents — interactive selector
						if (allAgents.length === 0) {
							ctx.ui.notify("No agents found", "info");
							return;
						}
						const options = allAgents.map((a) => {
							const model = a.model ? ` [${a.model}${a.thinking ? `:${a.thinking}` : ""}]` : a.thinking ? ` [default:${a.thinking}]` : " [default]";
							const status = a.disabled ? " ✗ disabled" : "";
							return `${a.name} — ${a.role}${model}${status}`;
						});
						const choice = await ctx.ui.select("Squad Agents (select to view/edit)", options);
						if (!choice) return;
						const selectedName = choice.split(" — ")[0];
						const agent = allAgents.find((a) => a.name === selectedName);
						if (!agent) return;

						// Show agent details and offer actions
						const disableLabel = agent.disabled ? "Enable agent" : "Disable agent";
						const actions = [
							"View details",
							"Edit in editor",
							"Change model",
							"Change thinking",
							"Toggle tools (restrict/unrestrict)",
							disableLabel,
							"Cancel",
						];
						const action = await ctx.ui.select(`${agent.name} (${agent.role})`, actions);
						if (!action || action === "Cancel") return;

						if (action === "View details") {
							const details = [
								`Name: ${agent.name}`,
								`Role: ${agent.role}`,
								`Description: ${agent.description}`,
								`Model: ${agent.model || "(default)"}`,
								`Thinking: ${agent.thinking || "(default)"}`,
								`Tools: ${agent.tools ? agent.tools.join(", ") : "(all)"}`,
								`Tags: ${agent.tags.join(", ")}`,
								``,
								`Prompt:`,
								`${agent.prompt.slice(0, 300)}${agent.prompt.length > 300 ? "..." : ""}`,
								``,
								`File: ${store.getGlobalAgentsDir()}/${agent.name}.json`,
							].join("\n");
							ctx.ui.notify(details, "info");
						} else if (action === "Edit in editor") {
							// Check for local override first, fall back to global
							const localPath = `${store.getLocalAgentsDir(ctx.cwd)}/${agent.name}.json`;
							const globalPath = `${store.getGlobalAgentsDir()}/${agent.name}.json`;
							const filePath = fs.existsSync(localPath) ? localPath : globalPath;
							pi.sendMessage({
								customType: "squad-edit-agent",
								content: `Edit agent file: ${filePath}`,
								display: true,
							}, { triggerTurn: true });
						} else if (action === "Change model") {
							const newModel = await ctx.ui.input(
								`Model for ${agent.name} (empty = default)`,
								agent.model || "",
							);
							if (newModel !== undefined) {
								agent.model = newModel.trim() || null;
								store.saveAgentDef(agent);
								ctx.ui.notify(`${agent.name} model → ${agent.model || "(default)"}`, "info");
							}
						} else if (action === "Change thinking") {
							const levels = ["(default)", ...THINKING_LEVELS];
							const level = await ctx.ui.select(`Thinking level for ${agent.name}`, levels);
							if (level !== undefined) {
								agent.thinking = level === "(default)" ? null : level;
								store.saveAgentDef(agent);
								ctx.ui.notify(`${agent.name} thinking → ${agent.thinking || "(default)"}`, "info");
							}
						} else if (action === disableLabel) {
							agent.disabled = !agent.disabled;
							store.saveAgentDef(agent);
							const newState = agent.disabled ? "disabled — planner will not assign tasks to this agent" : "enabled";
							ctx.ui.notify(`${agent.name}: ${newState}`, "info");
						} else if (action === "Toggle tools") {
							if (agent.tools) {
								agent.tools = null;
								store.saveAgentDef(agent);
								ctx.ui.notify(`${agent.name}: all tools enabled`, "info");
							} else {
								const toolList = await ctx.ui.input(
									`Tools for ${agent.name} (comma-separated)`,
									"bash,read,write,edit",
								);
								if (toolList) {
									agent.tools = toolList.split(",").map((t) => t.trim()).filter(Boolean);
									store.saveAgentDef(agent);
									ctx.ui.notify(`${agent.name}: tools = [${agent.tools.join(", ")}]`, "info");
								}
							}
						}
						return;
					}

					// /squad agents <name> — show specific agent
					const agent = store.loadAgentDef(agentArg, ctx.cwd);
					if (agent) {
						const status = agent.disabled ? " ✗ DISABLED" : "";
						const details = [
							`${agent.name} — ${agent.role}${status}`,
							`${agent.description}`,
							`Model: ${agent.model || "(default)"}`,
							`Thinking: ${agent.thinking || "(default)"}`,
							`Tools: ${agent.tools ? agent.tools.join(", ") : "(all)"}`,
							`Tags: ${agent.tags.join(", ")}`,
						].join("\n");
						ctx.ui.notify(details, "info");
					} else {
						ctx.ui.notify(`Agent '${agentArg}' not found`, "warning");
					}
					return;
				}

				default:
					// Treat as a squad ID — try to activate it directly
					const direct = store.loadSquad(sub);
					if (direct) {
						activateSquadView(direct.id, ctx);
						return;
					}
					ctx.ui.notify(`Unknown: /squad ${sub}. Try: list, all, select, agents, defaults, msg, widget, panel, cancel, clear, cleanup`, "warning");
			}
		},
	});

}

// ============================================================================
// Squad Selection & Activation
// ============================================================================

/**
 * Show an interactive selector to pick a squad.
 * Returns the selected squad or undefined if cancelled.
 */
async function pickSquad(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
	squads: Squad[],
	showProject = false,
): Promise<Squad | undefined> {
	if (squads.length === 0) return undefined;

	const options = squads.map((s) => {
		const tasks = store.loadAllTasks(s.id);
		const done = tasks.filter((t) => t.status === "done").length;
		const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
		const icon = s.status === "done" ? "✓" : s.status === "running" ? "⏳" : s.status === "failed" ? "✗" : "·";
		const project = showProject ? ` — ${s.cwd.split("/").pop()}` : "";
		return `${icon} ${s.id} [${s.status}] ${done}/${tasks.length} $${cost.toFixed(2)}${project}`;
	});

	const choice = await ctx.ui.select("Select a squad", options);
	if (choice === undefined) return undefined;

	const idx = options.indexOf(choice);
	return idx >= 0 ? squads[idx] : undefined;
}

/**
 * Activate a squad for viewing in this session.
 * Sets activeSquadId, starts widget, shows notification.
 * Does NOT start a scheduler (view-only unless squad needs resuming).
 */
function activateSquadView(squadId: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | import("@earendil-works/pi-coding-agent").ExtensionCommandContext): void {
	const squad = store.loadSquad(squadId);
	if (!squad) {
		ctx.ui.notify(`Squad '${squadId}' not found`, "error");
		return;
	}

	activeSquadId = squadId;

	// Update widget to show the new squad. The widget reads squadId on each
	// render, so just updating the state and requesting a render is enough.
	widgetState.squadId = squadId;
	widgetState.enabled = true;
	widgetControls?.requestUpdate();

	// Compact notification — widget already shows full task details.
	// Avoid large multi-line notifications that can break TUI layout.
	const tasks = store.loadAllTasks(squadId);
	const done = tasks.filter((t) => t.status === "done").length;
	const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
	ctx.ui.notify(`Viewing: ${squad.id} [${squad.status}] ${done}/${tasks.length} $${cost.toFixed(2)}`, "info");
}

// ============================================================================
// Widget — component-based, event-driven (inspired by pi-interactive-shell)
// ============================================================================

/** Trigger widget re-render from scheduler events */
function forceWidgetUpdate(): void {
	widgetControls?.requestUpdate();
}

// ============================================================================
// Panel — overlay via ctx.ui.custom() with proper done() lifecycle
// ============================================================================

/**
 * Open the squad panel overlay.
 * Uses the pi-interactive-shell pattern: ctx.ui.custom() returns a Promise
 * that resolves when done() is called. The panel calls done() on close.
 */
function openPanel(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	scheduler: Scheduler,
	squadId: string,
): void {
	if (overlayOpen) return;
	overlayOpen = true;

	// The promise resolves when the panel calls done()
	const panelPromise = ctx.ui.custom<SquadPanelResult>(
		(tui, theme, _kb, done) => {
			const panel = new SquadPanel(tui, theme, scheduler, squadId, done);

			// Wire up message sending from panel
			panel.onSendMessage = async (taskId: string, _prefill: string) => {
				const task = store.loadTask(squadId, taskId);
				const agentName = task?.agent || taskId;
				const input = await ctx.ui.input(`Message to ${agentName}`, "Type your message...");
				const panelSched = schedulers.get(squadId);
				if (input && panelSched) {
					await panelSched.sendHumanMessage(taskId, input);
					ctx.ui.notify(`Sent to ${agentName}: "${input.slice(0, 50)}"`, "info");
				} else if (input) {
					store.appendMessage(squadId, taskId, {
						ts: store.now(),
						from: "human",
						type: "message",
						text: input,
					});
					ctx.ui.notify(`Logged to ${taskId}`, "info");
				}
				tui.requestRender();
			};

			return panel;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center" as const,
				width: "80%" as const,
				maxHeight: "80%" as const,
				margin: 2,
			},
		},
	);

	// When panel closes (done() called), clean up
	panelPromise.then(() => {
		overlayOpen = false;
		forceWidgetUpdate();
	}).catch(() => {
		overlayOpen = false;
	});
}

// ============================================================================
// Start Squad
// ============================================================================

async function startSquad(
	squadId: string,
	params: {
		goal: string;
		agents?: Record<string, { model?: string; thinking?: string }>;
		tasks?: Array<{
			id: string;
			title: string;
			description?: string;
			agent: string;
			depends?: string[];
			inheritContext?: boolean;
		}>;
		config?: { maxConcurrency?: number };
	},
	cwd: string,
	skillPaths: string[],
	pi: ExtensionAPI,
	sessionFile: string | null = null,
) {
	let plan: PlannerOutput;

	if (params.tasks && params.tasks.length > 0) {
		// User provided a plan — use it directly
		plan = {
			agents: params.agents || {},
			tasks: params.tasks.map((t) => ({
				...t,
				description: t.description || "",
				depends: t.depends || [],
			})),
		};

		// Validate agent names — remap unknown agents to fullstack
		for (const task of plan.tasks) {
			const agentDef = store.loadAgentDef(task.agent, cwd);
			if (!agentDef) {
				const original = task.agent;
				task.agent = "fullstack";
				task.description = `[Note: agent "${original}" not found, remapped to fullstack]\n\n${task.description}`;
			}
		}
	} else {
		// Run planner to generate task breakdown (squad default policy as fallback)
		try {
			const defaults = resolveSquadDefaults();
			plan = await runPlanner({ goal: params.goal, cwd, fallbackModel: defaults.model, fallbackThinking: defaults.thinking });
		} catch (error) {
			// Throwing marks the tool result as an error for the LLM (returning isError is ignored in current pi)
			throw new Error(`Failed to plan: ${(error as Error).message}`);
		}
	}

	// Merge agent roster
	const agents: Record<string, { model?: string; thinking?: string }> = { ...plan.agents };
	if (params.agents) {
		for (const [name, entry] of Object.entries(params.agents)) {
			agents[name] = { ...agents[name], ...entry };
		}
	}

	// Validate the plan — same enforcement for main-session and planner plans.
	// Errors block squad creation; warnings are reported back to the plan author.
	const validation = validatePlan(plan.tasks);
	if (validation.errors.length > 0) {
		throw new Error(
			`Plan rejected:\n- ${validation.errors.join("\n- ")}\n\nFix the task list and call squad again.`,
		);
	}

	// Create squad
	const config: SquadConfig = {
		...DEFAULT_SQUAD_CONFIG,
		...(params.config?.maxConcurrency ? { maxConcurrency: params.config.maxConcurrency } : {}),
	};

	const squad: Squad = {
		id: squadId,
		goal: params.goal,
		status: "running",
		created: store.now(),
		cwd,
		sessionFile,
		agents,
		config,
	};

	store.saveSquad(squad);

	// Create task files
	for (const taskDef of plan.tasks) {
		const task: Task = {
			id: taskDef.id,
			title: taskDef.title,
			description: taskDef.description,
			agent: taskDef.agent,
			status: taskDef.depends.length === 0 ? "pending" : "blocked",
			depends: taskDef.depends,
			...(taskDef.inheritContext ? { inheritContext: true } : {}),
			created: store.now(),
			started: null,
			completed: null,
			output: null,
			error: null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		};
		// Note: unknown dependency references are hard validation errors above,
		// so blocked tasks here always have resolvable deps.

		store.createTask(squadId, task);
	}

	// Start scheduler
	const scheduler = new Scheduler(squadId, skillPaths, schedulerSpawnContext);
	schedulers.set(squadId, scheduler);
	activeSquadId = squadId;

	// Activate widget for this squad
	widgetState.squadId = squadId;
	widgetState.enabled = true;
	widgetControls?.requestUpdate();

	// Wire up completion/escalation notifications to main agent
	scheduler.onEvent((event: SchedulerEvent) => {
		// Update widget on every scheduler event
		forceWidgetUpdate();
		switch (event.type) {
				case "squad_completed": {
				const tasks = store.loadAllTasks(squadId);
				const summary = tasks
					.filter((t) => t.status === "done")
					.map((t) => `- ${t.id} (${t.agent}): ${t.output?.slice(0, 150) || "done"}`)
					.join("\n");
				const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

				// Final context update before clearing scheduler
				const completedSched = schedulers.get(squadId);
				if (completedSched) {
					completedSched.updateContext();
				}

				pi.sendMessage({
					customType: "squad-completed",
					content: `[squad] Squad "${squadId}" completed all ${tasks.length} tasks.\n\n` +
						`Summary:\n${summary}\n\n` +
						`Total cost: $${totalCost.toFixed(4)}\n\n` +
						REVIEW_INSTRUCTIONS,
					display: true,
				});

				// Clear scheduler but keep activeSquadId so squad_status still works
				schedulers.delete(squadId);
				forceWidgetUpdate(); // Final update showing done state
				break;
			}

			case "squad_failed": {
				const tasks = store.loadAllTasks(squadId);
				const failed = tasks.filter((t) => t.status === "failed");
				const done = tasks.filter((t) => t.status === "done");

				pi.sendMessage({
					customType: "squad-failed",
					content: `[squad] Squad "${squadId}" has stalled. ` +
						`${done.length}/${tasks.length} tasks done, ${failed.length} failed.\n` +
						`Failed: ${failed.map((t) => `${t.id}: ${t.error?.slice(0, 100)}`).join("; ")}\n` +
						`Use squad_status for details or squad_modify to adjust.`,
					display: true,
				}, { triggerTurn: true });
				forceWidgetUpdate();
				break;
			}

			case "escalation": {
				// Escalation — agent needs help. triggerTurn so the main agent
				// can respond and relay help.
				pi.sendMessage({
					customType: "squad-escalation",
					content: `[squad] Agent '${event.agentName}' on task '${event.taskId}' needs attention:\n` +
						`${event.message}\n\n` +
						`Reply to me and I'll forward your answer, or use the squad panel.`,
					display: true,
				}, { triggerTurn: true });
				break;
			}
		}
	});

	// Start scheduling — fire and forget, don't block the tool call.
	// scheduler.start() spawns agents which can take seconds per agent.
	// We must return immediately so the main agent's turn completes
	// and the user regains interactive control.
	scheduler.start().catch((err) => {
		logError("squad", `Scheduler start error: ${(err as Error).message}`);
	});

	// Build response
	const taskSummary = plan.tasks
		.map((t) => {
			const deps = t.depends.length > 0 ? ` (depends: ${t.depends.join(", ")})` : "";
			return `${t.id} → ${t.agent}: ${t.title}${deps}`;
		})
		.join("\n");

	return {
		content: [
			{
				type: "text" as const,
				text: `Squad "${squadId}" started with ${plan.tasks.length} tasks.\n\n${taskSummary}${
					validation.warnings.length > 0
						? `\n\n⚠️ Plan warnings (fix with squad_modify, or address at review):\n- ${validation.warnings.join("\n- ")}`
						: ""
				}\n\nAgents are working in the background. Use squad_status to check progress.`,
			},
		],
		details: undefined,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function getSquadSkillPaths(skillsDir: string): string[] {
	if (!fs.existsSync(skillsDir)) return [];
	return fs
		.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => path.join(skillsDir, d.name))
		.filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
}


