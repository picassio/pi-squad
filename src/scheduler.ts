/**
 * scheduler.ts — Dependency DAG resolution, concurrency control, task lifecycle.
 *
 * The scheduler is the core engine. It:
 * - Resolves which tasks are ready (all deps done)
 * - Spawns agents up to maxConcurrency
 * - Auto-unblocks dependents when tasks complete
 * - Kills agents when tasks become re-blocked
 * - Detects squad completion
 */

import type { AgentDef, Squad, SquadConfig, Task, TaskMessage, TaskStatus } from "./types.js";
import { AgentPool, type AgentEvent } from "./agent-pool.js";
import { Monitor } from "./monitor.js";
import { Router } from "./router.js";
import * as store from "./store.js";
import { debug, logError } from "./logger.js";
import { buildAgentSystemPrompt } from "./protocol.js";

// ============================================================================
// Types
// ============================================================================

export type SchedulerEventType =
	| "task_started"
	| "task_completed"
	| "task_failed"
	| "task_blocked"
	| "task_unblocked"
	| "task_rework"
	| "squad_completed"
	| "squad_failed"
	| "escalation"
	| "activity";

export interface SchedulerEvent {
	type: SchedulerEventType;
	squadId: string;
	taskId?: string;
	agentName?: string;
	message?: string;
	data?: any;
}

export type SchedulerEventListener = (event: SchedulerEvent) => void;

// ============================================================================
// Scheduler
// ============================================================================

export class Scheduler {
	private squadId: string;
	private pool: AgentPool;
	private monitor: Monitor;
	private router: Router;
	private listeners: SchedulerEventListener[] = [];
	private skillPaths: string[] = [];
	private running = false;
	/** Track spawn retries to allow one retry per task */
	private spawnRetries = new Set<string>();

	/** Get the project cwd for this squad (from squad.json) */
	getProjectCwd(): string | undefined {
		return store.loadSquad(this.squadId)?.cwd;
	}

	constructor(squadId: string, skillPaths: string[]) {
		this.squadId = squadId;
		this.skillPaths = skillPaths;
		this.pool = new AgentPool();
		this.monitor = new Monitor(this.pool, squadId);
		this.router = new Router(this.pool, squadId);

		// Wire up agent events
		this.pool.onEvent((event) => this.handleAgentEvent(event));

		// Wire up monitor events
		this.monitor.onAction((action) => {
			if (action.type === "steer") {
				this.pool.steer(action.taskId, action.message);
			} else if (action.type === "abort") {
				this.handleTaskFailed(action.taskId, action.reason);
			} else if (action.type === "escalate") {
				this.emit({
					type: "escalation",
					squadId: this.squadId,
					taskId: action.taskId,
					message: action.reason,
				});
			}
		});

		// Wire up router events
		this.router.onEscalation((taskId, agentName, message) => {
			this.emit({
				type: "escalation",
				squadId: this.squadId,
				taskId,
				agentName,
				message,
			});
		});
	}

	/** Subscribe to scheduler events */
	onEvent(listener: SchedulerEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx !== -1) this.listeners.splice(idx, 1);
		};
	}

	private emit(event: SchedulerEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* ignore */
			}
		}
	}

	/** Get references for external use */
	getPool(): AgentPool {
		return this.pool;
	}
	getRouter(): Router {
		return this.router;
	}
	getMonitor(): Monitor {
		return this.monitor;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/** Start the scheduler — begins scheduling ready tasks */
	async start(): Promise<void> {
		this.running = true;
		this.monitor.start();
		await this.scheduleReadyTasks();
	}

	/** Stop the scheduler — kills all agents, saves state */
	async stop(): Promise<void> {
		this.running = false;
		this.monitor.stop();

		// Suspend in-progress tasks
		const tasks = store.loadAllTasks(this.squadId);
		for (const task of tasks) {
			if (task.status === "in_progress") {
				store.updateTaskStatus(this.squadId, task.id, "suspended");
			}
		}

		await this.pool.killAll();
	}

	/** Resume from suspended state */
	async resume(): Promise<void> {
		const tasks = store.loadAllTasks(this.squadId);
		for (const task of tasks) {
			if (task.status === "suspended") {
				store.updateTaskStatus(this.squadId, task.id, "pending");
			}
		}

		const squad = store.loadSquad(this.squadId);
		if (squad && squad.status === "paused") {
			squad.status = "running";
			store.saveSquad(squad);
		}

		await this.start();
	}

	// =========================================================================
	// Task Scheduling
	// =========================================================================

	/** Find and spawn ready tasks up to concurrency limit */
	private async scheduleReadyTasks(): Promise<void> {
		if (!this.running) {
			debug("squad-scheduler", "scheduleReadyTasks: not running, skipping");
			return;
		}

		const squad = store.loadSquad(this.squadId);
		if (!squad || squad.status !== "running") {
			debug("squad-scheduler", `scheduleReadyTasks: squad status=${squad?.status}, skipping`);
			return;
		}

		const tasks = store.loadAllTasks(this.squadId);
		const runningCount = this.pool.getRunningAgents().length;
		const available = squad.config.maxConcurrency - runningCount;

		debug("squad-scheduler", `scheduleReadyTasks: ${tasks.length} tasks, ${runningCount} running, ${available} slots`);

		if (available <= 0) {
			debug("squad-scheduler", "scheduleReadyTasks: no available slots");
			return;
		}

		const ready = this.getReadyTasks(tasks);
		debug("squad-scheduler", `scheduleReadyTasks: ${ready.length} ready tasks: ${ready.map(t => t.id).join(", ")}`);
		const toSpawn = ready.slice(0, available);

		for (const task of toSpawn) {
			try {
				await this.spawnAgentForTask(task, squad);
			} catch (error) {
				logError("squad-scheduler", `Failed to spawn ${task.id}: ${(error as Error).message}`);
				// MUST fail the task — otherwise it stays in_progress forever
				// with no process (zombie state)
				this.handleTaskFailed(task.id, `Spawn failed: ${(error as Error).message}`);
			}
		}

		// Check if squad is complete
		this.checkSquadCompletion(tasks, squad);
	}

	/** Get tasks that are ready to execute (pending + all deps done) */
	private getReadyTasks(tasks: Task[]): Task[] {
		return tasks.filter((task) => {
			if (task.status !== "pending") return false;
			return task.depends.every((depId) => {
				const dep = tasks.find((t) => t.id === depId);
				return dep?.status === "done";
			});
		});
	}

	/** Spawn an agent for a task */
	private async spawnAgentForTask(task: Task, squad: Squad): Promise<void> {
		const agentDef = store.loadAgentDef(task.agent, squad.cwd);
		if (!agentDef) {
			this.handleTaskFailed(task.id, `Agent definition not found: ${task.agent}`);
			return;
		}

		if (agentDef.disabled) {
			this.handleTaskFailed(task.id, `Agent '${task.agent}' is disabled. Enable it with /squad agents or edit ${task.agent}.json`);
			return;
		}

		// Apply squad-level model override
		const squadAgentEntry = squad.agents[task.agent];
		if (squadAgentEntry?.model) {
			agentDef.model = squadAgentEntry.model;
		}

		// Build modified files map from all running agents
		const modifiedFiles: Record<string, string[]> = {};
		for (const name of this.pool.getRunningAgents()) {
			const runningTaskId = this.pool.getTaskIdForAgent(name);
			if (runningTaskId) {
				const activity = this.pool.getActivity(runningTaskId);
				if (activity) {
					modifiedFiles[name] = Array.from(activity.modifiedFiles);
				}
			}
		}

		// Update task status
		store.updateTaskStatus(this.squadId, task.id, "in_progress", {
			started: store.now(),
		});

		store.appendMessage(this.squadId, task.id, {
			ts: store.now(),
			from: "system",
			type: "status",
			text: `Agent ${task.agent} starting work`,
		});

		this.emit({
			type: "task_started",
			squadId: this.squadId,
			taskId: task.id,
			agentName: task.agent,
		});

		try {
			await this.pool.spawn({
				taskId: task.id,
				agentDef,
				protocolOptions: {
					squadId: this.squadId,
					squad,
					task,
					agentDef,
					modifiedFiles,
					queuedMessages: this.pool.consumeQueue(task.agent),
				},
				cwd: squad.cwd,
				skillPaths: this.skillPaths,
			});
		} catch (error) {
			this.handleTaskFailed(task.id, (error as Error).message);
		}

		this.updateContext();
	}

	// =========================================================================
	// Event Handlers
	// =========================================================================

	private handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_end": {
				const msg = event.data;
				if (msg?.role === "assistant") {
					// Extract text from assistant message
					const text = this.extractAssistantText(msg);
					if (text) {
						// Route @mentions
						this.router.processMessage(event.taskId, event.agentName, text);

						// Log message
						store.appendMessage(this.squadId, event.taskId, {
							ts: store.now(),
							from: event.agentName,
							type: "text",
							text: text.slice(0, 2000),
						});
					}

					// Track usage
					if (msg.usage) {
						store.updateTaskUsage(this.squadId, event.taskId, {
							inputTokens: msg.usage.input || 0,
							outputTokens: msg.usage.output || 0,
							cost: msg.usage.cost?.total || 0,
							turns: 1,
						});
					}
				}
				break;
			}

			case "tool_execution_start": {
				const data = event.data;
				store.appendMessage(this.squadId, event.taskId, {
					ts: store.now(),
					from: event.agentName,
					type: "tool",
					text: data.toolName || "unknown",
					name: data.toolName,
					args: data.args,
				});

				this.emit({
					type: "activity",
					squadId: this.squadId,
					taskId: event.taskId,
					agentName: event.agentName,
					message: `→ ${data.toolName}`,
					data,
				});
				break;
			}

			case "tool_execution_end": {
				// Track file modifications
				const data = event.data;
				if (data.toolName === "write" || data.toolName === "edit") {
					const filePath = data.args?.path || data.args?.file_path;
					if (filePath) {
						this.updateModifiedFiles(event.agentName, filePath);
					}
				}
				break;
			}

				case "agent_end": {
				const exitCode = event.data?.exitCode ?? 1;
				const turnCount = event.data?.turnCount ?? 0;
				const toolCallCount = event.data?.toolCallCount ?? 0;

				// Agent must have done real work: at least 1 turn AND at least 1 tool call.
				// An agent that exits cleanly but with 0 turns/tools did nothing —
				// likely hit a rate limit or API error. Treat as crash, not success.
				const hadMeaningfulWork = turnCount > 0 && toolCallCount > 0;
				if (hadMeaningfulWork) {
					this.handleTaskCompleted(event.taskId).then(() => this.updateContext());
				} else {
					// Agent exited without doing real work (0 turns or 0 tool calls).
					// Common causes: rate limit, API error, resource pressure, crash.
					// Retry once before failing.
					const retryKey = `spawn-retry:${event.taskId}`;
					if (!this.spawnRetries.has(retryKey)) {
						this.spawnRetries.add(retryKey);
						const stderr = event.data?.stderr || "";
						const reason = turnCount === 0
							? `exited with 0 turns (likely rate limit or API error)`
							: `exited with ${turnCount} turns but 0 tool calls (no work done)`;
						logError("squad-scheduler", `Agent ${event.agentName} ${reason}, code=${exitCode}. Retrying in 2s... stderr: ${stderr.slice(0, 200)}`);
						store.updateTaskStatus(this.squadId, event.taskId, "pending");
						store.appendMessage(this.squadId, event.taskId, {
							ts: store.now(),
							from: "system",
							type: "status",
							text: `Agent ${reason}. Retrying...`,
						});
						// Delay retry to let resources settle
						setTimeout(() => {
							if (this.running) this.scheduleReadyTasks();
						}, 2000);
					} else {
						const stderr = event.data?.stderr || "";
						this.handleTaskFailed(event.taskId, `Agent exited with code ${exitCode} (retry exhausted). ${stderr.slice(0, 500)}`);
					}
					this.updateContext();
				}
				// Skip the updateContext() below — handled in the branches above
				return;
			}

			case "error": {
				const errorMsg = event.data?.message || "Unknown error";
				store.appendMessage(this.squadId, event.taskId, {
					ts: store.now(),
					from: "system",
					type: "error",
					text: errorMsg,
				});
				break;
			}
		}

		this.updateContext();
	}

	private async handleTaskCompleted(taskId: string): Promise<void> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) return;

		// Guard against double-completion
		if (task.status === "done") return;

		// Extract output from last messages
		const messages = store.loadMessages(this.squadId, taskId);
		const lastAgentMessages = messages
			.filter((m) => m.from === task.agent && (m.type === "text" || m.type === "done"))
			.slice(-3);
		const output = lastAgentMessages.map((m) => m.text).join("\n");

		store.updateTaskStatus(this.squadId, taskId, "done", {
			output: output || "Task completed",
			completed: store.now(),
		});

		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "system",
			type: "done",
			text: "Task completed",
		});

		this.emit({
			type: "task_completed",
			squadId: this.squadId,
			taskId,
			agentName: task.agent,
			message: output,
		});

		// Check for QA rework: if this is a QA/test task and it found failures,
		// create a rework task for the original agent instead of proceeding
		const reworkCreated = this.checkForRework(task, output);

		if (!reworkCreated) {
			// Normal flow: auto-unblock dependents
			debug("squad-scheduler", `handleTaskCompleted: ${taskId} done, auto-unblocking dependents`);
			this.autoUnblock(taskId);

			// If this is a passing retest, also unblock dependents of the ORIGINAL
			// QA task. When qa-auth failed, its dependents weren't unblocked.
			// Now that the retest passes, those dependents should proceed.
			if (task.retryOf) {
				// Walk up the retry chain to find the root task
				let rootId = task.retryOf;
				const allTasks = store.loadAllTasks(this.squadId);
				let root = allTasks.find((t) => t.id === rootId);
				while (root?.retryOf) {
					rootId = root.retryOf;
					root = allTasks.find((t) => t.id === rootId);
				}
				debug("squad-scheduler", `Retest passed — also unblocking dependents of original: ${rootId}`);
				this.autoUnblock(rootId);
			}
		}

		// Schedule next ready tasks (may spawn new agents)
		debug("squad-scheduler", `handleTaskCompleted: scheduling next ready tasks`);
		await this.scheduleReadyTasks();

		// Re-check squad completion with fresh data AFTER scheduling
		const freshTasks = store.loadAllTasks(this.squadId);
		const freshSquad = store.loadSquad(this.squadId);
		debug("squad-scheduler", `handleTaskCompleted: final check — tasks: ${freshTasks.map(t => `${t.id}:${t.status}`).join(", ")}`);
		if (freshSquad) {
			this.checkSquadCompletion(freshTasks, freshSquad);
		}
	}

	private handleTaskFailed(taskId: string, error: string): void {
		store.updateTaskStatus(this.squadId, taskId, "failed", {
			error,
			completed: store.now(),
		});

		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "system",
			type: "error",
			text: error,
		});

		this.emit({
			type: "task_failed",
			squadId: this.squadId,
			taskId,
			message: error,
		});

		this.pool.kill(taskId);
		this.updateContext();

		// Check if squad should be marked failed
		const tasks = store.loadAllTasks(this.squadId);
		const squad = store.loadSquad(this.squadId);
		this.checkSquadCompletion(tasks, squad!);
	}

	/** Auto-unblock tasks that depend on the completed task */
	private autoUnblock(completedTaskId: string): void {
		const squad = store.loadSquad(this.squadId);
		if (!squad?.config.autoUnblock) return;

		const tasks = store.loadAllTasks(this.squadId);

		for (const task of tasks) {
			if (task.status !== "blocked" && task.status !== "pending") continue;
			if (!task.depends.includes(completedTaskId)) continue;

			const allDepsDone = task.depends.every((depId) => {
				const dep = tasks.find((t) => t.id === depId);
				return dep?.status === "done";
			});

			if (allDepsDone) {
				store.updateTaskStatus(this.squadId, task.id, "pending");

				store.appendMessage(this.squadId, task.id, {
					ts: store.now(),
					from: "system",
					type: "status",
					text: `Unblocked — all dependencies resolved`,
				});

				this.emit({
					type: "task_unblocked",
					squadId: this.squadId,
					taskId: task.id,
				});
			}
		}
	}

	/** Kill agents working on tasks that became re-blocked */
	killBlockedAgents(): void {
		const tasks = store.loadAllTasks(this.squadId);
		for (const task of tasks) {
			if (task.status === "blocked" && this.pool.isRunning(task.id)) {
				this.pool.steer(
					task.id,
					"[squad] Your task has been blocked because a dependency was reopened. Stopping your work.",
				);
				this.pool.kill(task.id);
			}
		}
	}

	// =========================================================================
	// QA Rework Loop
	// =========================================================================

	/**
	 * Check if a completed task is a QA task that found failures.
	 * If so, create a rework task for the original agent and a retest task for QA.
	 * Returns true if rework was created (caller should NOT auto-unblock dependents).
	 */
	private checkForRework(task: Task, output: string): boolean {
		// Only trigger rework for QA/test agent tasks
		const qaAgents = ["qa", "tester", "security"];
		if (!qaAgents.includes(task.agent)) return false;

		// Parse verdict from output
		const verdict = this.parseQaVerdict(output);
		if (verdict === "pass") return false;

		// Find the implementation task(s) this QA task was testing
		const allTasks = store.loadAllTasks(this.squadId);
		const implDeps = task.depends
			.map((depId) => allTasks.find((t) => t.id === depId))
			.filter((t): t is Task => t !== null && !qaAgents.includes(t.agent));

		if (implDeps.length === 0) return false;

		const squad = store.loadSquad(this.squadId);
		if (!squad) return false;

		// Extract the failure details for feedback
		const feedback = this.extractQaFeedback(output);

		let createdAny = false;
		for (const implTask of implDeps) {
			// Check retry limit
			const retryCount = store.getRetryCount(this.squadId, implTask.retryOf || implTask.id);
			const originalId = implTask.retryOf || implTask.id;

			if (retryCount >= squad.config.maxRetries) {
				debug("squad-scheduler", `Retry limit reached for ${originalId} (${retryCount}/${squad.config.maxRetries})`);
				this.emit({
					type: "escalation",
					squadId: this.squadId,
					taskId: task.id,
					agentName: task.agent,
					message: `QA failed ${originalId} ${retryCount} times. Retry limit reached.\nLatest feedback:\n${feedback.slice(0, 500)}`,
				});
				continue;
			}

			const fixN = retryCount + 1;

			// Create rework task for the original agent
			const reworkId = `${originalId}-fix-${fixN}`;
			const reworkTask: Task = {
				id: reworkId,
				title: `Fix: ${implTask.title} (attempt ${fixN})`,
				description: `QA found issues in ${implTask.id}. Fix the problems described below.\n\n## QA Feedback\n${feedback}`,
				agent: implTask.agent,
				status: "pending",
				depends: [],
				created: store.now(),
				started: null,
				completed: null,
				output: null,
				error: null,
				usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
				retryOf: originalId,
				retryCount: fixN,
				qaFeedback: feedback,
			};
			store.createTask(this.squadId, reworkTask);

			// Create retest task for QA
			const retestId = `${task.id}-retest-${fixN}`;
			const retestTask: Task = {
				id: retestId,
				title: `Re-test: ${implTask.title} (after fix ${fixN})`,
				description: `Re-test ${implTask.id} after rework. Verify the issues from the previous QA round are fixed.\n\nPrevious issues:\n${feedback}`,
				agent: task.agent,
				status: "blocked",
				depends: [reworkId],
				created: store.now(),
				started: null,
				completed: null,
				output: null,
				error: null,
				usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
				retryOf: task.id,
				retryCount: fixN,
			};
			store.createTask(this.squadId, retestTask);

			store.appendMessage(this.squadId, task.id, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: `QA failed — creating rework task ${reworkId} for ${implTask.agent} and retest ${retestId}`,
			});

			this.emit({
				type: "task_rework",
				squadId: this.squadId,
				taskId: reworkId,
				agentName: implTask.agent,
				message: `QA found issues in ${implTask.id}. Rework attempt ${fixN}.`,
			});

			debug("squad-scheduler", `Rework: ${reworkId} (${implTask.agent}) + retest ${retestId} (${task.agent})`);
			createdAny = true;
		}

		return createdAny;
	}

	/** Parse QA verdict from task output */
	private parseQaVerdict(output: string): "pass" | "fail" | "pass_with_issues" {
		const lower = output.toLowerCase();

		// Look for structured verdict line: "## Verdict: FAIL" or "Verdict: PASS"
		const verdictMatch = output.match(/##?\s*Verdict:\s*(PASS WITH ISSUES|PASS|FAIL)/i);
		if (verdictMatch) {
			const v = verdictMatch[1].toUpperCase();
			if (v === "FAIL") return "fail";
			if (v === "PASS WITH ISSUES") return "pass_with_issues";
			return "pass";
		}

		// Fallback: look for common failure patterns
		if (
			lower.includes("verdict: fail") ||
			lower.includes("status: fail") ||
			/\d+\s+(?:tests?\s+)?fail(?:ed|ing|ure)/i.test(output) ||
			(lower.includes("fail") && lower.includes("test") && !lower.includes("0 fail"))
		) {
			return "fail";
		}

		return "pass";
	}

	/** Extract actionable feedback from QA output */
	private extractQaFeedback(output: string): string {
		// Try to extract "## Issues" or "## Failures" section
		const issuesMatch = output.match(/##\s*(?:Issues|Failures|Bugs|Problems|Failed Tests)[\s\S]*?(?=\n##\s|$)/i);
		if (issuesMatch) return issuesMatch[0].trim();

		// Try to extract lines containing "FAIL", "Error", "✗"
		const failLines = output.split("\n")
			.filter((line) => /fail|error|✗|✘|broken|bug/i.test(line))
			.slice(0, 20);
		if (failLines.length > 0) return failLines.join("\n");

		// Fallback: last 500 chars
		return output.slice(-500);
	}

	// =========================================================================
	// Squad Completion
	// =========================================================================

	private checkSquadCompletion(tasks: Task[], squad: Squad): void {
		if (tasks.length === 0) return;

		const allDone = tasks.every((t) => t.status === "done");
		const anyFailed = tasks.some((t) => t.status === "failed");
		const anyInProgress = tasks.some(
			(t) => t.status === "in_progress" || t.status === "pending",
		);

		if (allDone) {
			squad.status = "done";
			store.saveSquad(squad);
			this.emit({ type: "squad_completed", squadId: this.squadId });
		} else if (anyFailed && !anyInProgress) {
			// All remaining tasks are blocked/failed with no way forward
			const blockedCount = tasks.filter((t) => t.status === "blocked").length;
			const failedCount = tasks.filter((t) => t.status === "failed").length;
			if (blockedCount + failedCount === tasks.filter((t) => t.status !== "done").length) {
				squad.status = "failed";
				store.saveSquad(squad);
				this.emit({ type: "squad_failed", squadId: this.squadId });
			}
		}
	}

	// =========================================================================
	// Context Updates
	// =========================================================================

	private updateModifiedFiles(agentName: string, filePath: string): void {
		// Context will pick this up from AgentActivity
	}

	/** Rebuild and save context.json */
	updateContext(): void {
		const squad = store.loadSquad(this.squadId);
		if (!squad) return;

		const tasks = store.loadAllTasks(this.squadId);
		const startTime = new Date(squad.created).getTime();
		const elapsed = formatElapsed(Date.now() - startTime);

		// Build agent states
		const agentStates: Record<string, any> = {};
		for (const [name] of Object.entries(squad.agents)) {
			const agentDef = store.loadAgentDef(name, squad.cwd);
			const runningTaskId = this.pool.getTaskIdForAgent(name);
			agentStates[name] = {
				role: agentDef?.role || "Unknown",
				status: runningTaskId ? "working" : "idle",
				task: runningTaskId || null,
			};
		}

		// Build task states
		const taskStates: Record<string, any> = {};
		for (const task of tasks) {
			taskStates[task.id] = {
				status: task.status,
				agent: task.agent,
				title: task.title,
				...(task.output ? { output: task.output.slice(0, 500) } : {}),
				...(task.status === "blocked"
					? {
							blockedBy: task.depends.filter((d) => {
								const dep = tasks.find((t) => t.id === d);
								return dep && dep.status !== "done";
							}),
						}
					: {}),
			};
		}

		// Build costs
		const costs = { total: 0, byAgent: {} as Record<string, number> };
		for (const task of tasks) {
			costs.total += task.usage.cost;
			costs.byAgent[task.agent] = (costs.byAgent[task.agent] || 0) + task.usage.cost;
		}

		// Build modified files from activities
		const modifiedFiles: Record<string, string[]> = {};
		for (const agentName of this.pool.getRunningAgents()) {
			const taskId = this.pool.getTaskIdForAgent(agentName);
			if (taskId) {
				const activity = this.pool.getActivity(taskId);
				if (activity) {
					modifiedFiles[agentName] = Array.from(activity.modifiedFiles);
				}
			}
		}

		// Recent activity (last 20)
		const recentActivity: any[] = [];
		for (const task of tasks) {
			const messages = store.loadMessages(this.squadId, task.id);
			for (const msg of messages.slice(-5)) {
				recentActivity.push({
					ts: msg.ts,
					agent: msg.from,
					action:
						msg.type === "tool"
							? `→ ${msg.name} ${msg.args?.path || msg.args?.command || ""}`.trim()
							: msg.text.slice(0, 80),
				});
			}
		}
		recentActivity.sort((a, b) => b.ts.localeCompare(a.ts));

		store.saveContext(this.squadId, {
			goal: squad.goal,
			status: squad.status,
			elapsed,
			costs,
			agents: agentStates,
			tasks: taskStates,
			recentActivity: recentActivity.slice(0, 20),
			modifiedFiles,
		});
	}

	// =========================================================================
	// External Actions
	// =========================================================================

	/** Send a human message to a task's agent */
	async sendHumanMessage(taskId: string, message: string): Promise<boolean> {
		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "human",
			type: "message",
			text: message,
		});

		if (this.pool.isRunning(taskId)) {
			return this.pool.steer(taskId, `[squad] Human: ${message}`);
		}
		// Queue for when agent spawns
		const task = store.loadTask(this.squadId, taskId);
		if (task) {
			this.pool.queueMessage(task.agent, {
				ts: store.now(),
				from: "human",
				type: "message",
				text: message,
			});
		}
		return false;
	}

	/** Pause a running task */
	async pauseTask(taskId: string): Promise<void> {
		if (this.pool.isRunning(taskId)) {
			await this.pool.steer(taskId, "[squad] Task paused by user. Summarize your current state.");
			// Give agent a moment to respond, then kill
			setTimeout(() => this.pool.kill(taskId), 3000);
		}
		store.updateTaskStatus(this.squadId, taskId, "suspended");
		this.updateContext();
	}

	/** Resume a suspended task */
	async resumeTask(taskId: string): Promise<void> {
		store.updateTaskStatus(this.squadId, taskId, "pending");
		await this.scheduleReadyTasks();
	}

	/** Cancel a task */
	async cancelTask(taskId: string): Promise<void> {
		if (this.pool.isRunning(taskId)) {
			await this.pool.kill(taskId);
		}
		store.updateTaskStatus(this.squadId, taskId, "failed", {
			error: "Cancelled by user",
		});
		this.updateContext();
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private extractAssistantText(msg: any): string | null {
		if (!msg.content) return null;
		const textParts = msg.content
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text);
		return textParts.length > 0 ? textParts.join("\n") : null;
	}

}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}
