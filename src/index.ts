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
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Squad, Task, SquadConfig, PlannerOutput } from "./types.js";
import { DEFAULT_SQUAD_CONFIG } from "./types.js";
import { Scheduler, type SchedulerEvent } from "./scheduler.js";
import { runPlanner } from "./planner.js";
import { SquadPanel } from "./panel/squad-panel.js";
import * as store from "./store.js";

// ============================================================================
// State
// ============================================================================

let activeScheduler: Scheduler | null = null;
let activeSquadId: string | null = null;
let activePanel: SquadPanel | null = null;
/** Stored ExtensionContext for widget updates from background scheduler events */
let uiCtx: import("@mariozechner/pi-coding-agent").ExtensionContext | null = null;
/** Interval for periodic widget refresh */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	// Don't load in child agent processes (prevent recursive squad-in-squad)
	if (process.env.PI_SQUAD_CHILD === "1") return;

	// Bootstrap default agents on first load
	const defaultsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "agents", "_defaults");
	store.bootstrapAgents(defaultsDir);

	// Collect squad skill paths
	const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "skills");
	const squadSkillPaths = getSquadSkillPaths(skillsDir);

	// =========================================================================
	// Context Injection — give main agent awareness of squad state
	// =========================================================================

	// Inject squad status before each LLM call so the main agent knows squad state
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!activeSquadId) return;
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

		// Append to system prompt so the agent always sees it
		return {
			systemPrompt: event.systemPrompt + "\n\n" + squadContext,
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
			"Use when a task needs multiple specialized skills (backend + frontend + testing),",
			"has natural parallelism, or would overflow a single agent's context.",
			"Don't use for simple single-file changes or tasks a single agent can handle.",
			"Non-blocking: returns immediately with the plan while agents work in background.",
		].join(" "),
		parameters: Type.Object({
			goal: Type.String({ description: "What the squad should accomplish" }),
			agents: Type.Optional(
				Type.Record(
					Type.String(),
					Type.Object({
						model: Type.Optional(Type.String()),
					}),
					{ description: "Agent roster with optional model overrides. Keys must match agent names in .pi/squad/agents/" },
				),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.String(),
						description: Type.Optional(Type.String()),
						agent: Type.String(),
						depends: Type.Optional(Type.Array(Type.String())),
					}),
					{ description: "Pre-defined task breakdown. If provided, skips the planner agent." },
				),
			),
			config: Type.Optional(
				Type.Object({
					maxConcurrency: Type.Optional(Type.Number({ description: "Max parallel agents (default: 2)" })),
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!uiCtx) uiCtx = ctx;

			if (activeScheduler) {
				return {
					content: [
						{
							type: "text" as const,
							text: `A squad is already running (${activeSquadId}). Use squad_status to check progress, or squad_modify to cancel it.`,
						},
					],
				};
			}

			const squadId = store.makeTaskId(params.goal);
			if (store.squadExists(squadId)) {
				// Append timestamp to make unique
				const uniqueId = `${squadId}-${Date.now().toString(36)}`;
				return await startSquad(uniqueId, params, ctx.cwd, squadSkillPaths, pi);
			}

			return await startSquad(squadId, params, ctx.cwd, squadSkillPaths, pi);
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
				return { content: [{ type: "text" as const, text: "No squads found. Use the squad tool to start one." }] };
			}

			// If scheduler is running, force a context refresh
			if (activeScheduler && activeSquadId === id) {
				activeScheduler.updateContext();
			}

			const context = store.loadContext(id);
			if (!context) {
				return { content: [{ type: "text" as const, text: `Squad '${id}' not found or has no context yet.` }] };
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

			return { content: [{ type: "text" as const, text: summary }] };
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
			if (!activeScheduler || !activeSquadId) {
				return { content: [{ type: "text" as const, text: "No active squad." }] };
			}

			let taskId = params.taskId;

			// If agent specified but no taskId, find their current task
			if (!taskId && params.agent) {
				taskId = activeScheduler.getPool().getTaskIdForAgent(params.agent) || undefined;
			}

			if (!taskId) {
				return { content: [{ type: "text" as const, text: "Could not determine target task. Provide taskId or an agent name that is currently running." }] };
			}

			const sent = await activeScheduler.sendHumanMessage(taskId, params.message);
			const status = sent ? "delivered" : "queued for when the agent starts";

			return { content: [{ type: "text" as const, text: `Message ${status}: "${params.message}"` }] };
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
				}),
				{ description: "Task definition for add_task" },
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!activeScheduler || !activeSquadId) {
				return { content: [{ type: "text" as const, text: "No active squad." }] };
			}

			switch (params.action) {
				case "add_task": {
					if (!params.task) {
						return { content: [{ type: "text" as const, text: "Provide a task definition for add_task." }] };
					}
					const task: Task = {
						id: params.task.id,
						title: params.task.title,
						description: params.task.description || "",
						agent: params.task.agent,
						status: "pending",
						depends: params.task.depends || [],
						created: store.now(),
						started: null,
						completed: null,
						output: null,
						error: null,
						usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
					};
					store.createTask(activeSquadId, task);
					activeScheduler.updateContext();
					return { content: [{ type: "text" as const, text: `Task '${task.id}' added.` }] };
				}

				case "cancel_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }] };
					await activeScheduler.cancelTask(params.taskId);
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' cancelled.` }] };
				}

				case "pause_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }] };
					await activeScheduler.pauseTask(params.taskId);
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' paused.` }] };
				}

				case "resume_task": {
					if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }] };
					await activeScheduler.resumeTask(params.taskId);
					return { content: [{ type: "text" as const, text: `Task '${params.taskId}' resumed.` }] };
				}

				case "pause": {
					const squad = store.loadSquad(activeSquadId);
					if (squad) {
						squad.status = "paused";
						store.saveSquad(squad);
					}
					await activeScheduler.stop();
					return { content: [{ type: "text" as const, text: "Squad paused. Use squad_modify with action 'resume' to continue." }] };
				}

				case "resume": {
					await activeScheduler.resume();
					return { content: [{ type: "text" as const, text: "Squad resumed." }] };
				}

				case "cancel": {
					await activeScheduler.stop();
					const squad = store.loadSquad(activeSquadId);
					if (squad) {
						squad.status = "failed";
						store.saveSquad(squad);
					}
					activeScheduler = null;
					activeSquadId = null;
					return { content: [{ type: "text" as const, text: "Squad cancelled." }] };
				}

				default:
					return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }] };
			}
		},
	});

	// =========================================================================
	// Session Lifecycle
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		// Check for active squads for this project
		const active = store.findActiveSquads()
			.filter((s) => s.cwd === ctx.cwd);
		if (active.length > 0) {
			const squad = active[0];
			pi.sendUserMessage(
				`[squad] Found suspended squad "${squad.id}" (${squad.goal}). ` +
				`Use squad_modify with action "resume" to continue, or start a new squad.`,
				{ deliverAs: "followUp" },
			);
		}

		// Register Ctrl+Q terminal input handler for panel toggle
		if (ctx.hasUI) {
			ctx.ui.onTerminalInput((data) => {
				if (data === "\x11") {
					if (!activePanel) {
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
							const sched = activeScheduler || new Scheduler(activeSquadId, squadSkillPaths);
							createPanel(ctx, sched, activeSquadId);
						}
					} else {
						activePanel.toggleFocus();
					}
					return { consume: true };
				}
				return undefined;
			});
		}
	});

	pi.on("session_shutdown", async () => {
		clearWidgetRefresh();
		if (activePanel) {
			activePanel.dispose();
			activePanel = null;
		}
		if (activeScheduler) {
			await activeScheduler.stop();
			activeScheduler = null;
			activeSquadId = null;
		}
		uiCtx = null;
	});

	// =========================================================================
	// Slash Commands
	// =========================================================================

	pi.registerCommand("squad", {
		description: "Browse, select, and manage squads. Usage: /squad [list|all|select|msg|widget|panel|cancel|clear]",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "list", label: "list", description: "List squads for current project" },
				{ value: "all", label: "all", description: "List all squads, select to activate" },
				{ value: "select", label: "select", description: "Pick a squad to view (interactive)" },
				{ value: "msg", label: "msg", description: "Send message to agent: /squad msg [agent] text" },
				{ value: "widget", label: "widget", description: "Toggle live widget" },
				{ value: "panel", label: "panel", description: "Toggle overlay panel" },
				{ value: "cancel", label: "cancel", description: "Cancel running squad" },
				{ value: "clear", label: "clear", description: "Dismiss widget and deactivate squad" },
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
					if (!widgetEnabled) {
						widgetEnabled = true;
						// If no active squad, try to pick one
						if (!activeSquadId) {
							const latest = store.findLatestSquad(ctx.cwd);
							if (latest) activateSquadView(latest.id, ctx);
						}
						updateWidget();
						ctx.ui.notify("Squad widget enabled", "info");
					} else {
						widgetEnabled = false;
						ctx.ui.setWidget("squad-tasks", undefined);
						ctx.ui.setStatus("squad", undefined);
						ctx.ui.notify("Squad widget disabled", "info");
					}
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
					if (!activePanel && activeSquadId) {
						// Panel needs a scheduler — create a dummy one for view-only if none running
						const sched = activeScheduler || new Scheduler(activeSquadId, squadSkillPaths);
						createPanel(ctx, sched, activeSquadId);
					} else if (activePanel) {
						activePanel.toggleFocus();
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

					if (activeScheduler) {
						await activeScheduler.sendHumanMessage(targetTaskId, msgText);
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
					updateWidget();
					return;
				}

				case "cancel": {
					if (!activeScheduler) {
						ctx.ui.notify("No running squad to cancel", "info");
						return;
					}
					await activeScheduler.stop();
					const squad = store.loadSquad(activeSquadId!);
					if (squad) { squad.status = "failed"; store.saveSquad(squad); }
					activeScheduler = null;
					clearWidgetRefresh();
					updateWidget();
					ctx.ui.notify("Squad cancelled", "info");
					return;
				}

				case "clear": {
					activeSquadId = null;
					activeScheduler = null;
					clearWidgetRefresh();
					if (activePanel) { activePanel.dispose(); activePanel = null; }
					ctx.ui.setWidget("squad-tasks", undefined);
					ctx.ui.setStatus("squad", undefined);
					ctx.ui.notify("Squad view cleared", "info");
					return;
				}

				default:
					// Treat as a squad ID — try to activate it directly
					const direct = store.loadSquad(sub);
					if (direct) {
						activateSquadView(direct.id, ctx);
						return;
					}
					ctx.ui.notify(`Unknown: /squad ${sub}. Try: list, all, select, widget, panel, cancel, clear`, "warning");
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
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext | import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
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
function activateSquadView(squadId: string, ctx: import("@mariozechner/pi-coding-agent").ExtensionContext | import("@mariozechner/pi-coding-agent").ExtensionCommandContext): void {
	const squad = store.loadSquad(squadId);
	if (!squad) {
		ctx.ui.notify(`Squad '${squadId}' not found`, "error");
		return;
	}

	activeSquadId = squadId;

	// Show widget for this squad
	widgetEnabled = true;
	updateWidget();

	// Start refresh if squad is still running (live updates from disk)
	if (squad.status === "running" || squad.status === "paused") {
		startWidgetRefresh();
	}

	const tasks = store.loadAllTasks(squadId);
	const done = tasks.filter((t) => t.status === "done").length;
	const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
	const project = squad.cwd.split("/").pop();

	const taskLines = tasks.map((t) => {
		const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "⏳" : t.status === "failed" ? "✗" : t.status === "blocked" ? "◻" : "·";
		return `  ${icon} ${t.id} (${t.agent}) [${t.status}]`;
	}).join("\n");

	ctx.ui.notify(
		`Viewing: ${squad.id} [${squad.status}]\n` +
		`Project: ${project}\n` +
		`Tasks: ${done}/${tasks.length} done · $${cost.toFixed(2)}\n` +
		taskLines,
		"info",
	);
}

// ============================================================================
// Widget — live task status above the editor
// ============================================================================

function updateWidget(): void {
	if (!uiCtx?.hasUI || !widgetEnabled || !activeSquadId) return;

	const tasks = store.loadAllTasks(activeSquadId);
	const squad = store.loadSquad(activeSquadId);
	if (!squad || tasks.length === 0) return;

	const th = uiCtx.ui.theme;

	// Build widget lines
	const lines: string[] = [];

	const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
	const doneCount = tasks.filter((t) => t.status === "done").length;
	const elapsed = Date.now() - new Date(squad.created).getTime();
	const elapsedStr = formatElapsedShort(elapsed);

	// Header line with shortcut hint
	const statusIcon = squad.status === "done" ? th.fg("success", "✓")
		: squad.status === "failed" ? th.fg("error", "✗")
		: th.fg("warning", "⏳");
	const hint = th.fg("dim", "ctrl+q panel · /squad");
	lines.push(
		`${statusIcon} ${th.fg("accent", "squad")} ${th.fg("dim", squad.goal.slice(0, 30))} ` +
		`${th.fg("muted", `${doneCount}/${tasks.length}`)} ` +
		`${th.fg("dim", `$${totalCost.toFixed(2)}`)} ` +
		`${th.fg("dim", elapsedStr)} ` +
		`${hint}`
	);

	// Task lines
	for (const task of tasks) {
		const icon = task.status === "done" ? th.fg("success", "✓")
			: task.status === "in_progress" ? th.fg("warning", "⏳")
			: task.status === "failed" ? th.fg("error", "✗")
			: task.status === "blocked" ? th.fg("muted", "◻")
			: th.fg("dim", "·");

		let line = `  ${icon} ${th.fg("muted", task.id)} ${th.fg("dim", `(${task.agent})`)}`;

		// Show live activity for in_progress tasks
		if (task.status === "in_progress") {
			const messages = store.loadMessages(activeSquadId, task.id);
			const lastTool = [...messages].reverse().find((m) => m.type === "tool");
			const lastText = [...messages].reverse().find((m) => m.type === "text" && m.from !== "system");
			if (lastTool) {
				const toolPreview = lastTool.name || lastTool.text;
				const argPreview = lastTool.args?.path || lastTool.args?.command || "";
				const preview = argPreview ? `${toolPreview} ${argPreview}` : toolPreview;
				line += ` ${th.fg("dim", "→ " + preview.slice(0, 40))}`;
			} else if (lastText) {
				line += ` ${th.fg("dim", lastText.text.split("\n")[0].slice(0, 40))}`;
			}
		} else if (task.status === "done" && task.output) {
			line += ` ${th.fg("dim", task.output.split("\n")[0].slice(0, 40))}`;
		} else if (task.status === "failed" && task.error) {
			line += ` ${th.fg("error", task.error.slice(0, 40))}`;
		} else if (task.status === "blocked") {
			const blockers = task.depends.filter((d) => {
				const dep = tasks.find((t) => t.id === d);
				return dep && dep.status !== "done";
			});
			if (blockers.length > 0) {
				line += ` ${th.fg("dim", "← " + blockers.join(", "))}`;
			}
		}

		lines.push(line);
	}

	uiCtx.ui.setWidget("squad-tasks", lines);

	// Footer status
	const statusText = squad.status === "done"
		? th.fg("success", `✓ squad ${doneCount}/${tasks.length}`)
		: squad.status === "failed"
		? th.fg("error", `✗ squad ${doneCount}/${tasks.length}`)
		: th.fg("accent", `⏳ squad ${doneCount}/${tasks.length} $${totalCost.toFixed(2)}`);
	uiCtx.ui.setStatus("squad", statusText);
}

function clearWidget(): void {
	if (uiCtx?.hasUI) {
		uiCtx.ui.setWidget("squad-tasks", undefined);
		uiCtx.ui.setStatus("squad", undefined);
	}
}

function startWidgetRefresh(): void {
	if (widgetInterval) return;
	updateWidget();
	widgetInterval = setInterval(() => updateWidget(), 2000);
}

function clearWidgetRefresh(): void {
	if (widgetInterval) {
		clearInterval(widgetInterval);
		widgetInterval = null;
	}
}

function formatElapsedShort(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h${m % 60}m`;
	if (m > 0) return `${m}m${s % 60}s`;
	return `${s}s`;
}

/** Shared widget-enabled flag — declared in the extension body, referenced here */
let widgetEnabled = true;

// ============================================================================
// Panel Creation
// ============================================================================

function createPanel(
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
	scheduler: Scheduler,
	squadId: string,
): void {
	// Fire and forget — never awaited. The custom() Promise resolves when done() is called,
	// but we never call done() because the panel is persistent.
	ctx.ui.custom(
		(tui, theme, _kb, _done) => {
			const panel = new SquadPanel(tui, theme, scheduler, squadId);
			activePanel = panel;

			// Wire up message sending from panel
			panel.onSendMessage = async (taskId: string, _prefill: string) => {
				// Temporarily release panel focus so input dialog works
				(panel as any).handle?.unfocus();
				const task = store.loadTask(squadId, taskId);
				const agentName = task?.agent || taskId;
				const input = await ctx.ui.input(`Message to ${agentName}`, "Type your message...");
				if (input && activeScheduler) {
					await activeScheduler.sendHumanMessage(taskId, input);
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
				// Re-focus panel after input
				(panel as any).handle?.focus();
				tui.requestRender();
			};

			return panel;
		},
		{
			overlay: true,
			overlayOptions: () => {
				const wide = (process.stdout.columns || 80) >= 160;
				if (wide) {
					return {
						anchor: "top-right" as const,
						width: "35%" as const,
						maxHeight: "100%" as const,
						margin: { top: 0, right: 0, bottom: 1, left: 0 },
					};
				}
				return {
					anchor: "center" as const,
					width: "90%" as const,
					maxHeight: "85%" as const,
				};
			},
			onHandle: (handle) => {
				if (activePanel) {
					(activePanel as any).handle = handle;
				}
			},
		},
	);
}

// ============================================================================
// Start Squad
// ============================================================================

async function startSquad(
	squadId: string,
	params: {
		goal: string;
		agents?: Record<string, { model?: string }>;
		tasks?: Array<{
			id: string;
			title: string;
			description?: string;
			agent: string;
			depends?: string[];
		}>;
		config?: { maxConcurrency?: number };
	},
	cwd: string,
	skillPaths: string[],
	pi: ExtensionAPI,
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
	} else {
		// Run planner to generate task breakdown
		try {
			plan = await runPlanner({ goal: params.goal, cwd });
		} catch (error) {
			return {
				content: [
					{ type: "text" as const, text: `Failed to plan: ${(error as Error).message}` },
				],
				isError: true,
			};
		}
	}

	// Merge agent roster
	const agents: Record<string, { model?: string }> = { ...plan.agents };
	if (params.agents) {
		for (const [name, entry] of Object.entries(params.agents)) {
			agents[name] = { ...agents[name], ...entry };
		}
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
			created: store.now(),
			started: null,
			completed: null,
			output: null,
			error: null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		};

		// Mark tasks with unmet deps as blocked
		if (task.depends.length > 0) {
			const allDepsMet = task.depends.every((depId) =>
				plan.tasks.some((t) => t.id === depId),
			);
			if (!allDepsMet) {
				task.status = "pending"; // deps reference external tasks, treat as ready
			}
		}

		store.createTask(squadId, task);
	}

	// Start scheduler
	const scheduler = new Scheduler(squadId, skillPaths);
	activeScheduler = scheduler;
	activeSquadId = squadId;

	// Start live widget updates
	startWidgetRefresh();

	// Wire up completion/escalation notifications to main agent
	scheduler.onEvent((event: SchedulerEvent) => {
		// Update widget on every scheduler event
		updateWidget();
		switch (event.type) {
			case "squad_completed": {
				const tasks = store.loadAllTasks(squadId);
				const summary = tasks
					.filter((t) => t.status === "done")
					.map((t) => `- ${t.id} (${t.agent}): ${t.output?.slice(0, 150) || "done"}`)
					.join("\n");
				const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

				// Final context update before clearing scheduler
				if (activeScheduler) {
					activeScheduler.updateContext();
				}

				pi.sendUserMessage(
					`[squad] Squad "${squadId}" completed all ${tasks.length} tasks.\n\n` +
					`Summary:\n${summary}\n\n` +
					`Total cost: $${totalCost.toFixed(4)}`,
					{ deliverAs: "followUp" },
				);

				// Clear scheduler but keep activeSquadId so squad_status still works
				activeScheduler = null;
				clearWidgetRefresh();
				updateWidget(); // Final update showing done state
				break;
			}

			case "squad_failed": {
				const tasks = store.loadAllTasks(squadId);
				const failed = tasks.filter((t) => t.status === "failed");
				const done = tasks.filter((t) => t.status === "done");

				pi.sendUserMessage(
					`[squad] Squad "${squadId}" has stalled. ` +
					`${done.length}/${tasks.length} tasks done, ${failed.length} failed.\n` +
					`Failed: ${failed.map((t) => `${t.id}: ${t.error?.slice(0, 100)}`).join("; ")}\n` +
					`Use squad_status for details or squad_modify to adjust.`,
					{ deliverAs: "followUp" },
				);
				clearWidgetRefresh();
				updateWidget();
				break;
			}

			case "escalation": {
				pi.sendUserMessage(
					`[squad] Agent '${event.agentName}' on task '${event.taskId}' needs attention:\n` +
					`${event.message}\n\n` +
					`Reply to me and I'll forward your answer, or use the squad panel.`,
					{ deliverAs: "followUp" },
				);
				break;
			}
		}
	});

	// Start scheduling
	await scheduler.start();

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
				text: `Squad "${squadId}" started with ${plan.tasks.length} tasks.\n\n${taskSummary}\n\nAgents are working in the background. Use squad_status to check progress.`,
			},
		],
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
