import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupSquadWidget } from "./panel/squad-widget.js";
import { activateSquadView, openPanel, pickSquad } from "./panel-runtime.js";
import { cancelExactSquad, ensureScheduler, reviveScheduler } from "./scheduler-runtime.js";
import * as store from "./store.js";
import type { Squad } from "./types.js";
import { THINKING_LEVELS } from "./types.js";
import { DISABLED_GUIDANCE, focusSquad, forceWidgetUpdate, formatTaskProgress, getActiveScheduler, getMainSessionModel, resolveResumeSquad, runtime } from "./runtime.js";

export function registerCommands(pi: ExtensionAPI, squadSkillPaths: string[]): void {
// =========================================================================
// Slash Commands
// =========================================================================

pi.registerCommand("squad", {
	description: "Browse, select, and manage squads. Usage: /squad [list|all|select|resume|agents|msg|widget|panel|cancel|clear]",
	getArgumentCompletions: (prefix) => {
		const subs = [
			{ value: "list", label: "list", description: "List squads for current project" },
			{ value: "all", label: "all", description: "List all squads, select to activate" },
			{ value: "select", label: "select", description: "Pick a squad to view (interactive)" },
			{ value: "resume", label: "resume", description: "Resume an exact paused/failed/failed-review squad" },
			{ value: "agents", label: "agents", description: "List, view, or edit agent definitions" },
			{ value: "defaults", label: "defaults", description: "Default model/thinking for agents (follow main session, pi default, or fixed)" },
			{ value: "advisor", label: "advisor", description: "Advisor-first rescue for stuck agents (on/off, model, limits)" },
			{ value: "msg", label: "msg", description: "Message a task: /squad msg [task-id|running-agent] text" },
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
		const requested = args.trim();
		if (!runtime.squadEnabled && requested !== "enable" && requested !== "disable") {
			ctx.ui.notify(DISABLED_GUIDANCE, "warning");
			return;
		}
		const parts = requested.split(/\s+/);
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

			case "resume": {
				const squad = resolveResumeSquad(ctx.cwd, parts[1]);
				if (!squad) {
					ctx.ui.notify(parts[1] ? `Squad '${parts[1]}' not found` : "No paused, failed, or failed-review squad found", "warning");
					return;
				}
				const scheduler = ensureScheduler(pi, squad.id, squadSkillPaths);
				try {
					await scheduler.resume();
				} catch (error) {
					ctx.ui.notify(`Resume failed: ${(error as Error).message}`, "error");
					return;
				}
				const tasks = store.loadAllTasks(squad.id);
				ctx.ui.notify(`Resumed: ${squad.id} (${formatTaskProgress(tasks)})`, "info");
				return;
			}

			case "widget": {
				runtime.widgetState.enabled = !runtime.widgetState.enabled;
				if (runtime.widgetState.enabled) {
					if (!runtime.activeSquadId) {
						const latest = store.findLatestSquad(ctx.cwd);
						if (latest) activateSquadView(latest.id, ctx);
					}
				}
				// requestUpdate handles both enable (renders) and disable (clears)
				runtime.widgetControls?.requestUpdate();
				ctx.ui.notify(`Squad widget ${runtime.widgetState.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			case "panel": {
				// Activate latest squad if none active
				if (!runtime.activeSquadId) {
					const latest = store.findLatestSquad(ctx.cwd);
					if (latest) {
						activateSquadView(latest.id, ctx);
					} else {
						ctx.ui.notify("No squads found", "info");
						return;
					}
				}
				if (runtime.activeSquadId) {
					const sched = reviveScheduler(pi, runtime.activeSquadId, squadSkillPaths);
					openPanel(pi, ctx, sched, runtime.activeSquadId, squadSkillPaths);
				}
				return;
			}

			case "msg": {
				if (!runtime.activeSquadId) {
					ctx.ui.notify("No active squad. Use /squad select first.", "info");
					return;
				}
				const msgSquad = store.loadSquad(runtime.activeSquadId);
				if (!msgSquad) return;
				// Parse: /squad msg [task-id|running-agent] message text
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

				// Find one exact target task. A task ID can address completed or
				// stopped work; an agent name remains shorthand for a live task only.
				const msgTasks = store.loadAllTasks(runtime.activeSquadId);
				let targetTaskId: string | undefined;
				const explicitTask = msgParts.length > 1
					? msgTasks.find((task) => task.id === msgParts[0])
					: undefined;
				if (explicitTask) {
					targetTaskId = explicitTask.id;
					targetAgent = explicitTask.agent;
					msgText = msgParts.slice(1).join(" ");
				} else if (targetAgent) {
					const liveMatches = msgTasks.filter(
						(task) => task.agent === targetAgent && getActiveScheduler()?.getPool().isRunning(task.id),
					);
					if (liveMatches.length === 1) targetTaskId = liveMatches[0].id;
					if (!targetTaskId) {
						ctx.ui.notify(`Agent '${targetAgent}' is not working on exactly one live task; provide an exact task ID`, "warning");
						return;
					}
				} else {
					const liveTasks = msgTasks.filter((task) =>
						getActiveScheduler()?.getPool().isRunning(task.id),
					);
					if (liveTasks.length === 1) {
						targetTaskId = liveTasks[0].id;
						targetAgent = liveTasks[0].agent;
					} else {
						ctx.ui.notify("No unique live task to message; provide an exact task ID", "warning");
						return;
					}
				}

				let msgSched = getActiveScheduler();
				if (!msgSched) {
					msgSched = reviveScheduler(pi, runtime.activeSquadId, squadSkillPaths);
					await msgSched.start();
				}
				const delivered = await msgSched.sendHumanMessage(targetTaskId, msgText);
				ctx.ui.notify(
					delivered ? `Sent to ${targetAgent}: "${msgText}"` : `Queued durably for ${targetTaskId}`,
					"info",
				);
				forceWidgetUpdate();
				return;
			}

			case "cancel": {
				const cancelledId = runtime.activeSquadId;
				if (!cancelledId) {
					ctx.ui.notify("No focused squad to cancel", "info");
					return;
				}
				await cancelExactSquad(cancelledId, squadSkillPaths);
				ctx.ui.notify(`Squad '${cancelledId}' cancelled`, "info");
				return;
			}

			case "clear": {
				if (runtime.activeSquadId) runtime.schedulers.delete(runtime.activeSquadId);
				focusSquad(null);
				runtime.widgetControls?.dispose();
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
					// Stop any running runtime.schedulers first
					for (const [id, sched] of runtime.schedulers) {
						await sched.stop();
					}
					runtime.schedulers.clear();
					focusSquad(null);

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
						const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
						const icon = s.status === "done" ? "✓" : s.status === "running" ? "⏳" : s.status === "review" ? "◆" : s.status === "failed" ? "✗" : "·";
						return `${icon} ${s.id} [${s.status}] ${formatTaskProgress(tasks)} $${cost.toFixed(2)}`;
					}),
				];

				const choice = await ctx.ui.select("Delete squad data", options);
				if (!choice) return;

				if (choice.startsWith("🗑")) {
					// Delete all
					for (const [id, sched] of runtime.schedulers) {
						await sched.stop();
					}
					runtime.schedulers.clear();
					focusSquad(null);
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
						const sched = runtime.schedulers.get(squad.id);
						if (sched) {
							await sched.stop();
							runtime.schedulers.delete(squad.id);
						}
						if (runtime.activeSquadId === squad.id) focusSquad(null);
						fs.rmSync(store.getSquadDir(squad.id), { recursive: true, force: true });
						ctx.ui.notify(`Deleted: ${squad.id}`, "info");
					}
				}
				return;
			}

			case "enable": {
				const wasEnabled = runtime.squadEnabled;
				try {
					const settings = store.loadSquadSettings();
					settings.enabled = true;
					store.saveSquadSettings(settings);
				} catch (error) {
					ctx.ui.notify(`Could not enable pi-squad: ${(error as Error).message}`, "error");
					return;
				}
				runtime.squadEnabled = true;
				runtime.widgetState.enabled = true;
				if (!wasEnabled) runtime.widgetState.squadId = null;
				if (!runtime.widgetControls && runtime.uiCtx?.hasUI) runtime.widgetControls = setupSquadWidget(runtime.uiCtx, runtime.widgetState);
				runtime.widgetControls?.requestUpdate();
				ctx.ui.notify("pi-squad enabled. No suspended work was resumed; use /squad select and an explicit /squad resume <id> or exact resume_task if needed.", "info");
				return;
			}

			case "disable": {
				if (!runtime.squadEnabled) {
					ctx.ui.notify("pi-squad is already disabled. Run /squad enable to use squad operations.", "info");
					return;
				}
				try {
					const settings = store.loadSquadSettings();
					settings.enabled = false;
					store.saveSquadSettings(settings);
				} catch (error) {
					ctx.ui.notify(`Could not disable pi-squad: ${(error as Error).message}`, "error");
					return;
				}
				// The persisted state is authoritative before shutdown begins.
				runtime.squadEnabled = false;
				runtime.closeOverlay?.();
				for (const sched of runtime.schedulers.values()) await sched.stop();
				runtime.schedulers.clear();
				runtime.widgetState.enabled = false;
				runtime.widgetState.squadId = null;
				focusSquad(null);
				runtime.widgetControls?.dispose();
				runtime.widgetControls = null;
				ctx.ui.notify("pi-squad disabled. Running work was durably suspended; run /squad enable before any squad operation.", "info");
				return;
			}

			case "defaults": {
				const settings = store.loadSquadSettings();
				const mainModel = getMainSessionModel() || "(unknown)";
				const mainThinking = runtime.getMainSessionThinking() || "(unknown)";
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
							agent.prompt,
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
				ctx.ui.notify(`Unknown: /squad ${sub}. Try: list, all, select, resume, agents, defaults, msg, widget, panel, cancel, clear, cleanup`, "warning");
		}
	},
});
}
