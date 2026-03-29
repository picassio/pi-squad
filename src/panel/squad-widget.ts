/**
 * squad-widget.ts — Simple string[] widget for squad status.
 *
 * Uses the simple setWidget(key, string[]) API which pi-tui handles
 * reliably. Component-based widgets with variable height cause TUI
 * layout corruption.
 *
 * Updates are pushed by calling requestUpdate() which rebuilds the
 * string[] and calls setWidget() again.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TaskStatus } from "../types.js";
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
 * Set up the squad widget. Returns control functions.
 * Uses simple string[] setWidget — no component factory.
 */
export function setupSquadWidget(
	ctx: { ui: { setWidget: Function; setStatus: Function; [key: string]: any }; hasUI?: boolean },
	state: SquadWidgetState,
): {
	requestUpdate: () => void;
	dispose: () => void;
} {
	if (!ctx.hasUI) return { requestUpdate: () => {}, dispose: () => {} };

	let durationTimer: ReturnType<typeof setInterval> | null = null;
	let renderTimer: ReturnType<typeof setTimeout> | null = null;
	/** Cache key to skip redundant setWidget calls */
	let lastCacheKey = "";

	function render(): void {
		if (!state.enabled || !state.squadId) {
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
			return;
		}

		const th = ctx.ui.theme;
		const tasks = store.loadAllTasks(state.squadId);
		const squad = store.loadSquad(state.squadId);
		if (!squad || tasks.length === 0) {
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
			return;
		}

		const lines: string[] = [];
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

		// Cap visible tasks based on total count
		const maxVisible = tasks.length > 6 ? 4 : tasks.length;
		const visibleTasks = tasks.slice(0, maxVisible);

		for (const task of visibleTasks) {
			const icon = statusIcon(task.status, th);
			let line = `  ${icon} ${th.fg("muted", task.id)} ${th.fg("dim", `(${task.agent})`)}`;

			if (task.status === "done" && task.output) {
				let timeStr = "";
				if (task.started && task.completed) {
					const dur = new Date(task.completed).getTime() - new Date(task.started).getTime();
					timeStr = ` ${formatElapsed(dur)}`;
				}
				line += th.fg("dim", `${timeStr} ${task.output.split("\n")[0].slice(0, 40)}`);
			} else if (task.status === "failed" && task.error) {
				line += ` ${th.fg("error", task.error.slice(0, 40))}`;
			} else if (task.status === "in_progress") {
				const runningFor = task.started ? Date.now() - new Date(task.started).getTime() : 0;
				const timeColor = runningFor > 180_000 ? "warning" : "dim";
				line += ` ${th.fg(timeColor as any, formatElapsed(runningFor))}`;
				const messages = store.loadMessages(state.squadId!, task.id);
				const lastTool = [...messages].reverse().find(m => m.type === "tool");
				if (lastTool) {
					const detail = lastTool.args?.path || lastTool.args?.command || "";
					const toolStr = `→ ${lastTool.name || lastTool.text}`;
					line += ` ${th.fg("dim", (detail ? `${toolStr} ${detail}` : toolStr).slice(0, 30))}`;
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

		if (tasks.length > maxVisible) {
			lines.push(`  ${th.fg("dim", `  +${tasks.length - maxVisible} more · ^q detail`)}`);
		}

		// Skip if nothing changed (avoid redundant setWidget calls that cause flicker)
		const cacheKey = `${squad.status}:${tasks.map(t => `${t.id}=${t.status}:${t.usage.turns}`).join(",")}`;
		if (cacheKey === lastCacheKey) return;
		lastCacheKey = cacheKey;

		ctx.ui.setWidget("squad-tasks", lines);

		// Update status bar
		const statusText = squad.status === "done"
			? th.fg("success", `✓ squad ${doneCount}/${tasks.length}`)
			: squad.status === "failed"
			? th.fg("error", `✗ squad ${doneCount}/${tasks.length}`)
			: th.fg("accent", `⏳ squad ${doneCount}/${tasks.length} $${totalCost.toFixed(2)}`);
		ctx.ui.setStatus("squad", statusText);
	}

	function manageDurationTimer(): void {
		if (!state.squadId || !state.enabled) {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			return;
		}
		const squad = store.loadSquad(state.squadId);
		const isActive = squad && (squad.status === "running" || squad.status === "paused");
		if (isActive && !durationTimer) {
			durationTimer = setInterval(() => render(), 5000);
		} else if (!isActive && durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	}

	// Initial render
	render();
	manageDurationTimer();

	return {
		requestUpdate(): void {
			// Debounce: multiple rapid events (scheduler) coalesce into one render
			if (renderTimer) return;
			renderTimer = setTimeout(() => {
				renderTimer = null;
				render();
				manageDurationTimer();
			}, 50);
		},
		dispose(): void {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
			lastCacheKey = "";
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
		},
	};
}
