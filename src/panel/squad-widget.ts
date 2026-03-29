/**
 * squad-widget.ts — Component-based live widget for squad status.
 *
 * Uses the component factory overload of setWidget() (like pi-interactive-shell)
 * so rendering is dynamic with access to TUI and Theme, and updates are triggered
 * via tui.requestRender() instead of polling intervals.
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Task, TaskStatus } from "../types.js";
import * as store from "../store.js";

function statusIcon(status: TaskStatus, th: Theme): string {
	switch (status) {
		case "done": return th.fg("success", "✓");
		case "in_progress": return th.fg("warning", "⏳");
		case "blocked": return th.fg("muted", "◻");
		case "failed": return th.fg("error", "✗");
		case "suspended": return th.fg("muted", "⏸");
		default: return th.fg("dim", "·");
	}
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h${m % 60}m`;
	if (m > 0) return `${m}m${s % 60}s`;
	return `${s}s`;
}

export interface SquadWidgetState {
	squadId: string | null;
	enabled: boolean;
}

/**
 * Create and install the squad widget as a component factory.
 * Returns control functions for the caller.
 */
export function setupSquadWidget(
	ctx: { ui: { setWidget: Function; setStatus: Function }; hasUI?: boolean },
	state: SquadWidgetState,
): {
	/** Force a render update (call on scheduler events) */
	requestUpdate: () => void;
	/** Remove the widget */
	dispose: () => void;
} {
	if (!ctx.hasUI) return { requestUpdate: () => {}, dispose: () => {} };

	let tuiRef: TUI | null = null;
	let durationTimer: ReturnType<typeof setInterval> | null = null;
	/** Queue a render — if TUI not ready yet, it'll render on first paint anyway */
	let pendingUpdate = false;

	const requestUpdate = () => {
		if (tuiRef) {
			tuiRef.requestRender();
			pendingUpdate = false;
		} else {
			pendingUpdate = true;
		}
	};

	// Start a timer to update elapsed time every 5s when squad is running
	function manageDurationTimer() {
		if (!state.squadId || !state.enabled) {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			return;
		}
		const squad = store.loadSquad(state.squadId);
		const isActive = squad && (squad.status === "running" || squad.status === "paused");
		if (isActive && !durationTimer) {
			durationTimer = setInterval(requestUpdate, 5000);
		} else if (!isActive && durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	}

	ctx.ui.setWidget(
		"squad-tasks",
		(tui: TUI, theme: Theme): Component & { dispose?(): void } => {
			tuiRef = tui;
			manageDurationTimer();
			// Flush any updates that arrived before TUI was ready
			if (pendingUpdate) {
				pendingUpdate = false;
				queueMicrotask(() => tuiRef?.requestRender());
			}
			return {
				render(width: number): string[] {
					if (!state.enabled || !state.squadId) return [];

					const th = theme;
					const tasks = store.loadAllTasks(state.squadId);
					const squad = store.loadSquad(state.squadId);
					if (!squad || tasks.length === 0) return [];

					const lines: string[] = [];

					// Header line
					const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
					const doneCount = tasks.filter((t) => t.status === "done").length;
					const elapsed = Date.now() - new Date(squad.created).getTime();

					const sIcon = squad.status === "done" ? th.fg("success", "✓")
						: squad.status === "failed" ? th.fg("error", "✗")
						: th.fg("warning", "⏳");

					lines.push(
						`${sIcon} ${th.fg("accent", "squad")} ${th.fg("dim", squad.goal.slice(0, 35))} ` +
						`${th.fg("muted", `${doneCount}/${tasks.length}`)} ` +
						`${th.fg("dim", `$${totalCost.toFixed(2)}`)} ` +
						`${th.fg("dim", formatElapsed(elapsed))} ` +
						`${th.fg("dim", "^q detail · /squad msg")}`
					);

					// Task lines
					for (const task of tasks) {
						const icon = statusIcon(task.status, th);
						let line = `  ${icon} ${th.fg("muted", task.id)} ${th.fg("dim", `(${task.agent})`)}`;

						if (task.status === "done" && task.output) {
							line += ` ${th.fg("dim", task.output.split("\n")[0].slice(0, 50))}`;
						} else if (task.status === "failed" && task.error) {
							line += ` ${th.fg("error", task.error.slice(0, 50))}`;
						} else if (task.status === "in_progress") {
							// Show recent activity
							const messages = store.loadMessages(state.squadId!, task.id);
							const lastTool = [...messages].reverse().find(m => m.type === "tool");
							if (lastTool) {
								const detail = lastTool.args?.path || lastTool.args?.command || "";
								const toolStr = `→ ${lastTool.name || lastTool.text}`;
								line += ` ${th.fg("dim", (detail ? `${toolStr} ${detail}` : toolStr).slice(0, 40))}`;
							}
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

					// Also update status bar
					const statusText = squad.status === "done"
						? th.fg("success", `✓ squad ${doneCount}/${tasks.length}`)
						: squad.status === "failed"
						? th.fg("error", `✗ squad ${doneCount}/${tasks.length}`)
						: th.fg("accent", `⏳ squad ${doneCount}/${tasks.length} $${totalCost.toFixed(2)}`);
					ctx.ui.setStatus("squad", statusText);

					return lines;
				},
				invalidate() {
					manageDurationTimer();
				},
				dispose() {
					if (durationTimer) {
						clearInterval(durationTimer);
						durationTimer = null;
					}
				},
			};
		},
	);

	return {
		requestUpdate,
		dispose() {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
		},
	};
}
