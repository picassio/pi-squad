import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupSquadWidget } from "./panel/squad-widget.js";
import { activateSquadView, openPanel } from "./panel-runtime.js";
import { buildOrchestratorReviewGate } from "./review.js";
import { reviveScheduler } from "./scheduler-runtime.js";
import * as store from "./store.js";
import type { Squad } from "./types.js";
import { DISABLED_GUIDANCE, focusSquad, formatTaskProgress, runtime } from "./runtime.js";

export function registerLifecycle(pi: ExtensionAPI, squadSkillPaths: string[]): void {
/** Register a dynamically gated Ctrl+Q path; disabled mode can only show guidance. */
const registerTerminalPanelToggle = (ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	ctx.ui.onTerminalInput((data) => {
		if (data !== "\x11") return undefined;
		if (!runtime.squadEnabled) {
			ctx.ui.notify(DISABLED_GUIDANCE, "warning");
			return { consume: true };
		}
		// If overlay is already open, let the panel's own handler deal with it.
		if (runtime.overlayOpen) return undefined;
		if (!runtime.activeSquadId) {
			const latest = store.findLatestSquad(ctx.cwd)
				|| store.listSquads().map((id) => store.loadSquad(id)).filter((s): s is Squad => s !== null).sort((a, b) => b.created.localeCompare(a.created))[0];
			if (latest) activateSquadView(latest.id, ctx);
			else {
				ctx.ui.notify("No squads found. Use /squad or the squad tool.", "info");
				return { consume: true };
			}
		}
		if (runtime.activeSquadId) {
			openPanel(pi, ctx, reviveScheduler(pi, runtime.activeSquadId, squadSkillPaths), runtime.activeSquadId, squadSkillPaths);
		}
		return { consume: true };
	});
};

// =========================================================================
// Session Lifecycle
// =========================================================================

pi.on("session_start", async (_event, ctx) => {
	// Re-read before touching focus, widgets, runtime.schedulers, or persisted work.
	runtime.squadEnabled = store.loadSquadSettings().enabled;
	runtime.uiCtx = ctx;

	// A session replacement may not deliver shutdown first. Never carry a
	// focused squad across projects, and never seed a new widget from stale state.
	runtime.widgetControls?.dispose();
	runtime.widgetControls = null;
	registerTerminalPanelToggle(ctx);
	if (!runtime.squadEnabled) {
		runtime.widgetState.enabled = false;
		focusSquad(null);
		return;
	}
	runtime.widgetState.enabled = true;
	const focused = runtime.activeSquadId ? store.loadSquad(runtime.activeSquadId) : null;
	focusSquad(focused?.cwd === ctx.cwd ? runtime.activeSquadId : null);

	// Install component-based widget
	if (ctx.hasUI) {
		runtime.widgetControls = setupSquadWidget(ctx, runtime.widgetState);
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

	// Audit file-spec evidence on restart. Review/running/failed work is reopened;
	// an explicitly paused squad remains paused and suspended/cancelled tasks stay untouched.
	for (const squad of store.listSquadsForProject(ctx.cwd).filter((candidate) => candidate.spec && ["running", "failed", "paused", "review"].includes(candidate.status))) {
		const scheduler = reviveScheduler(pi, squad.id, squadSkillPaths);
		const invalid = await scheduler.auditSpecAttestations();
		if (invalid.length > 0 && squad.status !== "paused") await scheduler.start();
	}

	// Reconstruct runtime.schedulers for explicit-suspension stalls without resuming any
	// task. Reconcile derives/persists a missing outbox record and emits only a
	// pending fingerprint; delivered attention remains durable and silent.
	const suspensionCandidates = store.listSquadsForProject(ctx.cwd)
		.filter((squad) => Boolean(squad.suspendedStallAttention) || store.loadAllTasks(squad.id).some((task) => task.status === "suspended"));
	for (const squad of suspensionCandidates) {
		const scheduler = reviveScheduler(pi, squad.id, squadSkillPaths);
		await scheduler.start();
	}

	// Mailbox recovery is automatic after extension/main-process restart. Scan
	// every project squad (including accepted done squads) because a crash can
	// occur after the mailbox-first write but before the squad/task is reopened.
	const pendingMailSquads = store.listSquadsForProject(ctx.cwd)
		.filter((squad) => store.loadAllTasks(squad.id)
			.some((task) => task.status !== "cancelled" && store.loadPendingTaskMessages(squad.id, task.id).length > 0))
		.sort((a, b) => b.created.localeCompare(a.created));
	for (const squad of pendingMailSquads) {
		const scheduler = reviveScheduler(pi, squad.id, squadSkillPaths);
		await scheduler.start();
	}
	if (pendingMailSquads.length > 0) focusSquad(pendingMailSquads[0].id);

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
				content: `[squad] Found paused squad "${squad.id}" (${squad.spec ? `file spec sha256=${squad.spec.sha256}` : squad.goal}) — ${formatTaskProgress(tasks)}. ` +
					`Use squad_modify with action "resume" to continue, or start a new squad.`,
				display: true,
			});
		}
	}

	// Restore pending acceptance gates after a main-session restart. Review is
	// persisted state, not a one-shot completion message that can be missed.
	const pendingReviews = store.findActiveSquads()
		.filter((s) => s.cwd === ctx.cwd && s.status === "review");
	if (pendingReviews.length > 0) {
		const squad = pendingReviews.sort((a, b) => b.created.localeCompare(a.created))[0];
		focusSquad(squad.id);
		const tasks = store.loadAllTasks(squad.id);
		pi.sendMessage({
			customType: "squad-review-required",
			content: `[squad] Restored mandatory orchestrator review for "${squad.id}" after session restart. The work remains untrusted and not accepted.\n\n${buildOrchestratorReviewGate(squad, tasks)}`,
			display: true,
		});
	}

});

pi.on("session_shutdown", async () => {
	focusSquad(null);
	runtime.widgetControls?.dispose();
	runtime.widgetControls = null;
	for (const [id, sched] of runtime.schedulers) {
		await sched.stop();
	}
	runtime.schedulers.clear();
	runtime.uiCtx = null;
});

}
