import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logError } from "./logger.js";
import { buildCompletionSummary, buildFailureSummary } from "./report.js";
import { buildOrchestratorReviewGate } from "./review.js";
import { Scheduler, formatSuspendedStallAttention, type SchedulerEvent } from "./scheduler.js";
import * as store from "./store.js";
import type { SuspendedStallAttention } from "./types.js";
import { forceWidgetUpdate, formatTaskProgress, focusSquad, repairFocusAfterCancellation, runtime, schedulerSpawnContext } from "./runtime.js";

/** Wire one scheduler to durable main-session notifications. */
export function wireSchedulerEvents(pi: ExtensionAPI, scheduler: Scheduler, squadId: string): void {
	scheduler.onEvent((event: SchedulerEvent) => {
		// Durable scheduler state remains authoritative, but disabled mode suppresses
		// late operational UI, acknowledgements, focus, and ordinary notifications.
		if (!runtime.squadEnabled) return;
		forceWidgetUpdate();
		switch (event.type) {
			case "squad_review_required": {
				const tasks = store.loadAllTasks(squadId);
				const squad = store.loadSquad(squadId);
				const summary = buildCompletionSummary(tasks, squad?.cwd);
				const totalCost = tasks.reduce((sum, task) => sum + task.usage.cost, 0);
				scheduler.updateContext();
				if (!squad) break;
				try {
					pi.sendMessage({
						customType: "squad-review-required",
						content: `[squad] TASK EXECUTION FINISHED for "${squadId}" — WORK IS UNTRUSTED AND NOT YET ACCEPTED.\n\n` +
							`Squad claims (review inputs only):\n${summary}\n\n` +
							`Total cost: $${totalCost.toFixed(4)}\n\n` +
							buildOrchestratorReviewGate(squad, tasks),
						display: true,
					}, { triggerTurn: true, deliverAs: "followUp" });
					// Record durable delivery so reconcile stops re-raising the gate.
					// An unrecorded emission (throw here, or the disabled-mode drop
					// above) is re-emitted by the next reconcile pass.
					const fresh = store.loadSquad(squadId);
					if (fresh?.review?.status === "pending" && !fresh.review.notifiedAt) {
						fresh.review.notifiedAt = store.now();
						store.saveSquad(fresh);
					}
				} catch (error) {
					logError("squad-scheduler", `review-required delivery failed for ${squadId}: ${(error as Error).message}`);
				}
				// The followUp above waits for the current main run to settle. Surface
				// the pending gate immediately in the TUI so a long/stalled run cannot
				// hide it for hours.
				try {
					if (runtime.uiCtx?.hasUI) runtime.uiCtx.ui.notify(`[squad] "${squadId}" finished — awaiting your independent review (report queued for end of current turn)`, "info");
				} catch { /* toast is best-effort */ }
				// Keep the settled scheduler addressable. A later exact-task message
				// can reopen the task immediately on its bound durable Pi session.
				break;
			}
			case "suspended_stall": {
				try {
					const attention = event.data as SuspendedStallAttention;
					pi.sendMessage({
						customType: `squad-suspended-stall:${squadId}:${attention.fingerprint}`,
						content: formatSuspendedStallAttention(squadId, attention),
						display: true,
					}, { triggerTurn: true, deliverAs: "followUp" });
					scheduler.acknowledgeSuspendedStall(attention.fingerprint);
				} catch (error) {
					logError("squad-scheduler", `suspended-stall delivery failed for ${squadId}: ${(error as Error).message}`);
				}
				break;
			}
			case "task_failed": {
				// A task died terminally while the squad continues. Without this the
				// main session learns about individual failures only when the whole
				// squad later stalls or finishes. When no runnable work remains the
				// imminent squad_failed event carries the failure summary instead, so
				// skip the task-level message to avoid duplicate notifications.
				try {
					const tasks = store.loadAllTasks(squadId);
					const squadContinues = tasks.some((task) => task.status === "in_progress" || task.status === "pending");
					if (!squadContinues) break;
					const failed = tasks.find((task) => task.id === event.taskId);
					pi.sendMessage({
						customType: "squad-task-failed",
						content: `[squad] Task '${event.taskId}'${failed ? ` (${failed.agent})` : ""} FAILED in '${squadId}' while other tasks continue.\n` +
							`Error: ${event.message ?? failed?.error ?? "unknown"}\n` +
							`Dependents of this task stay blocked. Repair now with squad_modify — resume_task to retry it, set_dependencies to reroute, or cancel_task if obsolete — or the squad will stall after the remaining tasks finish.`,
						display: true,
					}, { triggerTurn: true, deliverAs: "followUp" });
				} catch (error) {
					logError("squad-scheduler", `task-failed delivery failed for ${squadId}/${event.taskId}: ${(error as Error).message}`);
				}
				break;
			}
			case "squad_failed": {
				const tasks = store.loadAllTasks(squadId);
				const failed = tasks.filter((task) => task.status === "failed");
				pi.sendMessage({
					customType: "squad-failed",
					content: `[squad] Squad "${squadId}" has stalled. ` +
						`${formatTaskProgress(tasks)}, ${failed.length} failed.\n` +
						`Failed: ${buildFailureSummary(tasks)}\n` +
						"Use squad_status for details or squad_modify to adjust.",
					display: true,
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			}
			case "orchestrator_reply":
				pi.sendMessage({
					customType: "squad-agent-reply",
					content: `[squad] Direct reply from '${event.agentName}' on task '${event.taskId}':\n${event.message}`,
					display: true,
				}, { triggerTurn: true, deliverAs: "followUp" });
				break;
			case "escalation":
				pi.sendMessage({
					customType: "squad-escalation",
					content: `[squad] Agent '${event.agentName}' on task '${event.taskId}' needs attention:\n` +
						`${event.message}\n\nReply to me and I'll forward your answer, or use the squad panel.`,
					display: true,
				}, { triggerTurn: true });
				break;
		}
	});
}

/** Cancel one persisted exact squad without ever inferring or changing focus. */
export async function cancelExactSquad(squadId: string, skillPaths: string[]): Promise<boolean> {
	const squad = store.loadSquad(squadId);
	if (!squad) return false;
	const live = runtime.schedulers.get(squadId);
	if (live) await live.stop();
	else await new Scheduler(squadId, skillPaths, schedulerSpawnContext).stop();
	const fresh = store.loadSquad(squadId);
	if (fresh) {
		fresh.status = "failed";
		delete fresh.suspendedStallAttention;
		store.saveSquad(fresh);
	}
	runtime.schedulers.delete(squadId);
	repairFocusAfterCancellation(squadId);
	return true;
}

/** Reconstruct one exact persisted squad without changing focus or starting work. */
export function reviveScheduler(pi: ExtensionAPI, squadId: string, skillPaths: string[]): Scheduler {
	let scheduler = runtime.schedulers.get(squadId);
	if (!scheduler) {
		scheduler = new Scheduler(squadId, skillPaths, schedulerSpawnContext);
		runtime.schedulers.set(squadId, scheduler);
		wireSchedulerEvents(pi, scheduler, squadId);
	}
	return scheduler;
}

/** Reconstruct and focus one exact persisted squad without creating/linking another. */
export function ensureScheduler(pi: ExtensionAPI, squadId: string, skillPaths: string[]): Scheduler {
	const scheduler = reviveScheduler(pi, squadId, skillPaths);
	focusSquad(squadId);
	return scheduler;
}
