/**
 * squad-widget.ts — Compact widget for squad status above the editor.
 *
 * Uses a component factory for setWidget so it can access terminal width
 * and truncate every line to prevent Text wrapping. Without truncation,
 * long lines wrap inside the Text component, causing unpredictable
 * widget height changes that corrupt the TUI diff renderer.
 *
 * Updates are pushed by calling requestUpdate() which rebuilds the
 * lines and calls setWidget() again.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskMessage, TaskStatus } from "../types.js";
import { getReviewPresentation, getSuspendedAttention, SUSPENDED_ATTENTION_LABEL } from "../presentation.js";
import * as store from "../store.js";

function statusIcon(status: TaskStatus, th: Theme): string {
	switch (status) {
		case "done": return th.fg("success", "✓");
		case "in_progress": return th.fg("warning", "⏳");
		case "blocked": return th.fg("muted", "◻");
		case "failed": return th.fg("error", "✗");
		case "suspended": return th.fg("muted", "⏸");
		case "cancelled": return th.fg("muted", "⊘");
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

export interface SquadWidgetControls {
	requestUpdate: () => void;
	refreshNow: () => void;
	dispose: () => void;
}

/**
 * Set up the squad widget. Returns control functions.
 *
 * Uses a component factory so we can access TUI.terminal.columns and
 * truncate every line, preventing Text word-wrapping that would cause
 * unpredictable widget height changes.
 */
export function setupSquadWidget(
	ctx: { ui: { setWidget: Function; setStatus: Function; [key: string]: any }; hasUI?: boolean },
	state: SquadWidgetState,
): SquadWidgetControls {
	if (!ctx.hasUI) return { requestUpdate: () => {}, refreshNow: () => {}, dispose: () => {} };

	let durationTimer: ReturnType<typeof setInterval> | null = null;
	let renderTimer: ReturnType<typeof setTimeout> | null = null;
	/** TUI handle captured from the component factory; mutating widget lines
	 * does NOT repaint the terminal by itself — an idle main session would show
	 * a frozen widget while background workers progress. Free to call: pure
	 * local terminal rendering, zero LLM tokens. */
	let tuiHandle: { requestRender?: () => void } | null = null;
	/** Cache key to skip redundant setWidget calls */
	let lastCacheKey = "";
	/** Last built lines — the factory re-uses these on each TUI render */
	let currentLines: string[] = [];

	function buildLines(): { lines: string[]; cacheKey: string; statusText: string } | null {
		if (!state.enabled || !state.squadId) return null;

		const th = ctx.ui.theme;
		const tasks = store.loadAllTasks(state.squadId);
		const squad = store.loadSquad(state.squadId);
		if (!squad || tasks.length === 0) return null;

		const lines: string[] = [];
		const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);
		const doneCount = tasks.filter((t) => t.status === "done").length;
		const cancelledCount = tasks.filter((t) => t.status === "cancelled").length;
		const activeCount = tasks.length - cancelledCount;
		const progressText = cancelledCount > 0
			? `${doneCount}/${activeCount} active tasks done · ${cancelledCount} cancelled · ${tasks.length} total`
			: `${doneCount}/${tasks.length}`;
		const elapsed = Date.now() - new Date(squad.created).getTime();
		const taskMessages = new Map<string, TaskMessage[]>();
		const recentOrchestratorByTask = new Map<string, TaskMessage>();
		const recentMessageKeys: string[] = [];
		for (const task of tasks) {
			if (task.status !== "in_progress") continue;
			const messages = store.loadMessages(state.squadId, task.id);
			taskMessages.set(task.id, messages);
			const latest = messages.at(-1);
			recentMessageKeys.push(`${task.id}:${messages.length}:${latest?.id || latest?.ts || "none"}`);
			const recentOrchestrator = [...messages.slice(-5)].reverse().find((message) =>
				message.from === "orchestrator" &&
				(message.type === "text" || message.type === "message" ||
					message.type === "reply" || message.type === "mention"),
			);
			if (recentOrchestrator) recentOrchestratorByTask.set(task.id, recentOrchestrator);
		}

		const review = getReviewPresentation(squad);
		const attention = getSuspendedAttention(squad);
		const sIcon = review ? th.fg(review.tone, review.icon)
			: squad.status === "done" ? th.fg("success", "✓")
			: squad.status === "failed" ? th.fg("error", "✗")
			: th.fg("warning", "⏳");

		const orchestratorSignal = recentOrchestratorByTask.size > 0
			? ` ${th.fg("accent", `✉ ${recentOrchestratorByTask.size > 1 ? recentOrchestratorByTask.size + " " : ""}ORCH`)}`
			: "";
		const acceptanceText = review ? ` · ${th.fg(review.tone, review.label)}` : "";
		lines.push(
			`${sIcon} ${th.fg("accent", "squad")}${orchestratorSignal} ${th.fg("dim", squad.goal.slice(0, 35))} ` +
			`${th.fg("muted", progressText)}${acceptanceText} ` +
			`${th.fg("dim", `$${totalCost.toFixed(2)}`)} ` +
			`${th.fg("dim", formatElapsed(elapsed))} ` +
			`${th.fg("dim", "^q detail · /squad msg")}`
		);
		if (attention) lines.push(`  ${th.fg("warning", SUSPENDED_ATTENTION_LABEL)} ${th.fg("dim", "· ^q detail")}`);

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
				const messages = taskMessages.get(task.id) || [];
				const recentOrchestrator = recentOrchestratorByTask.get(task.id);
				if (recentOrchestrator) {
					const preview = recentOrchestrator.text.split("\n")[0].slice(0, 24);
					line += ` ${th.fg("accent", "← ORCH")} ${th.fg("dim", preview)}`;
				} else {
					const lastTool = [...messages].reverse().find(m => m.type === "tool");
					if (lastTool) {
						const rawDetail = (lastTool.args?.path || lastTool.args?.command || "").toString();
						const detail = rawDetail.split("\n")[0]; // first line only
						const toolStr = `→ ${lastTool.name || lastTool.text}`;
						line += ` ${th.fg("dim", (detail ? `${toolStr} ${detail}` : toolStr).slice(0, 30))}`;
					}
				}
			} else if (task.status === "cancelled") {
				line += ` ${th.fg("muted", "cancelled")}`;
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

		// While work is in flight the widget shows live durations/activity, so
		// the cache key includes a 5s time bucket — otherwise the duration timer's
		// renders hit an unchanged key and bail before repainting (frozen widget).
		const liveBucket = tasks.some((t) => t.status === "in_progress") ? `:t${Math.floor(Date.now() / 5_000)}` : "";
		const cacheKey = `${state.squadId}:${squad.status}:${squad.review?.status ?? "none"}:${attention?.fingerprint ?? "no-attention"}:${tasks.map(t => `${t.id}=${t.status}:${t.usage.turns}`).join(",")}:${recentMessageKeys.join(",")}${liveBucket}`;

		const statusText = review
			? th.fg(review.tone, `${review.label} · ${progressText}`)
			: attention
			? th.fg("warning", `${SUSPENDED_ATTENTION_LABEL} · ${progressText}`)
			: squad.status === "done"
			? th.fg("success", `✓ squad ${progressText}`)
			: squad.status === "failed"
			? th.fg("error", `✗ squad ${progressText}`)
			: th.fg("accent", `⏳ squad ${progressText} $${totalCost.toFixed(2)}`);

		return { lines, cacheKey, statusText };
	}

	/**
	 * Widget component that renders pre-built lines truncated to terminal width.
	 * Each line is guaranteed to fit on exactly one terminal row — no wrapping.
	 * This keeps the widget height deterministic (= lines.length) so the TUI
	 * diff renderer never sees unexpected height changes.
	 */
	class SquadWidgetComponent implements Component {
		lines: string[] = [];

		invalidate(): void { /* stateless — lines are rebuilt externally */ }

		render(width: number): string[] {
			// Truncate every line to terminal width so Text wrapping cannot
			// add extra rows. One input line → exactly one output line.
			return this.lines.map(line => {
				const truncated = truncateToWidth(line, width);
				// Pad to full width to prevent leftover characters from previous renders
				const vw = visibleWidth(truncated);
				const pad = Math.max(0, width - vw);
				return truncated + " ".repeat(pad);
			});
		}
	}

	/** Persistent widget component instance — survives across setWidget calls */
	let widgetComponent: SquadWidgetComponent | null = null;
	let widgetInstalled = false;

	function render(): void {
		const result = buildLines();
		if (!result) {
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
			widgetInstalled = false;
			widgetComponent = null;
			lastCacheKey = "";
			return;
		}

		const { lines, cacheKey, statusText } = result;

		// Skip if nothing changed (avoid redundant setWidget calls)
		if (cacheKey === lastCacheKey) return;
		lastCacheKey = cacheKey;

		currentLines = lines;

		if (!widgetInstalled) {
			// Install the component factory once. On subsequent updates we just
			// mutate widgetComponent.lines and requestRender — no setWidget churn.
			widgetComponent = new SquadWidgetComponent();
			widgetComponent.lines = lines;

			const comp = widgetComponent;
			ctx.ui.setWidget("squad-tasks", (tui: TUI, _theme: Theme) => {
				tuiHandle = tui;
				return comp;
			});
			widgetInstalled = true;
		} else if (widgetComponent) {
			// Update lines in-place, then explicitly request a repaint: without
			// this the new lines only appear when something else re-renders the
			// TUI (streaming, keypress), which froze the widget on idle sessions.
			widgetComponent.lines = lines;
			tuiHandle?.requestRender?.();
		}

		ctx.ui.setStatus("squad", statusText);
	}

	function manageDurationTimer(): void {
		if (!state.squadId || !state.enabled) {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			return;
		}
		const squad = store.loadSquad(state.squadId);
		const isActive = squad && (squad.status === "running" || squad.status === "paused" || squad.status === "review");
		if (isActive && !durationTimer) {
			durationTimer = setInterval(() => render(), 5000);
		} else if (!isActive && durationTimer) {
			clearInterval(durationTimer);
			durationTimer = null;
		}
	}

	function refreshNow(): void {
		if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
		render();
		manageDurationTimer();
	}

	// Initial render
	refreshNow();

	return {
		requestUpdate(): void {
			// Debounce: multiple rapid events (scheduler) coalesce into one render
			if (renderTimer) return;
			renderTimer = setTimeout(() => {
				renderTimer = null;
				refreshNow();
			}, 50);
		},
		refreshNow,
		dispose(): void {
			if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
			if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
			lastCacheKey = "";
			currentLines = [];
			widgetInstalled = false;
			widgetComponent = null;
			ctx.ui.setWidget("squad-tasks", undefined);
			ctx.ui.setStatus("squad", undefined);
		},
	};
}
