/**
 * task-list.ts — Task tree view with status icons, live activity preview.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Task, TaskStatus } from "../types.js";
import type { Scheduler } from "../scheduler.js";
import * as store from "../store.js";

// ============================================================================
// Status Icons
// ============================================================================

function statusIcon(status: TaskStatus, th: Theme): string {
	switch (status) {
		case "done":
			return th.fg("success", "✓");
		case "in_progress":
			return th.fg("warning", "⏳");
		case "blocked":
			return th.fg("muted", "◻");
		case "failed":
			return th.fg("error", "✗");
		case "suspended":
			return th.fg("muted", "⏸");
		case "pending":
		default:
			return th.fg("dim", "·");
	}
}

function statusLabel(status: TaskStatus): string {
	switch (status) {
		case "done":
			return "done";
		case "in_progress":
			return "";
		case "blocked":
			return "blocked";
		case "failed":
			return "FAILED";
		case "suspended":
			return "paused";
		case "pending":
			return "pending";
	}
}

// ============================================================================
// Task List View
// ============================================================================

export class TaskListView {
	private theme: Theme;
	private squadId: string;

	constructor(theme: Theme, squadId: string) {
		this.theme = theme;
		this.squadId = squadId;
	}

	invalidate(): void {
		/* stateless rendering */
	}

	render(
		width: number,
		selectedIndex: number,
		maxLines: number,
		scheduler: Scheduler,
	): string[] {
		const th = this.theme;
		const tasks = store.loadAllTasks(this.squadId);
		const lines: string[] = [];

		if (tasks.length === 0) {
			lines.push("");
			lines.push(th.fg("muted", "  No tasks yet"));
			lines.push("");
			return this.padToHeight(lines, maxLines);
		}

		// Render task list
		const taskLines = this.renderTaskTree(tasks, selectedIndex, width);

		// Scroll window
		const scrollStart = Math.max(0, Math.min(selectedIndex - Math.floor(maxLines / 2), taskLines.length - maxLines + 4));
		const visibleTasks = taskLines.slice(scrollStart, scrollStart + maxLines - 4);
		lines.push(...visibleTasks);

		// Separator
		lines.push("");
		lines.push(th.fg("border", " " + "─".repeat(width - 2)));

		// Live activity for selected or first running task
		const runningTask = tasks.find((t) => t.status === "in_progress");
		if (runningTask) {
			lines.push(...this.renderLiveActivity(runningTask, width, scheduler));
		}

		// Summary line
		lines.push("");
		lines.push(this.renderSummary(tasks, width));

		return this.padToHeight(lines, maxLines);
	}

	// =========================================================================
	// Task Tree
	// =========================================================================

	private renderTaskTree(tasks: Task[], selectedIndex: number, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Build parent → children map
		const topLevel: Task[] = [];
		const childMap = new Map<string, Task[]>();

		for (const task of tasks) {
			// Simple heuristic: tasks whose depends are not in the list are top-level
			// For proper parent/child: check if task folder is nested
			topLevel.push(task);
		}

		// TODO: proper parent/subtask tree from folder structure
		// For now, render flat with dependency indicators

		for (let i = 0; i < topLevel.length; i++) {
			const task = topLevel[i];
			const isSelected = i === selectedIndex;
			const icon = statusIcon(task.status, th);
			const label = statusLabel(task.status);

			const cursor = isSelected ? th.fg("accent", "▸") : " ";
			const taskName = isSelected
				? th.fg("accent", th.bold(task.id))
				: th.fg("muted", task.id);
			const agentTag = th.fg("dim", `(${task.agent})`);
			const labelStr = label ? th.fg("dim", ` ${label}`) : "";

			// Format elapsed time for done/in_progress tasks
			let timeStr = "";
			if (task.status === "done" && task.started && task.completed) {
				const elapsed = new Date(task.completed).getTime() - new Date(task.started).getTime();
				timeStr = th.fg("dim", ` ${formatMs(elapsed)}`);
			} else if (task.status === "in_progress" && task.started) {
				const elapsed = Date.now() - new Date(task.started).getTime();
				timeStr = th.fg("warning", ` ${formatMs(elapsed)}`);
			}

			const line = ` ${cursor} ${icon} ${taskName} ${agentTag}${labelStr}${timeStr}`;
			lines.push(line);

			// Show blocked-by info
			if (task.status === "blocked" && task.depends.length > 0) {
				const blockers = task.depends
					.filter((depId) => {
						const dep = tasks.find((t) => t.id === depId);
						return dep && dep.status !== "done";
					});
				if (blockers.length > 0) {
					lines.push(
						`     ${th.fg("dim", "└ waiting on: " + blockers.join(", "))}`,
					);
				}
			}

			// Show error for failed tasks
			if (task.status === "failed" && task.error) {
				const errorPreview = task.error.slice(0, width - 10);
				lines.push(`     ${th.fg("error", "└ " + errorPreview)}`);
			}
		}

		return lines;
	}

	// =========================================================================
	// Live Activity
	// =========================================================================

	private renderLiveActivity(task: Task, width: number, scheduler: Scheduler): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push(th.fg("border", ` ── ${task.id} (live) `) + th.fg("border", "─".repeat(Math.max(0, width - task.id.length - 12))));

		// Get recent messages for this task
		const messages = store.loadMessages(this.squadId, task.id);
		const recent = messages.slice(-3);

		for (const msg of recent) {
			if (msg.type === "tool") {
				const toolStr = `→ ${msg.name || msg.text}`;
				const argsStr = msg.args?.path || msg.args?.command || "";
				const preview = argsStr ? `${toolStr} ${argsStr}` : toolStr;
				lines.push(` ${th.fg("muted", preview.slice(0, width - 2))}`);
			} else if (msg.type === "text" && msg.from !== "system") {
				const preview = msg.text.split("\n")[0].slice(0, width - 4);
				lines.push(` ${th.fg("dim", `"${preview}"`)}`);
			}
		}

		// Health indicator
		const activity = scheduler.getPool().getActivity(task.id);
		if (activity) {
			const idleMs = Date.now() - activity.lastOutputTs;
			if (idleMs > 60000) {
				lines.push(` ${th.fg("warning", `⚠ idle ${formatMs(idleMs)}`)}`);
			}
		}

		return lines;
	}

	// =========================================================================
	// Summary
	// =========================================================================

	private renderSummary(tasks: Task[], width: number): string {
		const th = this.theme;
		const done = tasks.filter((t) => t.status === "done").length;
		const total = tasks.length;
		const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

		const parts: string[] = [];
		parts.push(th.fg("accent", `${done}/${total}`));
		if (totalCost > 0) parts.push(th.fg("dim", `$${totalCost.toFixed(4)}`));

		// Find squad creation time for elapsed
		const squad = store.loadSquad(this.squadId);
		if (squad) {
			const elapsed = Date.now() - new Date(squad.created).getTime();
			parts.push(th.fg("dim", formatMs(elapsed)));
		}

		return ` ${parts.join(th.fg("dim", " · "))}`;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private padToHeight(lines: string[], maxLines: number): string[] {
		while (lines.length < maxLines) {
			lines.push("");
		}
		return lines.slice(0, maxLines);
	}
}

// ============================================================================
// Formatting
// ============================================================================

function formatMs(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}
