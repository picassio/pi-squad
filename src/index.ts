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
let uiCtx: import("@mariozechner/pi-coding-agent").ExtensionContext | null = null;
/** Component-based widget state + controls */
const widgetState: SquadWidgetState = { squadId: null, enabled: true };
let widgetControls: { requestUpdate: () => void; dispose: () => void } | null = null;

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
	pi.on("before_agent_start", async (event, _ctx) => {
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

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!squadEnabled) return { content: [{ type: "text" as const, text: "Squad is disabled. Use /squad enable to re-enable." }] };
			if (!uiCtx) uiCtx = ctx;

			// Check if the user cancelled before we start
			if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled." }] };

			// Multiple squads can run concurrently — no guard needed

			const squadId = store.makeTaskId(params.goal);
			if (store.squadExists(squadId)) {
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
			const sched = schedulers.get(id!);
				if (sched) sched.updateContext();

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
			const activeScheduler = getActiveScheduler();
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

			const sent = await activeScheduler!.sendHumanMessage(taskId, params.message);
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Resume can work without an active scheduler — it recreates one from disk
			if (params.action === "resume") {
				// Find a squad to resume: use activeSquadId or find the latest paused one
				const squadId = activeSquadId || store.findActiveSquads()
					.filter((s) => s.cwd === ctx.cwd && s.status === "paused")
					.sort((a, b) => b.created.localeCompare(a.created))[0]?.id;

				if (!squadId) {
					return { content: [{ type: "text" as const, text: "No paused squad found to resume." }] };
				}

				// Create a fresh scheduler if needed
				if (!schedulers.has(squadId)) {
					const scheduler = new Scheduler(squadId, squadSkillPaths);
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
								const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
								const s = schedulers.get(squadId); if (s) s.updateContext();
								const overview = store.loadOverview(squadId);
								pi.sendMessage({
									customType: "squad-completed",
									content: `[squad] Squad "${squadId}" completed all ${tasks.length} tasks.\n\n` +
										(overview ? `## Squad Overview\n\n${overview}\n\n` : "") +
										`Total cost: $${totalCost.toFixed(4)}`,
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
								const overview = store.loadOverview(squadId);
								pi.sendMessage({
									customType: "squad-failed",
									content: `[squad] Squad "${squadId}" has stalled. ${done.length}/${tasks.length} done, ${failed.length} failed.\n` +
										`Failed: ${failed.map((t) => `${t.id}: ${t.error?.slice(0, 100)}`).join("; ")}` +
										(overview ? `\n\n## Squad Overview\n\n${overview}` : ""),
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
				return { content: [{ type: "text" as const, text: `Squad "${squadId}" resumed (${done}/${tasks.length} done). Agents restarting in background.` }] };
			}

			if (!activeScheduler || !activeSquadId) {
				return { content: [{ type: "text" as const, text: "No active squad. Use squad_modify with action 'resume' to resume a paused squad, or start a new one with the squad tool." }] };
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
					activeScheduler.resumeTask(params.taskId).catch((err) => {
						logError("squad", `Resume task error: ${(err as Error).message}`);
					});
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
					// Handled above (before the activeScheduler guard)
					return { content: [{ type: "text" as const, text: "Squad resumed." }] };
				}

				case "cancel": {
					await activeScheduler.stop();
					const squad = store.loadSquad(activeSquadId);
					if (squad) {
						squad.status = "failed";
						store.saveSquad(squad);
					}
					schedulers.delete(activeSquadId);
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
						openPanel(ctx, schedulers.get(activeSquadId) || new Scheduler(activeSquadId, squadSkillPaths), activeSquadId);
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
						const sched = schedulers.get(activeSquadId) || new Scheduler(activeSquadId, squadSkillPaths);
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
							const model = a.model ? ` [${a.model}]` : " [default]";
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
	ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
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

	// Create initial OVERVIEW.md with squad goal, task plan, and design contract
	const planLines = [
		`# Squad: ${params.goal}`,
		``,
		`**Created:** ${squad.created}`,
		`**Tasks:** ${plan.tasks.length}`,
		``,
		`## Task Plan`,
		``,
		...plan.tasks.map((t) => {
			const deps = t.depends.length > 0 ? ` (after: ${t.depends.join(", ")})` : "";
			return `- **${t.id}** → ${t.agent}: ${t.title}${deps}`;
		}),
		``,
	];

	// Extract design contract from task descriptions — API paths, schemas,
	// ports, file conventions — so parallel agents share a single source of truth.
	const contractLines = buildDesignContract(plan.tasks, params.goal);
	if (contractLines.length > 0) {
		planLines.push(...contractLines);
	}

	store.appendOverview(squadId, planLines.join("\n"));

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
				const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

				// Final context update before clearing scheduler
				const completedSched = schedulers.get(squadId);
				if (completedSched) {
					completedSched.updateContext();
				}

				// Load the full overview document — contains the narrative of
				// each task's output, decisions, issues, and files modified.
				const overview = store.loadOverview(squadId);

				// Send into LLM context (not display-only) so the main agent
				// knows exactly what happened. No triggerTurn — user decides
				// what to do next.
				pi.sendMessage({
					customType: "squad-completed",
					content: `[squad] Squad "${squadId}" completed all ${tasks.length} tasks.\n\n` +
						(overview ? `## Squad Overview\n\n${overview}\n\n` : "") +
						`Total cost: $${totalCost.toFixed(4)}`,
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
				const overview = store.loadOverview(squadId);

				pi.sendMessage({
					customType: "squad-failed",
					content: `[squad] Squad "${squadId}" has stalled. ` +
						`${done.length}/${tasks.length} tasks done, ${failed.length} failed.\n` +
						`Failed: ${failed.map((t) => `${t.id}: ${t.error?.slice(0, 100)}`).join("; ")}\n` +
						(overview ? `\n## Squad Overview\n\n${overview}\n\n` : "\n") +
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

/**
 * Extract a design contract from task descriptions.
 *
 * Scans all tasks for API paths, ports, file names, data schemas, and
 * shared conventions. Produces a "## Design Contract" section in the
 * OVERVIEW.md so that ALL agents (including parallel ones) share a
 * single source of truth before they start working.
 */
function buildDesignContract(
	tasks: Array<{ id: string; title: string; description: string; agent: string; depends: string[] }>,
	goal: string,
): string[] {
	const lines: string[] = [];

	// Collect API routes mentioned in any task description
	const apiRoutes: string[] = [];
	const ports: string[] = [];
	const files: string[] = [];
	const schemas: string[] = [];

	const allText = tasks.map((t) => `${t.title}\n${t.description}`).join("\n") + "\n" + goal;

	// Extract API paths like GET /foo, POST /bar/:id
	const routePattern = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[\w\/:]+)/gi;
	for (const match of allText.matchAll(routePattern)) {
		const route = `${match[1].toUpperCase()} ${match[2]}`;
		if (!apiRoutes.includes(route)) apiRoutes.push(route);
	}

	// Extract port numbers
	const portPattern = /\b(?:port|PORT|Port)\s*[=:]?\s*(\d{4,5})\b/gi;
	for (const match of allText.matchAll(portPattern)) {
		if (!ports.includes(match[1])) ports.push(match[1]);
	}

	// Extract key file names mentioned (e.g., server.js, index.html)
	const filePattern = /\b([\w-]+\.(js|ts|json|html|css|sh|mjs|cjs))\b/gi;
	for (const match of allText.matchAll(filePattern)) {
		const f = match[1];
		if (!files.includes(f) && !['package.json'].includes(f)) files.push(f);
	}

	// Extract data schemas like {field, field, field}
	const schemaPattern = /\{([a-zA-Z_][\w,\s\[\]?]+)\}/g;
	for (const match of allText.matchAll(schemaPattern)) {
		const fields = match[1].trim();
		if (fields.includes(',') && fields.length > 5 && fields.length < 200) {
			if (!schemas.includes(fields)) schemas.push(fields);
		}
	}

	// Only emit a contract section if we found shared design elements
	if (apiRoutes.length === 0 && ports.length === 0 && schemas.length === 0) {
		return [];
	}

	lines.push(`## Design Contract`);
	lines.push(``);
	lines.push(`> **All agents MUST follow these specifications.** Do not invent`);
	lines.push(`> alternative paths, ports, or schemas. If you need to deviate,`);
	lines.push(`> document the reason in your output.`);
	lines.push(``);

	if (ports.length > 0) {
		lines.push(`### Server`);
		lines.push(`- Port: **${ports.join(", ")}**`);
		lines.push(``);
	}

	if (apiRoutes.length > 0) {
		lines.push(`### API Endpoints`);
		for (const r of apiRoutes) {
			lines.push(`- \`${r}\``);
		}
		lines.push(``);
	}

	if (schemas.length > 0) {
		lines.push(`### Data Schemas`);
		for (const s of schemas) {
			lines.push(`- \`{ ${s} }\``);
		}
		lines.push(``);
	}

	if (files.length > 0) {
		lines.push(`### Key Files`);
		for (const f of files) {
			lines.push(`- \`${f}\``);
		}
		lines.push(``);
	}

	return lines;
}
