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

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentDef, Squad, SquadConfig, SuspendedStallAttention, Task, TaskMailboxEntry, TaskMessage, TaskStatus } from "./types.js";
import { AgentPool, type AgentEvent } from "./agent-pool.js";
import { Monitor } from "./monitor.js";
import { Router } from "./router.js";
import * as store from "./store.js";
import { isFileSpecTaskId, validateCanonicalSpec, validateTaskSpecAttestation } from "./file-spec.js";
import { debug, logError } from "./logger.js";
import { buildAgentSystemPrompt } from "./protocol.js";
import { buildAdvisorConsultText, formatAdvisorSteerMessage, adviceNeedsHuman, type AdvisorConsultInput } from "./advisor.js";
import { beginOrchestratorReview, beginOrchestratorRework } from "./review.js";

/** Backoff schedule for unexpected agent exits (provider/API outages). The
 * last delay repeats when PI_SQUAD_SPAWN_RETRIES exceeds the schedule. */
const SPAWN_RETRY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000, 120_000];

function maxSpawnRetries(): number {
	const value = Number(process.env.PI_SQUAD_SPAWN_RETRIES);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : SPAWN_RETRY_BACKOFF_MS.length;
}

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
	| "squad_review_required"
	| "squad_failed"
	| "suspended_stall"
	| "orchestrator_reply"
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

export interface SuspendedStallState {
	fingerprint: string;
	suspendedTaskIds: string[];
	blockedTaskIds: string[];
}

/** Pure derivation of an explicit-suspension stall from one persisted DAG. */
export function deriveSuspendedStall(tasks: Task[]): SuspendedStallState | null {
	const relevant = tasks.filter((task) => task.status !== "cancelled");
	const byId = new Map(relevant.map((task) => [task.id, task]));
	const suspendedTaskIds = relevant
		.filter((task) => task.status === "suspended")
		.map((task) => task.id)
		.sort((left, right) => left.localeCompare(right));
	if (suspendedTaskIds.length === 0) return null;
	const suspended = new Set(suspendedTaskIds);

	const reachesSuspended = (taskId: string, seen = new Set<string>()): boolean => {
		if (suspended.has(taskId)) return true;
		if (seen.has(taskId)) return false;
		seen.add(taskId);
		const task = byId.get(taskId);
		if (!task) return false;
		return task.depends.some((dependencyId) => reachesSuspended(dependencyId, seen));
	};
	const suspensionBlocked = (task: Task): boolean => task.status === "blocked" && task.depends.some((dependencyId) => {
		const dependency = byId.get(dependencyId);
		return dependency?.status !== "done" && reachesSuspended(dependencyId);
	});
	const runnableOrLive = relevant.some((task) => task.status === "in_progress" || (
		task.status === "pending" && task.depends.every((dependencyId) => byId.get(dependencyId)?.status === "done")
	));
	if (runnableOrLive) return null;

	const blockedTaskIds = relevant.filter(suspensionBlocked).map((task) => task.id).sort((left, right) => left.localeCompare(right));
	const blocked = new Set(blockedTaskIds);
	const terminal = new Set<TaskStatus>(["done", "failed", "cancelled"]);
	if (!relevant.every((task) => suspended.has(task.id) || terminal.has(task.status) || blocked.has(task.id))) return null;

	return {
		fingerprint: JSON.stringify([suspendedTaskIds, blockedTaskIds]),
		suspendedTaskIds,
		blockedTaskIds,
	};
}

/** Complete, actionable wake text; semantic task IDs are never abbreviated. */
export function formatSuspendedStallAttention(squadId: string, attention: Pick<SuspendedStallAttention, "suspendedTaskIds" | "blockedTaskIds">): string {
	return `[squad] SUSPENDED WORK NEEDS ACTION in '${squadId}'.\n` +
		`Suspended task IDs: ${attention.suspendedTaskIds.join(", ")}\n` +
		`Blocked by suspended work: ${attention.blockedTaskIds.length > 0 ? attention.blockedTaskIds.join(", ") : "none"}\n` +
		"No task was resumed automatically.\n" +
		`Resume intentionally with squad_modify { action: "resume_task", squadId: "${squadId}", taskId: "<exact-task-id>" } for each task you choose.`;
}

/** Host-session capabilities passed in by the extension (index.ts) */
export interface SchedulerSpawnContext {
	/** Resolve a model string (or null = default model) to its context window in tokens */
	resolveContextWindow?: (model: string | null) => number | undefined;
	/** Resolve the squad default model/thinking policy (settings.json + main session state) */
	getDefaultModelThinking?: () => { model?: string; thinking?: string };
	/** Consult the advisor model with a curated digest. Returns advice text, or null when disabled/unavailable. */
	consultAdvisor?: (input: AdvisorConsultInput) => Promise<string | null>;
}

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
	private spawnContext?: SchedulerSpawnContext;
	private running = false;
	/** Track spawn retries to allow one retry per task */
	/** Spawn retries per task. Success and explicit resume grant a fresh budget
	 * so a provider/API outage never leaves a task permanently unretriable. */
	private spawnRetryCounts = new Map<string, number>();
	/** Periodic level-triggered reconcile (heals missed events / out-of-band store edits) */
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;
	/** Suppress duplicate edge emission within one scheduler; disk remains the outbox. */
	private attentionEmittedFingerprint: string | null = null;

	/** Get the project cwd for this squad (from squad.json) */
	getProjectCwd(): string | undefined {
		return store.loadSquad(this.squadId)?.cwd;
	}

	constructor(squadId: string, skillPaths: string[], spawnContext?: SchedulerSpawnContext) {
		this.squadId = squadId;
		this.skillPaths = skillPaths;
		this.spawnContext = spawnContext;
		this.pool = new AgentPool();
		this.monitor = new Monitor(this.pool, squadId);
		this.router = new Router(this.pool, squadId);

		// Wire up agent events
		this.pool.onEvent((event) => this.handleAgentEvent(event));

		// Wire up monitor events
		this.monitor.onAction((action) => {
			if (action.type === "steer") {
				this.pool.steer(action.taskId, action.message);
			} else if (action.type === "notify") {
				// Informational only — tell the main Pi session directly (no advisor
				// detour, no kill). The agent keeps working.
				this.emit({
					type: "escalation",
					squadId: this.squadId,
					taskId: action.taskId,
					agentName: action.agentName,
					message: action.reason,
				});
			} else if (action.type === "escalate") {
				// Advisor-first: try a strong-model rescue before interrupting the human
				void this.tryAdvisorRescue(action.taskId, action.agentName, action.reason).then((rescued) => {
					if (rescued) return;
					this.emit({
						type: "escalation",
						squadId: this.squadId,
						taskId: action.taskId,
						agentName: action.agentName,
						message: action.reason,
					});
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

	/** Revalidate durable file-spec completion evidence after parent restart/review recovery. */
	async auditSpecAttestations(): Promise<string[]> {
		const squad = store.loadSquad(this.squadId); if (!squad?.spec) return [];
		const tasks = store.loadAllTasks(this.squadId);
		if (!validateCanonicalSpec(squad)) {
			const quarantined = tasks.filter((task) => task.status !== "cancelled");
			for (const task of quarantined) {
				if (task.status === "done") await this.invalidateDescendants(task.id);
				if (task.status === "in_progress" || task.status === "done") store.updateTaskStatus(this.squadId, task.id, "pending", { completed: null, output: null, error: "Canonical spec integrity failure" });
				else store.updateTaskStatus(this.squadId, task.id, task.status, { error: "Canonical spec integrity failure" });
			}
			return quarantined.map((task) => task.id);
		}
		const invalid = tasks.filter((task) => task.status === "done" && !validateTaskSpecAttestation(squad, task));
		for (const task of invalid) {
			store.updateTaskStatus(this.squadId, task.id, "pending", { completed: null, output: null, error: "Missing or invalid canonical spec read attestation" });
			store.appendMessage(this.squadId, task.id, { ts: store.now(), from: "system", type: "status", text: "Completion invalidated after attestation audit" });
			await this.invalidateDescendants(task.id);
		}
		if (invalid.length > 0 && squad.status === "review") { squad.status = "running"; delete squad.review; store.saveSquad(squad); }
		return invalid.map((task) => task.id);
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
		if (this.running) {
			await this.reconcile();
			return;
		}
		this.running = true;
		this.monitor.start();
		await this.reconcile();
		// Level-triggered safety net: periodically re-derive scheduling decisions
		// from persisted state so missed in-memory events (crashes, out-of-band
		// store edits, external recovery) cannot strand ready tasks.
		this.reconcileTimer = setInterval(() => void this.reconcile(), 60_000);
		(this.reconcileTimer as { unref?: () => void }).unref?.();
	}

	/** Stop the scheduler — kills all agents, saves state */
	async stop(): Promise<void> {
		this.running = false;
		this.monitor.stop();
		if (this.reconcileTimer) {
			clearInterval(this.reconcileTimer);
			this.reconcileTimer = null;
		}

		// Suspend in-progress tasks
		const tasks = store.loadAllTasks(this.squadId);
		for (const task of tasks) {
			if (task.status === "in_progress") {
				store.updateTaskStatus(this.squadId, task.id, "suspended");
			}
		}

		await this.pool.killAll();
	}

	/** Resume suspended/failed work. A failed review is archived only when
	 * resumable work actually exists; a bare resume cannot bypass the gate. */
	async resume(): Promise<void> {
		// Every resume is an explicit operator decision: grant fresh spawn-retry
		// budgets so provider-outage failures are always retriggerable.
		this.spawnRetryCounts.clear();
		const tasks = store.loadAllTasks(this.squadId);
		let resumedWork = false;
		for (const task of tasks) {
			if (task.status === "suspended") {
				store.updateTaskStatus(this.squadId, task.id, "pending");
				resumedWork = true;
			} else if (task.status === "failed") {
				store.updateTaskStatus(this.squadId, task.id, "pending", { error: null });
				store.appendMessage(this.squadId, task.id, {
					ts: store.now(),
					from: "system",
					type: "status",
					text: "Reset failed → pending on squad resume",
				});
				resumedWork = true;
			}
		}

		const squad = store.loadSquad(this.squadId);
		if (squad) {
			if (resumedWork && squad.status === "review" && squad.review?.status === "failed") {
				beginOrchestratorRework(squad);
				store.saveSquad(squad);
			} else if (squad.status === "paused" || squad.status === "failed") {
				squad.status = "running";
				store.saveSquad(squad);
			}
		}

		await this.start();
	}

	/**
	 * Level-triggered reconciliation — derive scheduling from persisted state:
	 * 1. Unblock blocked tasks whose deps are all done (missed autoUnblock events)
	 * 2. Self-heal a "failed" squad when runnable work exists (out-of-band recovery)
	 * 3. Schedule ready tasks
	 * Safe to call any time; no-ops when nothing changed.
	 */
	async reconcile(): Promise<void> {
		if (!this.running) return;
		const squad = store.loadSquad(this.squadId);
		if (!squad) return;
		// Canonical integrity is a scheduling precondition, not merely a completion check.
		if (squad.spec && !validateCanonicalSpec(squad)) {
			await this.auditSpecAttestations();
			debug("squad-scheduler", "reconcile: canonical spec integrity failure — scheduling quarantined");
			return;
		}

		const tasks = store.loadAllTasks(this.squadId);

		// 0. Mailbox recovery is level-triggered from disk. If the previous
		// process stopped after queueTaskMessage's atomic write but before status
		// mutation/RPC delivery, reopen exactly that task on reconstruction.
		let recoveredMailbox = false;
		for (const task of tasks) {
			if (task.status === "cancelled" || task.status === "suspended") continue;
			if (this.pool.isRunning(task.id)) continue;
			if (store.loadPendingTaskMessages(this.squadId, task.id).length === 0) continue;
			if (task.status === "done") await this.invalidateDescendants(task.id);
			const dependenciesDone = task.depends.every(
				(depId) => tasks.find((candidate) => candidate.id === depId)?.status === "done",
			);
			const nextStatus: TaskStatus = dependenciesDone ? "pending" : "blocked";
			if (task.status !== nextStatus || task.completed !== null || task.error !== null) {
				task.status = nextStatus;
				task.completed = null;
				task.error = null;
				store.updateTaskStatus(this.squadId, task.id, nextStatus, { completed: null, error: null });
			}
			recoveredMailbox = true;
		}
		if (recoveredMailbox && squad.status !== "running") {
			beginOrchestratorRework(squad);
			store.saveSquad(squad);
		}

		// 0b. Zombie in_progress recovery: tasks marked in_progress with no
		// live pool process are stranded (e.g. the main Pi session restarted
		// after a model switch, crash, or rate-limit kill while a worker was
		// running). Reset them to pending so scheduleReadyTasks respawns on
		// the same durable session.
		for (const task of tasks) {
			if (task.status !== "in_progress") continue;
			if (this.pool.isRunning(task.id)) continue;
			debug("squad-scheduler", `reconcile: zombie in_progress task '${task.id}' has no live process — resetting to pending`);
			store.updateTaskStatus(this.squadId, task.id, "pending", { completed: null, error: null });
			store.appendMessage(this.squadId, task.id, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: "Agent process lost (session restart, model switch, or provider failure). Resuming on the same durable session...",
			});
			task.status = "pending";
		}

		// 1. Blocked → pending when all deps are done (respects autoUnblock config)
		if (squad.config.autoUnblock) {
			for (const task of tasks) {
				if (task.status !== "blocked") continue;
				const allDepsDone = task.depends.every((depId) => {
					const dep = tasks.find((t) => t.id === depId);
					return dep?.status === "done";
				});
				if (allDepsDone) {
					task.status = "pending";
					store.updateTaskStatus(this.squadId, task.id, "pending");
					this.emit({ type: "task_unblocked", squadId: this.squadId, taskId: task.id });
				}
			}
		}

		// 2. A "failed" squad with runnable work self-heals to running. This makes
		// the terminal status derivable from task state instead of a one-way latch.
		const hasRunnable = tasks.some((t) => {
			if (t.status === "in_progress") return true;
			if (t.status !== "pending") return false;
			return t.depends.every((depId) => tasks.find((x) => x.id === depId)?.status === "done");
		});
		if (squad.status === "failed" && hasRunnable) {
			squad.status = "running";
			store.saveSquad(squad);
			debug("squad-scheduler", "reconcile: failed squad has runnable work — healing to running");
		}

		await this.scheduleReadyTasks();
		this.reconcileSuspendedStallAttention();

		const freshSquad = store.loadSquad(this.squadId);
		if (freshSquad && (freshSquad.status === "running" || freshSquad.status === "failed")) {
			this.checkSquadCompletion(store.loadAllTasks(this.squadId), freshSquad);
		}

		// A pending review whose notification never reached the main session
		// (delivery threw, or disabled mode dropped the event) is re-raised until
		// the delivery handler durably records review.notifiedAt. Successful
		// delivery stops the re-raise, so a slow human review never re-notifies.
		const reviewSquad = freshSquad?.status === "review" ? freshSquad : store.loadSquad(this.squadId);
		if (reviewSquad?.status === "review" && reviewSquad.review?.status === "pending" && !reviewSquad.review.notifiedAt) {
			this.emit({ type: "squad_review_required", squadId: this.squadId });
		}
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
		if (!squad || squad.status !== "running" || (squad.spec && !validateCanonicalSpec(squad))) {
			debug("squad-scheduler", `scheduleReadyTasks: squad unavailable, inactive, or canonical integrity invalid; status=${squad?.status}`);
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
			// A reconstructed scheduler has an empty process pool. Persisted
			// in_progress means the previous process stopped mid-task, so resume its
			// bound session instead of stranding it or creating a fresh context.
			const needsProcess = task.status === "pending" ||
				(task.status === "in_progress" && !this.pool.isRunning(task.id));
			if (!needsProcess) return false;
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

		// Apply squad-level model/thinking overrides
		const squadAgentEntry = squad.agents[task.agent];
		if (squadAgentEntry?.model) {
			agentDef.model = squadAgentEntry.model;
		}
		if (squadAgentEntry?.thinking) {
			agentDef.thinking = squadAgentEntry.thinking;
		}

		// Apply squad defaults for anything still unset (policy resolved by the
		// extension host: "main" = main session's model/thinking, "pi-default" =
		// leave unset, or an explicit value from ~/.pi/squad/settings.json)
		const defaults = this.spawnContext?.getDefaultModelThinking?.();
		if (!agentDef.model && defaults?.model) {
			agentDef.model = defaults.model;
		}
		if (!agentDef.thinking && defaults?.thinking) {
			agentDef.thinking = defaults.thinking;
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

		const resumeSession = store.loadTaskSession(this.squadId, task.id) ?? undefined;
		const pendingMailbox = store.loadPendingTaskMessages(this.squadId, task.id);
		// Legacy tasks predate task-owned Pi sessions. Their first durable spawn
		// must receive the complete persisted history/output as a migration seed;
		// otherwise reopening silently discards all prior context.
		const legacyHistory = !resumeSession && (task.started !== null || task.completed !== null || task.output !== null)
			? store.loadMessages(this.squadId, task.id)
			: [];
		const legacySeed = legacyHistory.length > 0 || (!resumeSession && task.output !== null)
			? { messages: legacyHistory, output: task.output }
			: undefined;

		// Keep the original start time across resumes. A resumed/live process owns
		// in_progress until Pi emits final agent_settled.
		store.updateTaskStatus(this.squadId, task.id, "in_progress", {
			started: task.started ?? store.now(),
			completed: null,
			error: null,
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

		// Context inheritance creates a session only on the task's first run.
		// Every later run must reopen the immutable task binding.
		const forkSessionFile = resumeSession ? undefined : this.resolveForkSession(task, squad, agentDef);
		const taskSessionDir = store.getTaskSessionDir(this.squadId, task.id);

		try {
			const agent = await this.pool.spawn({
				taskId: task.id,
				agentDef,
				protocolOptions: {
					squadId: this.squadId,
					squad,
					task,
					agentDef,
					modifiedFiles,
					queuedMessages: pendingMailbox.map((entry) => entry.message),
				},
				cwd: squad.cwd,
				skillPaths: this.skillPaths,
				...(squad.spec ? { spec: { squadId: squad.id, path: squad.spec.path, sha256: squad.spec.sha256, bytes: squad.spec.bytes, chunkBytes: squad.spec.chunkBytes } } : {}),
				...(resumeSession
					? { resumeSession }
					: forkSessionFile
						? { forkSession: { file: forkSessionFile, sessionDir: taskSessionDir } }
						: { sessionDir: taskSessionDir }),
			});
			store.bindTaskSession(this.squadId, task.id, agent.session);

			const accepted = await this.pool.prompt(
				task.id,
				this.buildTaskPrompt(task, Boolean(resumeSession), pendingMailbox, legacySeed),
			);
			if (!accepted) throw new Error(`Agent ${task.agent} did not accept the task prompt`);
			store.acknowledgeTaskMessages(
				this.squadId,
				task.id,
				pendingMailbox.map((entry) => entry.id),
			);
		} catch (error) {
			this.handleTaskFailed(task.id, (error as Error).message);
		}

		this.updateContext();
	}

	/** Advisor consultations per task (advisor-first escalation) */
	private advisorAttempts = new Map<string, number>();

	/**
	 * Consult the advisor for a stuck agent and steer it with the advice.
	 * Returns true when the agent was steered (escalation suppressed).
	 * Returns false when the advisor is disabled, exhausted, unavailable,
	 * failed, or explicitly said the problem needs human input.
	 */
	private async tryAdvisorRescue(taskId: string, agentName: string | undefined, reason: string): Promise<boolean> {
		try {
			const consult = this.spawnContext?.consultAdvisor;
			if (!consult) return false;

			const settings = store.loadSquadSettings();
			if (!settings.advisor.enabled) return false;

			const attempts = this.advisorAttempts.get(taskId) || 0;
			if (attempts >= settings.advisor.maxCallsPerTask) {
				debug("squad-advisor", `${taskId}: advisor exhausted (${attempts}/${settings.advisor.maxCallsPerTask}), escalating`);
				return false;
			}
			if (!this.pool.isRunning(taskId)) return false;

			const task = store.loadTask(this.squadId, taskId);
			const squad = store.loadSquad(this.squadId);
			if (!task || !squad) return false;
			const agentDef = store.loadAgentDef(task.agent, squad.cwd);
			const activity = this.pool.getActivity(taskId);

			this.advisorAttempts.set(taskId, attempts + 1);

			const input: AdvisorConsultInput = {
				taskId,
				taskTitle: task.title,
				taskDescription: task.description,
				agentName: task.agent,
				agentRole: agentDef?.role || task.agent,
				reason,
				recentMessages: store.loadMessages(this.squadId, taskId).map((m) => ({ from: m.from, type: m.type, text: m.text })),
				recentToolCalls: activity ? [...activity.recentToolCalls] : [],
				turnCount: activity?.turnCount || 0,
				elapsedMinutes: activity ? (Date.now() - activity.startedAt) / 60000 : 0,
			};

			const advice = await consult(input);
			if (!advice) return false;

			store.appendMessage(this.squadId, taskId, {
				ts: store.now(),
				from: "advisor",
				type: "message",
				text: advice,
			});

			// Advisor says a human decision is required — escalate with the advice attached
			if (adviceNeedsHuman(advice)) {
				this.emit({
					type: "escalation",
					squadId: this.squadId,
					taskId,
					agentName,
					message: `${reason}\n\nAdvisor assessment:\n${advice}`,
				});
				return true; // escalation already emitted with richer context
			}

			const delivered = await this.pool.steer(taskId, formatAdvisorSteerMessage(advice, reason));
			debug("squad-advisor", `${taskId}: advisor steered agent (attempt ${attempts + 1}, delivered=${delivered})`);
			return delivered;
		} catch (error) {
			logError("squad-advisor", `rescue failed for ${taskId}: ${(error as Error).message}`);
			return false;
		}
	}

	/**
	 * Decide whether this task's agent should be spawned as a fork of an
	 * existing session: another task's durable session (forkFromTaskId) or the
	 * main pi session (inheritContext). Guards against blowing the child
	 * model's context window: forks only when the estimated session tokens fit
	 * within 50% of the agent model's context window.
	 */
	private resolveForkSession(task: Task, squad: Squad, agentDef: AgentDef): string | undefined {
		if (!task.inheritContext && !task.forkFromTaskId) return undefined;

		const skip = (reason: string): undefined => {
			logError("squad-scheduler", `session fork skipped for ${task.id}: ${reason}`);
			store.appendMessage(this.squadId, task.id, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: `Session fork skipped: ${reason}. Agent starts with standard squad context only.`,
			});
			return undefined;
		};

		// Fork another task's durable session: the follow-up/rework agent
		// continues with the source task's complete context.
		if (task.forkFromTaskId) {
			const source = store.loadTaskSession(this.squadId, task.forkFromTaskId);
			if (!source || !fs.existsSync(source.file)) {
				return skip(`fork source task '${task.forkFromTaskId}' has no durable session file`);
			}
			const estTokens = Math.ceil(fs.statSync(source.file).size / 4);
			const window = this.spawnContext?.resolveContextWindow?.(agentDef.model ?? null);
			// An unknown window does not veto an explicit operator/orchestrator
			// request: task sessions are bounded, unlike whole main sessions.
			if (window && estTokens > window * 0.5) {
				return skip(`fork source session (~${Math.round(estTokens / 1000)}k tokens) exceeds 50% of ${agentDef.model || "default model"}'s ${Math.round(window / 1000)}k window — restate key context in the task description instead`);
			}
			debug("squad-scheduler", `forkFromTask: forking ${source.file} (task ${task.forkFromTaskId}) for ${task.id} (~${Math.round(estTokens / 1000)}k tokens)`);
			return source.file;
		}

		const sessionFile = squad.sessionFile;
		if (!sessionFile) return skip("main session has no session file (ephemeral --no-session run)");
		if (!fs.existsSync(sessionFile)) return skip(`session file not found: ${sessionFile}`);

		// Rough token estimate: JSONL bytes / 4. Overestimates (JSON overhead), which is safe.
		const estTokens = Math.ceil(fs.statSync(sessionFile).size / 4);

		const window = this.spawnContext?.resolveContextWindow?.(agentDef.model ?? null);
		if (!window) {
			return skip(`cannot determine context window for model "${agentDef.model || "(default)"}"`);
		}
		if (estTokens > window * 0.5) {
			return skip(
				`estimated session context (~${Math.round(estTokens / 1000)}k tokens) exceeds 50% of ${agentDef.model || "default model"}'s ${Math.round(window / 1000)}k window — restate key context in the task description instead`,
			);
		}

		debug("squad-scheduler", `inheritContext: forking ${sessionFile} for ${task.id} (~${Math.round(estTokens / 1000)}k tokens, window ${Math.round(window / 1000)}k)`);
		return sessionFile;
	}

	private buildTaskPrompt(
		task: Task,
		resumed: boolean,
		entries: TaskMailboxEntry[],
		legacySeed?: { messages: TaskMessage[]; output: string | null },
	): string {
		const fileSpec = store.loadSquad(this.squadId)?.spec;
		const lines = fileSpec
			? [
					`${resumed ? "Resume" : "Start"} file-spec squad task ${task.id}.`,
					`Canonical spec: sha256=${fileSpec.sha256} bytes=${fileSpec.bytes} chunks=${fileSpec.chunkCount}.`,
					"Use squad_spec_read to receive every canonical chunk before normal tools or completion.",
					...(task.fileSpecDelta ? ["", `Dynamic task delta: ${task.title}`, task.description] : []),
					...(resumed ? ["Continue from this task's durable Pi session and existing read coverage."] : []),
				]
			: resumed
				? [
						`Resume your existing task: ${task.title}`,
						"Continue from the durable Pi session context. Do not restart the task from scratch.",
					]
				: [
						`Your task: ${task.title}`,
						"",
						task.description || "",
					];

		if (legacySeed) {
			const pendingIds = new Set(entries.map((entry) => entry.id));
			lines.push("", "Legacy task migration: the following persisted history is the complete prior context. Preserve it and continue from it.");
			for (const message of legacySeed.messages) {
				if (message.id && pendingIds.has(message.id)) continue;
				lines.push("", `[${message.ts}] ${message.from} (${message.type}):`, message.text);
			}
			if (legacySeed.output !== null) {
				lines.push("", "Prior durable task output:", legacySeed.output);
			}
		}

		if (entries.length > 0) {
			lines.push("", "New durable messages for this task:");
			for (const entry of entries) {
				lines.push("", `[${entry.message.ts}] ${entry.message.from}:`, entry.message.text);
				if (entry.message.expectsReply) {
					lines.push("[Direct response required by main orchestrator]");
				}
			}
			lines.push("", "Read and act on every complete message above.");
		} else if (resumed) {
			lines.push("", "The previous process ended before final settlement. Continue the unfinished work and report the final result.");
		}
		return lines.join("\n");
	}

	private handleUnexpectedAgentExit(event: AgentEvent): void {
		const status = store.loadTask(this.squadId, event.taskId)?.status;
		if (status === "cancelled" || status === "suspended") return;
		const exitCode = event.data?.exitCode ?? 1;
		const turnCount = event.data?.turnCount ?? 0;
		const stderr = event.data?.stderr || "";
		const retryKey = `spawn-retry:${event.taskId}`;
		const attempt = this.spawnRetryCounts.get(retryKey) ?? 0;
		const maxRetries = maxSpawnRetries();
		if (attempt < maxRetries) {
			this.spawnRetryCounts.set(retryKey, attempt + 1);
			const delayMs = SPAWN_RETRY_BACKOFF_MS[Math.min(attempt, SPAWN_RETRY_BACKOFF_MS.length - 1)];
			const reason = turnCount === 0
				? "exited with 0 turns (likely rate limit or provider API error)"
				: `exited before final agent_settled after ${turnCount} turns`;
			logError("squad-scheduler", `Agent ${event.agentName} ${reason}, code=${exitCode}. Retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs / 1000)}s... stderr: ${stderr}`);
			store.updateTaskStatus(this.squadId, event.taskId, "pending");
			store.appendMessage(this.squadId, event.taskId, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: `Agent ${reason}. Retry ${attempt + 1}/${maxRetries} resumes the same task session in ${Math.round(delayMs / 1000)}s...`,
			});
			const timer = setTimeout(() => {
				if (this.running) this.scheduleReadyTasks();
			}, delayMs);
			(timer as { unref?: () => void }).unref?.();
		} else {
			this.handleTaskFailed(
				event.taskId,
				`Agent exited with code ${exitCode} before final agent_settled (${maxRetries} backoff retries exhausted — likely provider/API outage). ${stderr}`.trimEnd() +
					`\nWhen the provider recovers, squad_modify { action: "resume_task", taskId: "${event.taskId}" } reopens the same durable session with a fresh retry budget — no work is redone.`,
			);
		}
		this.updateContext();
	}

	// =========================================================================
	// Event Handlers
	// =========================================================================

	private handleAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_end":
				this.onMessageEnd(event);
				break;
			case "tool_execution_start":
				this.onToolExecutionStart(event);
				break;
			case "tool_execution_end":
				this.onToolExecutionEnd(event);
				break;
			case "agent_end":
				if (this.onAgentEnd(event)) return;
				break;
			case "agent_settled":
				this.onAgentSettled(event);
				return;
			case "error":
				this.onError(event);
				break;
		}

		this.updateContext();
	}

	private onMessageEnd(event: AgentEvent): void {
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
					// Persist the complete handoff. Reports can be arbitrarily long;
					// presentation layers may viewport them, but source data must never truncate.
					text,
				});

				// A squad_message is a request/response channel, not fire-and-forget.
				// Persist an acknowledgement marker before emitting so restart/focus
				// changes cannot forward the same response twice.
				if (this.hasPendingOrchestratorRequest(event.taskId)) {
					store.appendMessage(this.squadId, event.taskId, {
						ts: store.now(),
						from: event.agentName,
						type: "reply",
						to: "orchestrator",
						text: "Response forwarded to main orchestrator",
					});
					this.emit({
						type: "orchestrator_reply",
						squadId: this.squadId,
						taskId: event.taskId,
						agentName: event.agentName,
						message: text,
					});
				}
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
	}

	private onToolExecutionStart(event: AgentEvent): void {
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
	}

	private onToolExecutionEnd(event: AgentEvent): void {
		// Track file modifications
		const data = event.data;
		if (data.toolName === "write" || data.toolName === "edit") {
			const filePath = data.args?.path || data.args?.file_path;
			if (filePath) {
				this.updateModifiedFiles(event.agentName, filePath);
			}
		}
	}

	private onAgentEnd(event: AgentEvent): boolean {
		// Pi's low-level agent_end is not completion. AgentPool normally keeps
		// it internal; if observed here, preserve in_progress. Only an actual
		// child-process exit carries unexpectedExit and enters retry handling.
		if (!event.data?.unexpectedExit) return false;
		this.handleUnexpectedAgentExit(event);
		return true;
	}

	private onAgentSettled(event: AgentEvent): void {
		const settledTask = store.loadTask(this.squadId, event.taskId);
		const status = settledTask?.status;
		if (status === "cancelled" || status === "suspended") return;
		const settledSquad = store.loadSquad(this.squadId);
		if (settledTask && settledSquad && !validateTaskSpecAttestation(settledSquad, settledTask)) {
			store.updateTaskStatus(this.squadId, event.taskId, "pending", { completed: null, output: null, error: "Canonical squad spec was not fully delivered; read all chunks with squad_spec_read" });
			store.appendMessage(this.squadId, event.taskId, { ts: store.now(), from: "system", type: "status", text: "Completion rejected: missing or invalid spec-read-attestation; reopening same task session" });
			if (this.running) void this.reconcile();
			this.updateContext();
			return;
		}
		// A mailbox entry not acknowledged by Pi outranks this run's candidate
		// completion. Reopen the same session so accepted-at-least-once delivery
		// occurs before the task can become done.
		if (store.loadPendingTaskMessages(this.squadId, event.taskId).length > 0) {
			store.updateTaskStatus(this.squadId, event.taskId, "pending", { completed: null });
			store.appendMessage(this.squadId, event.taskId, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: "Agent settled with pending durable messages; resuming the same task session",
			});
			if (this.running) void this.reconcile();
			this.updateContext();
			return;
		}

		const turnCount = event.data?.turnCount ?? 0;
		const toolCallCount = event.data?.toolCallCount ?? 0;
		const hasSubstantiveOutput = store.loadMessages(this.squadId, event.taskId)
			.some((message) => message.from === event.agentName && message.type === "text" && message.text.trim().length > 0);
		const hadMeaningfulWork = turnCount > 0 && (toolCallCount > 0 || hasSubstantiveOutput);
		if (hadMeaningfulWork) {
			this.handleTaskCompleted(event.taskId).then(() => this.updateContext());
		} else {
			this.handleUnexpectedAgentExit({
				...event,
				data: { ...event.data, unexpectedExit: true },
			});
		}
	}

	private onError(event: AgentEvent): void {
		const errorMsg = event.data?.message || "Unknown error";
		store.appendMessage(this.squadId, event.taskId, {
			ts: store.now(),
			from: "system",
			type: "error",
			text: errorMsg,
		});
	}

	private async handleTaskCompleted(taskId: string): Promise<void> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) return;

		// Guard against double-completion and late callbacks after cancellation or
		// an explicit pause. Only exact resume_task may revive suspended work.
		if (task.status === "done" || task.status === "cancelled" || task.status === "suspended") return;

		// Extract output from last messages
		const messages = store.loadMessages(this.squadId, taskId);
		const squad = store.loadSquad(this.squadId);
		const rejectedAt = squad?.spec
			? messages.reduce((last, message, index) => message.from === "system" && message.type === "status" && message.text.startsWith("Completion rejected: missing or invalid spec-read-attestation") ? index : last, -1)
			: -1;
		const agentMessages = messages
			.slice(rejectedAt + 1)
			.filter((m) => m.from === task.agent && (m.type === "text" || m.type === "done"));
		const output = agentMessages.map((m) => m.text).join("\n");

		// A successful completion also restores the full spawn-retry budget for
		// any later reopen of this task (rework, follow-up messages).
		this.spawnRetryCounts.delete(`spawn-retry:${taskId}`);
		// Clear any interim failure annotation (spawn retry, RPC race): a task
		// that ultimately completed must not display a stale error forever.
		store.updateTaskStatus(this.squadId, taskId, "done", {
			output: output || "Task completed",
			error: null,
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

		// A completion can remove the last independent runnable task and expose a
		// stall behind an explicitly suspended task. Derive/wake immediately rather
		// than waiting for the periodic reconciliation timer.
		this.reconcileSuspendedStallAttention();

		// Re-check squad completion with fresh data AFTER scheduling
		const freshTasks = store.loadAllTasks(this.squadId);
		const freshSquad = store.loadSquad(this.squadId);
		debug("squad-scheduler", `handleTaskCompleted: final check — tasks: ${freshTasks.map(t => `${t.id}:${t.status}`).join(", ")}`);
		if (freshSquad) {
			this.checkSquadCompletion(freshTasks, freshSquad);
		}
	}

	private handleTaskFailed(taskId: string, error: string): void {
		if (store.loadTask(this.squadId, taskId)?.status === "cancelled") return;
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

		// Failure can likewise expose a suspended-only cut in the remaining DAG.
		this.reconcileSuspendedStallAttention();

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
		const qaAgents = ["qa", "tester", "security", "reviewer"];
		if (!qaAgents.includes(task.agent)) return false;

		// Parse verdict from output
		const verdict = this.parseQaVerdict(output);
		if (verdict === "pass") return false;

		// Find the implementation task(s) this QA task was testing
		const allTasks = store.loadAllTasks(this.squadId);
		const implDeps = task.depends
			.map((depId) => allTasks.find((t) => t.id === depId))
			.filter((t): t is Task => t !== undefined && !qaAgents.includes(t.agent));

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
					message: `QA failed ${originalId} ${retryCount} times. Retry limit reached.\nLatest feedback:\n${feedback}`,
				});
				continue;
			}

			const fixN = retryCount + 1;

			// Create rework task for the original agent
			const reworkId = `${originalId}-fix-${fixN}`;
			const retestId = `${task.id}-retest-${fixN}`;
			if (squad.spec && (!isFileSpecTaskId(reworkId) || !isFileSpecTaskId(retestId))) {
				this.handleTaskFailed(task.id, `Generated file-spec rework IDs exceed the safe task-ID contract: ${reworkId}, ${retestId}`);
				return true;
			}
			const reworkTask: Task = {
				id: reworkId,
				title: `Fix: ${implTask.title} (attempt ${fixN})`,
				description: `QA found issues in ${implTask.id}. Fix the problems described below.\n\n## QA Feedback\n${feedback}`,
				agent: implTask.agent,
				status: "pending",
				depends: [],
				...(implTask.inheritContext ? { inheritContext: true } : {}),
				...(squad.spec ? { fileSpecDelta: true } : {}),
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
			const retestTask: Task = {
				id: retestId,
				title: `Re-test: ${implTask.title} (after fix ${fixN})`,
				description: `Re-test ${implTask.id} after rework. Verify the issues from the previous QA round are fixed.\n\nPrevious issues:\n${feedback}`,
				agent: task.agent,
				status: "blocked",
				depends: [reworkId],
				...(squad.spec ? { fileSpecDelta: true } : {}),
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
			.filter((line) => /fail|error|✗|✘|broken|bug/i.test(line));
		if (failLines.length > 0) return failLines.join("\n");

		// Preserve the complete QA handoff when no structured failure section exists.
		return output;
	}

	// =========================================================================
	// Squad Completion
	// =========================================================================

	private checkSquadCompletion(tasks: Task[], squad: Squad): void {
		if (tasks.length === 0) return;

		const invalidDone = tasks.filter((task) => task.status === "done" && !validateTaskSpecAttestation(squad, task));
		if (invalidDone.length > 0) {
			for (const task of invalidDone) {
				store.updateTaskStatus(this.squadId, task.id, "pending", { completed: null, output: null, error: "Missing or invalid canonical spec read attestation" });
				store.appendMessage(this.squadId, task.id, { ts: store.now(), from: "system", type: "status", text: "Completion invalidated: canonical spec attestation is missing or invalid" });
				void this.invalidateDescendants(task.id);
			}
			if (squad.status === "review") { squad.status = "running"; delete squad.review; store.saveSquad(squad); }
			if (this.running) void this.reconcile();
			return;
		}

		const relevant = tasks.filter((task) => task.status !== "cancelled");
		const allDone = relevant.every((task) => task.status === "done");
		const anyFailed = relevant.some((task) => task.status === "failed");
		const anyInProgress = relevant.some(
			(task) => task.status === "in_progress" || task.status === "pending",
		);

		if (allDone) {
			// Agent execution is only a candidate result. It cannot become "done"
			// until the main Pi independently reviews it against the original contract.
			if (squad.status === "review") return;
			beginOrchestratorReview(squad);
			store.saveSquad(squad);
			this.emit({ type: "squad_review_required", squadId: this.squadId });
		} else if (anyFailed && !anyInProgress) {
			// All remaining tasks are blocked/failed with no way forward.
			// Emit only on the transition: repeated reconciles over an already-failed
			// squad must not queue duplicate stall notifications (each would trigger
			// its own main-session turn).
			if (squad.status === "failed") return;
			const blockedCount = relevant.filter((task) => task.status === "blocked").length;
			const failedCount = relevant.filter((task) => task.status === "failed").length;
			if (blockedCount + failedCount === relevant.filter((task) => task.status !== "done").length) {
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
				...(task.output ? { output: task.output } : {}),
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
							: msg.text,
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

	/**
	 * A reopened dependency invalidates every transitive descendant, including
	 * descendants that had already completed. They retain history/output for
	 * audit and durable-session continuation, but must rerun in dependency order.
	 */
	private async invalidateDescendants(reopenedTaskId: string): Promise<void> {
		const tasks = store.loadAllTasks(this.squadId);
		const byDependency = new Map<string, Task[]>();
		for (const task of tasks) {
			for (const dependency of task.depends) {
				const dependents = byDependency.get(dependency) ?? [];
				dependents.push(task);
				byDependency.set(dependency, dependents);
			}
		}

		const queue = [...(byDependency.get(reopenedTaskId) ?? [])];
		const seen = new Set<string>();
		const kills: Promise<void>[] = [];
		while (queue.length > 0) {
			const descendant = queue.shift()!;
			if (seen.has(descendant.id)) continue;
			seen.add(descendant.id);
			queue.push(...(byDependency.get(descendant.id) ?? []));
			if (descendant.status === "cancelled") continue;
			store.updateTaskStatus(this.squadId, descendant.id, "blocked", {
				completed: null,
				error: null,
			});
			store.appendMessage(this.squadId, descendant.id, {
				ts: store.now(),
				from: "system",
				type: "status",
				text: `Blocked — dependency ancestry reopened at ${reopenedTaskId}; prior result requires revalidation`,
			});
			if (this.pool.isRunning(descendant.id)) kills.push(this.pool.kill(descendant.id));
		}
		await Promise.all(kills);
	}

	private reopenSquadForWork(): void {
		const squad = store.loadSquad(this.squadId);
		if (!squad) throw new Error(`Squad not found: ${this.squadId}`);
		if (squad.status === "review" || squad.status === "done" || squad.review) {
			beginOrchestratorRework(squad);
		} else if (squad.status !== "running") {
			squad.status = "running";
		}
		store.saveSquad(squad);
	}

	private async reopenTaskForMessage(task: Task): Promise<void> {
		if (task.status === "done") await this.invalidateDescendants(task.id);
		const tasks = store.loadAllTasks(this.squadId);
		const dependenciesDone = task.depends.every(
			(depId) => tasks.find((candidate) => candidate.id === depId)?.status === "done",
		);
		const nextStatus: TaskStatus = dependenciesDone ? "pending" : "blocked";
		store.updateTaskStatus(this.squadId, task.id, nextStatus, {
			error: null,
			completed: null,
		});

		this.reopenSquadForWork();
	}

	/** Send a main-orchestrator request to one exact task and await its next reply. */
	async sendHumanMessage(taskId: string, message: string, expectsReply = true): Promise<boolean> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) return false;

		// Mailbox-first: a process/scheduler crash can occur at any later point
		// without losing or redirecting this message to another task of the role.
		const queued = store.queueTaskMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "orchestrator",
			type: "message",
			text: message,
			expectsReply,
		});

		if (task.status === "cancelled") return false;

		const request = expectsReply
			? `[squad] Main orchestrator requests a direct response:\n${message}\n\nReply directly in your next assistant message. That complete message will be forwarded automatically to the main session.`
			: `[squad] Main orchestrator message:\n${message}`;
		if (this.pool.isRunning(taskId)) {
			if (await this.pool.steer(taskId, request)) {
				store.acknowledgeTaskMessages(this.squadId, taskId, [queued.id]);
				return true;
			}
			// The process may still be completing its current run. Preserve
			// in_progress while it is live; agent_settled will observe the pending
			// mailbox and reopen the same session instead of marking done.
			if (this.pool.isRunning(taskId)) return false;
		}

		await this.reopenTaskForMessage(task);
		if (this.running) {
			await this.reconcile();
			return store.loadPendingTaskMessages(this.squadId, taskId)
				.every((entry) => entry.id !== queued.id);
		}
		return false;
	}

	private hasPendingOrchestratorRequest(taskId: string): boolean {
		let pending = false;
		for (const message of store.loadMessages(this.squadId, taskId)) {
			if (message.from === "orchestrator" && message.expectsReply) pending = true;
			if (message.type === "reply" && message.to === "orchestrator") pending = false;
		}
		return pending;
	}

	/** Pause a running task */
	async pauseTask(taskId: string): Promise<void> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.status === "cancelled") throw new Error(`Task '${taskId}' is cancelled; use resume_task to revive it.`);
		if (this.pool.isRunning(taskId)) {
			await this.pool.steer(taskId, "[squad] Task paused by user. Summarize your current state.");
			// Give agent a moment to respond, then kill
			setTimeout(() => this.pool.kill(taskId), 3000);
		}
		store.updateTaskStatus(this.squadId, taskId, "suspended");
		this.reconcileSuspendedStallAttention();
		this.updateContext();
	}

	/** Add work to this exact squad and schedule it, reconstructing safely after restart. */
	async addTask(task: Task): Promise<void> {
		if (store.loadTask(this.squadId, task.id)) throw new Error(`Task already exists: ${task.id}`);
		store.createTask(this.squadId, task);
		this.reopenSquadForWork();
		await this.start();
		this.updateContext();
	}

	/** Atomically replace one task's dependency list after validating the complete historical DAG. */
	async setDependencies(taskId: string, depends: string[]): Promise<void> {
		const tasks = store.loadAllTasks(this.squadId);
		const target = tasks.find((task) => task.id === taskId);
		if (!target) throw new Error(`Task not found: ${taskId}`);
		if (target.status === "in_progress") {
			throw new Error(`Cannot edit dependencies for in_progress task '${taskId}'; pause or cancel it first.`);
		}
		if (target.status === "done") {
			throw new Error(`Cannot edit dependencies for done task '${taskId}'; resume it first so descendant invalidation remains authoritative.`);
		}

		const duplicate = depends.find((dependency, index) => depends.indexOf(dependency) !== index);
		if (duplicate) throw new Error(`Duplicate dependency '${duplicate}' for task '${taskId}'.`);
		if (depends.includes(taskId)) throw new Error(`Task '${taskId}' cannot depend on itself.`);
		const known = new Set(tasks.map((task) => task.id));
		const unknown = depends.filter((dependency) => !known.has(dependency));
		if (unknown.length > 0) throw new Error(`Unknown dependency task(s): ${unknown.join(", ")}.`);

		const wasRunnable = target.status === "pending" && target.depends.every(
			(dependency) => tasks.find((candidate) => candidate.id === dependency)?.status === "done",
		);
		const graph = new Map(tasks.map((task) => [task.id, [...task.depends]]));
		graph.set(taskId, [...depends]);
		for (const [id, dependencies] of graph) {
			const seen = new Set<string>();
			for (const dependency of dependencies) {
				if (!known.has(dependency)) throw new Error(`Task '${id}' depends on unknown task '${dependency}'.`);
				if (dependency === id) throw new Error(`Task '${id}' cannot depend on itself.`);
				if (seen.has(dependency)) throw new Error(`Duplicate dependency '${dependency}' for task '${id}'.`);
				seen.add(dependency);
			}
		}
		const color = new Map<string, 0 | 1 | 2>();
		const stack: string[] = [];
		const visit = (id: string): void => {
			const state = color.get(id) ?? 0;
			if (state === 2) return;
			if (state === 1) {
				const start = stack.indexOf(id);
				const cycle = [...stack.slice(start), id];
				throw new Error(`Dependency cycle detected: ${cycle.join(" -> ")}`);
			}
			color.set(id, 1);
			stack.push(id);
			for (const dependency of graph.get(id) ?? []) visit(dependency);
			stack.pop();
			color.set(id, 2);
		};
		for (const id of graph.keys()) visit(id);

		target.depends = [...depends];
		if (target.status === "pending" || target.status === "blocked") {
			target.status = depends.every(
				(dependency) => tasks.find((candidate) => candidate.id === dependency)?.status === "done",
			) ? "pending" : "blocked";
		}
		store.saveTask(this.squadId, target);
		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "system",
			type: "status",
			text: `Dependencies updated: ${depends.length > 0 ? depends.join(", ") : "none"}`,
		});

		this.killBlockedAgents();
		const squad = store.loadSquad(this.squadId);
		const runnable = target.status === "pending" && target.depends.every(
			(dependency) => tasks.find((candidate) => candidate.id === dependency)?.status === "done",
		);
		const createdRunnableWork = runnable && !wasRunnable;
		if (createdRunnableWork && squad && squad.status !== "paused" && squad.status !== "running") {
			this.reopenSquadForWork();
			await this.start();
		} else if (squad?.status === "running") {
			await this.start();
		}
		this.updateContext();
	}

	/** Resume one exact task. Reopening completed work invalidates descendants and
	 * archives a completed active review before fresh scheduling begins. */
	async resumeTask(taskId: string): Promise<"resumed" | "already_running"> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		// Explicit resume grants a fresh spawn-retry budget (provider recovery).
		this.spawnRetryCounts.delete(`spawn-retry:${taskId}`);
		const live = this.pool.isRunning(taskId);
		if (task.status === "in_progress" && live) return "already_running";
		if (live) throw new Error(`Task '${taskId}' has a live child but durable status '${task.status}'; no duplicate resume was started.`);
		if (task.status === "done") await this.invalidateDescendants(taskId);
		const tasks = store.loadAllTasks(this.squadId);
		const dependenciesDone = task.depends.every(
			(depId) => tasks.find((candidate) => candidate.id === depId)?.status === "done",
		);
		store.updateTaskStatus(this.squadId, taskId, dependenciesDone ? "pending" : "blocked", {
			error: null,
			completed: null,
		});
		this.reopenSquadForWork();
		await this.start();
		this.updateContext();
		return "resumed";
	}

	/** Mark an exact pending outbox fingerprint delivered after host acceptance. */
	acknowledgeSuspendedStall(fingerprint: string): boolean {
		const squad = store.loadSquad(this.squadId);
		const attention = squad?.suspendedStallAttention;
		if (!squad || !attention || attention.fingerprint !== fingerprint || attention.delivery !== "pending") return false;
		attention.delivery = "delivered";
		attention.deliveredAt = store.now();
		store.saveSquad(squad);
		return true;
	}

	/**
	 * Mark a task done through the normal completion flow (admin/recovery path).
	 * Unlike editing the store directly, this fires auto-unblock and scheduling,
	 * so dependents transition pending → running. Skips the QA rework check —
	 * a human/main agent marking a task done is an explicit override.
	 */
	async completeTask(taskId: string, output?: string): Promise<void> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.status === "done") return;
		if (task.status === "cancelled") throw new Error(`Task '${taskId}' is cancelled; resume it before marking it done.`);
		const squad = store.loadSquad(this.squadId);
		if (squad && !validateTaskSpecAttestation(squad, task)) throw new Error(`Task '${taskId}' cannot complete: missing or invalid canonical spec read attestation.`);

		if (this.pool.isRunning(taskId)) {
			await this.pool.kill(taskId);
		}

		store.updateTaskStatus(this.squadId, taskId, "done", {
			output: output ?? task.output ?? "Marked done (recovered/admin)",
			error: null,
			completed: store.now(),
		});
		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "system",
			type: "done",
			text: "Task marked done (recovered/admin)",
		});
		this.emit({
			type: "task_completed",
			squadId: this.squadId,
			taskId,
			agentName: task.agent,
			message: output ?? "",
		});

		this.autoUnblock(taskId);
		await this.reconcile();

		const freshTasks = store.loadAllTasks(this.squadId);
		const freshSquad = store.loadSquad(this.squadId);
		if (freshSquad) this.checkSquadCompletion(freshTasks, freshSquad);
		this.updateContext();
	}

	/** Cancel one task after ensuring no live historical task still depends on it. */
	async cancelTask(taskId: string): Promise<void> {
		const task = store.loadTask(this.squadId, taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (task.status === "cancelled") return;

		const dependents = store.loadAllTasks(this.squadId)
			.filter((candidate) => candidate.status !== "cancelled" && candidate.depends.includes(taskId))
			.sort((left, right) => left.id.localeCompare(right.id));
		if (dependents.length > 0) {
			throw new Error([
				`Cannot cancel task '${taskId}': it is still required by:`,
				...dependents.map((dependent) => `- ${dependent.id} [${dependent.status}]`),
				"",
				'Update each dependent first with squad_modify action "set_dependencies",',
				"then retry cancel_task. Cancellation does not rewrite or cascade dependencies.",
			].join("\n"));
		}

		if (this.pool.isRunning(taskId)) await this.pool.kill(taskId);
		store.updateTaskStatus(this.squadId, taskId, "cancelled", {
			error: null,
			completed: store.now(),
		});
		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "system",
			type: "status",
			text: "Task cancelled by orchestrator",
		});

		const squad = store.loadSquad(this.squadId);
		if (squad) {
			if (squad.status === "done" || (squad.status === "review" && squad.review?.status !== "pending")) {
				beginOrchestratorRework(squad);
				store.saveSquad(squad);
			}
			this.reconcileSuspendedStallAttention();
			this.checkSquadCompletion(store.loadAllTasks(this.squadId), squad);
		}
		this.updateContext();
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private reconcileSuspendedStallAttention(): void {
		const squad = store.loadSquad(this.squadId);
		if (!squad) return;
		const derived = deriveSuspendedStall(store.loadAllTasks(this.squadId));
		if (!derived) {
			if (squad.suspendedStallAttention) {
				delete squad.suspendedStallAttention;
				store.saveSquad(squad);
			}
			this.attentionEmittedFingerprint = null;
			return;
		}

		let attention = squad.suspendedStallAttention;
		if (!attention || attention.fingerprint !== derived.fingerprint) {
			attention = {
				kind: "suspended_stall",
				...derived,
				detectedAt: store.now(),
				delivery: "pending",
				deliveredAt: null,
			};
			squad.suspendedStallAttention = attention;
			store.saveSquad(squad);
			this.attentionEmittedFingerprint = null;
		}
		if (attention.delivery === "pending" && this.attentionEmittedFingerprint !== attention.fingerprint) {
			this.attentionEmittedFingerprint = attention.fingerprint;
			this.emit({ type: "suspended_stall", squadId: this.squadId, data: attention });
		}
	}

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
