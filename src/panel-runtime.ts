import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SquadPanel, type SquadPanelResult } from "./panel/squad-panel.js";
import { getReviewPresentation } from "./presentation.js";
import type { Scheduler } from "./scheduler.js";
import * as store from "./store.js";
import type { Squad } from "./types.js";
import { DISABLED_GUIDANCE, focusSquad, forceWidgetUpdate, formatTaskProgress, runtime } from "./runtime.js";
import { reviveScheduler } from "./scheduler-runtime.js";

// ============================================================================
// Squad Selection & Activation
// ============================================================================

/**
 * Show an interactive selector to pick a squad.
 * Returns the selected squad or undefined if cancelled.
 */
export async function pickSquad(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
	squads: Squad[],
	showProject = false,
): Promise<Squad | undefined> {
	if (squads.length === 0) return undefined;

	const options = squads.map((s) => {
		const tasks = store.loadAllTasks(s.id);
		const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
		const review = getReviewPresentation(s);
		const icon = review?.icon ?? (s.status === "done" ? "✓" : s.status === "running" ? "⏳" : s.status === "failed" ? "✗" : "·");
		const acceptance = review ? ` ${review.label}` : ` [${s.status}]`;
		const project = showProject ? ` — ${s.cwd.split("/").pop()}` : "";
		return `${icon} ${s.id}${acceptance} · ${formatTaskProgress(tasks)} $${cost.toFixed(2)}${project}`;
	});

	const choice = await ctx.ui.select("Select a squad", options);
	if (choice === undefined) return undefined;

	const idx = options.indexOf(choice);
	return idx >= 0 ? squads[idx] : undefined;
}

/**
 * Activate a squad for viewing in this session.
 * Sets runtime.activeSquadId, starts widget, shows notification.
 * Does NOT start a scheduler (view-only unless squad needs resuming).
 */
export function activateSquadView(squadId: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | import("@earendil-works/pi-coding-agent").ExtensionCommandContext): void {
	if (!runtime.squadEnabled) {
		ctx.ui.notify(DISABLED_GUIDANCE, "warning");
		return;
	}
	const squad = store.loadSquad(squadId);
	if (!squad) {
		ctx.ui.notify(`Squad '${squadId}' not found`, "error");
		return;
	}

	// Selection is one atomic focus operation: panel, widget, status, and tools
	// must all target this exact squad before control returns to the caller.
	focusSquad(squadId);

	// Compact notification — widget already shows full task details.
	// Avoid large multi-line notifications that can break TUI layout.
	const tasks = store.loadAllTasks(squadId);
	const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
	ctx.ui.notify(`Viewing: ${squad.id} [${squad.status}] ${formatTaskProgress(tasks)} $${cost.toFixed(2)}`, "info");
}

// ============================================================================
// Panel — overlay via ctx.ui.custom() with proper done() lifecycle
// ============================================================================

/**
 * Open the squad panel overlay.
 * Uses the pi-interactive-shell pattern: ctx.ui.custom() returns a Promise
 * that resolves when done() is called. The panel calls done() on close.
 */
export function openPanel(
	pi: ExtensionAPI,
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	scheduler: Scheduler,
	squadId: string,
	skillPaths: string[],
): void {
	if (!runtime.squadEnabled) {
		ctx.ui.notify(DISABLED_GUIDANCE, "warning");
		return;
	}
	if (runtime.overlayOpen) return;
	// Opening details also establishes authoritative focus. This covers callers
	// that reconstructed or targeted a scheduler without going through selector UI.
	focusSquad(squadId);
	runtime.overlayOpen = true;

	// The promise resolves when the panel calls done()
	const panelPromise = ctx.ui.custom<SquadPanelResult>(
		(tui, theme, _kb, done) => {
			const panel = new SquadPanel(
				tui,
				theme,
				scheduler,
				squadId,
				done,
				() => runtime.squadEnabled,
				() => ctx.ui.notify(DISABLED_GUIDANCE, "warning"),
			);
			runtime.closeOverlay = () => panel.close();

			// Wire up message sending from panel
			panel.onSendMessage = async (taskId: string, _prefill: string) => {
				if (!runtime.squadEnabled) {
					ctx.ui.notify(DISABLED_GUIDANCE, "warning");
					return;
				}
				const task = store.loadTask(squadId, taskId);
				const agentName = task?.agent || taskId;
				const input = await ctx.ui.input(`Message to ${agentName}`, "Type your message...");
				if (!runtime.squadEnabled) {
					ctx.ui.notify(DISABLED_GUIDANCE, "warning");
					return;
				}
				if (input) {
					const panelSched = reviveScheduler(pi, squadId, skillPaths);
					await panelSched.start();
					const delivered = await panelSched.sendHumanMessage(taskId, input);
					ctx.ui.notify(
						delivered ? `Sent to ${agentName}: "${input}"` : `Queued durably for ${taskId}`,
						"info",
					);
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
		runtime.overlayOpen = false;
		runtime.closeOverlay = null;
		forceWidgetUpdate();
	}).catch(() => {
		runtime.overlayOpen = false;
		runtime.closeOverlay = null;
	});
}

