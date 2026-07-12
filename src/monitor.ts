/**
 * monitor.ts — Health monitoring for running agents.
 *
 * Periodically checks all running agents for:
 * - Idle timeout (no output for N minutes)
 * - Stuck detection (no output for longer)
 * - Loop detection (same tool call repeated)
 * - Hard ceiling (max total runtime)
 * - File conflict warnings
 */

import type { AgentPool } from "./agent-pool.js";
import type { HealthStatus } from "./types.js";
import { debug } from "./logger.js";

// ============================================================================
// Config
// ============================================================================

/** Env-overridable for testing (PI_SQUAD_IDLE_MS etc.) */
function envMs(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

const IDLE_WARNING_MS = envMs("PI_SQUAD_IDLE_MS", 3 * 60 * 1000); // no output → warn
const STUCK_TIMEOUT_MS = envMs("PI_SQUAD_STUCK_MS", 5 * 60 * 1000); // no output → intervene
const HARD_CEILING_MS = envMs("PI_SQUAD_CEILING_MS", 30 * 60 * 1000); // total → force stop
const LOOP_THRESHOLD = 5; // same tool call 5x → looping
const POLL_INTERVAL_MS = envMs("PI_SQUAD_POLL_MS", 30 * 1000); // check interval

// ============================================================================
// Types
// ============================================================================

export type MonitorActionType = "steer" | "abort" | "escalate";

export interface MonitorAction {
	type: MonitorActionType;
	taskId: string;
	agentName: string;
	reason: string;
	message: string;
}

export type MonitorActionListener = (action: MonitorAction) => void;

// ============================================================================
// Monitor
// ============================================================================

export class Monitor {
	private pool: AgentPool;
	private squadId: string;
	private interval: ReturnType<typeof setInterval> | null = null;
	private listeners: MonitorActionListener[] = [];
	/** Track which agents have been warned (to avoid repeated warnings) */
	private warned = new Set<string>();
	/** Track which agents have been steered for stuck (to avoid repeated steers) */
	private stuckSteered = new Set<string>();
	/** Track which tasks have been escalated (one escalation per stuck episode) */
	private escalated = new Set<string>();

	constructor(pool: AgentPool, squadId: string) {
		this.pool = pool;
		this.squadId = squadId;
	}

	/** Subscribe to monitor actions */
	onAction(listener: MonitorActionListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx !== -1) this.listeners.splice(idx, 1);
		};
	}

	private emit(action: MonitorAction): void {
		for (const listener of this.listeners) {
			try {
				listener(action);
			} catch {
				/* ignore */
			}
		}
	}

	/** Start periodic health checks */
	start(): void {
		if (this.interval) return;
		this.interval = setInterval(() => this.checkAll(), POLL_INTERVAL_MS);
	}

	/** Stop monitoring */
	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		this.warned.clear();
		this.stuckSteered.clear();
		this.escalated.clear();
	}

	/** Check all running agents */
	private checkAll(): void {
		for (const agentName of this.pool.getRunningAgents()) {
			const taskId = this.pool.getTaskIdForAgent(agentName);
			if (!taskId) continue;

			const activity = this.pool.getActivity(taskId);
			if (!activity) continue;

			const health = this.checkHealth(activity);
			this.handleHealth(taskId, agentName, health);
		}
	}

	/** Determine health status from activity data */
	checkHealth(activity: {
		lastOutputTs: number;
		startedAt: number;
		recentToolCalls: string[];
	}): HealthStatus {
		const now = Date.now();
		const idleMs = now - activity.lastOutputTs;
		const totalMs = now - activity.startedAt;

		// Loop detection: last N tool calls are identical
		const recent = activity.recentToolCalls.slice(-LOOP_THRESHOLD);
		if (recent.length >= LOOP_THRESHOLD) {
			const unique = new Set(recent);
			if (unique.size === 1) return "looping";
		}

		if (totalMs >= HARD_CEILING_MS) return "exceeded_ceiling";
		if (idleMs >= STUCK_TIMEOUT_MS) return "stuck";
		if (idleMs >= IDLE_WARNING_MS) return "idle_warning";

		return "healthy";
	}

	/** Take action based on health status */
	private handleHealth(taskId: string, agentName: string, status: HealthStatus): void {
		if (status !== "healthy") debug("squad-monitor", `${taskId} (${agentName}): ${status}`);
		switch (status) {
			case "healthy":
				// Clear warning flags — a new stuck episode escalates again
				this.warned.delete(taskId);
				this.stuckSteered.delete(taskId);
				this.escalated.delete(taskId);
				break;

			case "idle_warning":
				if (!this.warned.has(taskId)) {
					this.warned.add(taskId);
					this.emit({
						type: "steer",
						taskId,
						agentName,
						reason: "idle",
						message:
							"[squad] You've been idle for a few minutes. What's your status? If you're stuck, say so and I'll help.",
					});
				}
				break;

			case "stuck":
				if (!this.stuckSteered.has(taskId)) {
					this.stuckSteered.add(taskId);
					this.emit({
						type: "steer",
						taskId,
						agentName,
						reason: "stuck",
						message:
							"[squad] You appear stuck — no output for 5 minutes. " +
							"Summarize what you've done and what's blocking you. " +
							"If you can't proceed, state what you need.",
					});
				} else if (!this.escalated.has(taskId)) {
					// Already steered once — escalate, but only once per stuck episode
					this.escalated.add(taskId);
					this.emit({
						type: "escalate",
						taskId,
						agentName,
						reason: `Agent ${agentName} stuck on ${taskId} — no output after intervention`,
						message: "",
					});
				}
				break;

			case "looping":
				this.emit({
					type: "steer",
					taskId,
					agentName,
					reason: "looping",
					message:
						"[squad] You're repeating the same action in a loop. " +
						"Stop and reassess your approach. Try a different strategy.",
				});
				break;

			case "exceeded_ceiling":
				this.emit({
					type: "abort",
					taskId,
					agentName,
					reason: `Agent ${agentName} exceeded time ceiling on ${taskId}`,
					message: "",
				});
				break;
		}
	}
}
