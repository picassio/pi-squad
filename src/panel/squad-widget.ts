/**
 * squad-widget.ts — Component-based live widget for squad status.
 *
 * Uses the component factory overload of setWidget() (like pi-interactive-shell)
 * so rendering is dynamic with access to TUI and Theme, and updates are triggered
 * via tui.requestRender() instead of polling intervals.
 *
 * Inspired by pi-session-hud's stale detection: shows elapsed time per
 * running task and marks stale tasks (>3min with no new messages).
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

/** Truncate a line to fit within the widget width */
function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(line, width, "…");
}
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
 *
 * IMPORTANT: render() must be pure — no side effects like setStatus() inside render.
 * Status bar is updated separately via updateStatusBar() called from requestUpdate().
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
	let themeRef: Theme | null = null;
	let durationTimer: ReturnType<typeof setInterval> | null = null;
	/** Queue a render — if TUI not ready yet, it'll render on first paint anyway */
	let pendingUpdate = false;

	/** Update status bar — called OUTSIDE of render to avoid side effects */
	function updateStatusBar(): void {
		if (!state.enabled || !state.squadId || !themeRef) {
			ctx.ui.setStatus("squad", undefined);
			return;
		}
		const tasks = store.loadAllTasks(state.squadId);
		const squad = store.loadSquad(state.squadId);
		if (!squad || tasks.length === 0) {
			ctx.ui.setStatus("squad", undefined);
			return;
		}
		const th = themeRef;
		const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
		const doneCount = tasks.filter((t) => t.status === "done").length;
		const statusText = squad.status === "done"
			? th.fg("success", `✓ squad ${doneCount}/${tasks.length}`)
			: squad.status === "failed"
			? th.fg("error", `✗ squad ${doneCount}/${tasks.length}`)
			: th.fg("accent", `⏳ squad ${doneCount}/${tasks.length} $${totalCost.toFixed(2)}`);
		ctx.ui.setStatus("squad", statusText);
	}

	const requestUpdate = () => {
		// Update status bar outside of render
		updateStatusBar();
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
			themeRef = theme;
			manageDurationTimer();
			// Flush any updates that arrived before TUI was ready
			if (pendingUpdate) {
				pendingUpdate = false;
				queueMicrotask(() => {
					updateStatusBar();
					tuiRef?.requestRender();
				});
			}
			return {
				render(width: number): string[] {
					if (!state.enabled || !state.squadId) return [];

					const th = theme;
					const tasks = store.loadAllTasks(state.squadId);
					const squad = store.loadSquad(state.squadId);
					if (!squad || tasks.length === 0) return [];

					// Cap widget height: header (1) + tasks + overflow note
					// On small terminals, show max 3 tasks inline; on large, up to 8
					const termRows = tui.terminal.rows || 24;
					const maxTaskLines = termRows < 30 ? 3 : termRows < 50 ? 5 : 8;

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

					// Task lines (capped to maxTaskLines)
					const visibleTasks = tasks.slice(0, maxTaskLines);
					for (const task of visibleTasks) {
						const icon = statusIcon(task.status, th);
						let line = `  ${icon} ${th.fg("muted", task.id)} ${th.fg("dim", `(${task.agent})`)}`;

						if (task.status === "done" && task.output) {
							// Show completion time if available
							let timeStr = "";
							if (task.started && task.completed) {
								const dur = new Date(task.completed).getTime() - new Date(task.started).getTime();
								timeStr = th.fg("dim", ` ${formatElapsed(dur)}`);
							}
							line += `${timeStr} ${th.fg("dim", task.output.split("\n")[0].slice(0, 50))}`;
						} else if (task.status === "failed" && task.error) {
							line += ` ${th.fg("error", task.error.slice(0, 50))}`;
						} else if (task.status === "in_progress") {
							// Show elapsed time for running task
							const runningFor = task.started
								? Date.now() - new Date(task.started).getTime()
								: 0;
							const timeColor = runningFor > 180_000 ? "warning" : "dim"; // >3min = warning
							line += ` ${th.fg(timeColor as any, formatElapsed(runningFor))}`;

							// Show recent activity (last tool call)
							const messages = store.loadMessages(state.squadId!, task.id);
							const lastTool = [...messages].reverse().find(m => m.type === "tool");
							if (lastTool) {
								const detail = lastTool.args?.path || lastTool.args?.command || "";
								const toolStr = `→ ${lastTool.name || lastTool.text}`;
								line += ` ${th.fg("dim", (detail ? `${toolStr} ${detail}` : toolStr).slice(0, 40))}`;

								// Stale detection: if last message is >2min old, show ⏳
								const lastMsg = messages[messages.length - 1];
								if (lastMsg) {
									const msgAge = Date.now() - new Date(lastMsg.ts).getTime();
									if (msgAge > 120_000) {
										line += ` ${th.fg("warning", `⏳ ${formatElapsed(msgAge)} idle`)}`;
									}
								}
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

					// Show overflow indicator if tasks are hidden
					if (tasks.length > maxTaskLines) {
						const hidden = tasks.length - maxTaskLines;
						lines.push(`  ${th.fg("dim", `  +${hidden} more · ^q detail`)}`);
					}

					// CRITICAL: truncate all lines to fit terminal width.
					// pi-tui throws a hard crash if any line exceeds width.
					return lines.map((line) => fitLine(line, width));
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
