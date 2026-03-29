/**
 * squad-panel.ts — Main overlay component for the squad TUI panel.
 *
 * Uses ctx.ui.custom() with a proper done() callback for lifecycle management.
 * Inspired by pi-interactive-shell's overlay pattern:
 * - Component implements Component + Focusable
 * - handleInput for key dispatch
 * - render(width) returns string[]
 * - done() closes the overlay cleanly
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PanelState, PanelView } from "../types.js";
import type { Scheduler } from "../scheduler.js";
import { TaskListView } from "./task-list.js";
import { MessageView } from "./message-view.js";
import * as store from "../store.js";

// ============================================================================
// Result type — what the panel returns when closed
// ============================================================================

export interface SquadPanelResult {
	/** How the panel was closed */
	action: "close" | "send-message";
	taskId?: string;
	message?: string;
}

// ============================================================================
// Squad Panel
// ============================================================================

export class SquadPanel implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private done: (result: SquadPanelResult) => void;
	private scheduler: Scheduler;
	private squadId: string;

	/** Callback for sending messages — set by the extension */
	onSendMessage?: (taskId: string, message: string) => Promise<void>;
	/** Callback when panel closes */
	onClose?: () => void;

	private state: PanelState = {
		view: "tasks",
		selectedTaskIndex: 0,
		selectedTaskId: null,
		scrollOffset: 0,
		agentSelectedIndex: 0,
	};

	private taskListView: TaskListView;
	private messageView: MessageView;
	/** Debounced render timer */
	private renderTimeout: ReturnType<typeof setTimeout> | null = null;
	/** Auto-refresh timer for live activity */
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private finished = false;

	constructor(
		tui: TUI,
		theme: Theme,
		scheduler: Scheduler,
		squadId: string,
		done: (result: SquadPanelResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.scheduler = scheduler;
		this.squadId = squadId;
		this.done = done;

		this.taskListView = new TaskListView(theme, squadId);
		this.messageView = new MessageView(theme, squadId);

		// Auto-refresh for live activity. 5s is enough — faster causes
		// flicker and races with agents writing to JSONL files.
		this.refreshTimer = setInterval(() => {
			this.tui.requestRender();
		}, 5000);
	}

	/** Trigger a render update (called from outside, e.g., on scheduler events) */
	requestUpdate(): void {
		this.debouncedRender();
	}

	private debouncedRender(): void {
		if (this.renderTimeout) clearTimeout(this.renderTimeout);
		this.renderTimeout = setTimeout(() => {
			this.renderTimeout = null;
			this.tui.requestRender();
		}, 16);
	}

	private finish(result: SquadPanelResult): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.onClose?.();
		this.done(result);
	}

	// =========================================================================
	// Input Handling
	// =========================================================================

	handleInput(data: string): void {
		// Ctrl+Q or q: close panel
		if (data === "\x11") {
			this.finish({ action: "close" });
			return;
		}

		// Escape: back from messages, or close panel
		if (matchesKey(data, "escape")) {
			if (this.state.view === "messages") {
				this.state.view = "tasks";
				this.tui.requestRender();
				return;
			}
			this.finish({ action: "close" });
			return;
		}

		// q: close from task list
		if (matchesKey(data, "q") && this.state.view === "tasks") {
			this.finish({ action: "close" });
			return;
		}

		// Delegate to current view
		switch (this.state.view) {
			case "tasks":
				this.handleTaskListInput(data);
				break;
			case "messages":
				this.handleMessageViewInput(data);
				break;
		}
	}

	private handleTaskListInput(data: string): void {
		const tasks = store.loadAllTasks(this.squadId);

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.state.selectedTaskIndex = Math.max(0, this.state.selectedTaskIndex - 1);
			if (tasks[this.state.selectedTaskIndex]) {
				this.state.selectedTaskId = tasks[this.state.selectedTaskIndex].id;
			}
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.state.selectedTaskIndex = Math.min(tasks.length - 1, this.state.selectedTaskIndex + 1);
			if (tasks[this.state.selectedTaskIndex]) {
				this.state.selectedTaskId = tasks[this.state.selectedTaskIndex].id;
			}
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			if (this.state.selectedTaskId) {
				this.state.view = "messages";
				this.state.scrollOffset = 0;
				this.messageView.setTaskId(this.state.selectedTaskId);
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "p")) {
			if (this.state.selectedTaskId) {
				const task = store.loadTask(this.squadId, this.state.selectedTaskId);
				if (task?.status === "in_progress") {
					this.scheduler.pauseTask(this.state.selectedTaskId);
				} else if (task?.status === "suspended") {
					this.scheduler.resumeTask(this.state.selectedTaskId);
				}
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "x")) {
			if (this.state.selectedTaskId) {
				this.scheduler.cancelTask(this.state.selectedTaskId);
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "m")) {
			if (this.state.selectedTaskId && this.onSendMessage) {
				this.onSendMessage(this.state.selectedTaskId, "");
			}
		}
	}

	private handleMessageViewInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.messageView.scrollUp();
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.messageView.scrollDown();
			this.tui.requestRender();
		} else if (matchesKey(data, "escape")) {
			this.state.view = "tasks";
			this.tui.requestRender();
		} else if (matchesKey(data, "m")) {
			const taskId = this.messageView.getTaskId();
			if (taskId && this.onSendMessage) {
				this.onSendMessage(taskId, "");
			}
		}
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	invalidate(): void {
		this.taskListView.invalidate();
		this.messageView.invalidate();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Header
		const squad = store.loadSquad(this.squadId);
		const title = squad ? `squad: ${squad.goal.slice(0, width - 20)}` : "squad";
		lines.push(...this.renderHeader(title, width));

		// Content area — calculate available height for task list.
		// The overlay has maxHeight "80%", so we must fit within that.
		// Layout: 1 header + content + 3 footer = content gets the rest.
		const contentWidth = width - 2;
		const termRows = this.tui.terminal.rows || 24;
		const overlayMaxRows = Math.floor(termRows * 0.8);
		const chromeLines = 4; // 1 header + 3 footer
		const availHeight = Math.max(5, overlayMaxRows - chromeLines);

		switch (this.state.view) {
			case "tasks": {
				const taskLines = this.taskListView.render(
					contentWidth,
					this.state.selectedTaskIndex,
					availHeight,
					this.scheduler,
				);
				for (const line of taskLines) {
					lines.push(this.borderLine(line, width));
				}
				break;
			}
			case "messages": {
				const msgLines = this.messageView.render(contentWidth, availHeight);
				for (const line of msgLines) {
					lines.push(this.borderLine(line, width));
				}
				break;
			}
		}

		// Footer
		lines.push(...this.renderFooter(width));

		// Safety: truncate all lines to prevent pi-tui crash
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderHeader(title: string, width: number): string[] {
		const th = this.theme;
		const innerW = width - 2;
		const titleStr = ` ${title} `;
		const titleVW = visibleWidth(titleStr);
		const rightBarLen = Math.max(0, innerW - titleVW - 1);

		return [
			th.fg("border", "╭─") +
				th.fg("accent", titleStr) +
				th.fg("border", "─".repeat(rightBarLen) + "╮"),
		];
	}

	private renderFooter(width: number): string[] {
		const th = this.theme;
		const innerW = width - 2;

		let keys: string;
		switch (this.state.view) {
			case "tasks":
				keys = ` ↑↓ nav  ⏎ msgs  m send  p pause  x cancel  ^q close`;
				break;
			case "messages":
				keys = ` ↑↓ scroll  m send  esc back  ^q close`;
				break;
			default:
				keys = ` ^q close`;
		}

		return [
			th.fg("border", "├" + "─".repeat(innerW) + "┤"),
			this.borderLine(th.fg("dim", keys), width),
			th.fg("border", "╰" + "─".repeat(innerW) + "╯"),
		];
	}

	private borderLine(content: string, width: number): string {
		const th = this.theme;
		const innerW = width - 2;
		const truncated = truncateToWidth(content, innerW);
		const contentVW = visibleWidth(truncated);
		const pad = " ".repeat(Math.max(0, innerW - contentVW));
		return th.fg("border", "│") + truncated + pad + th.fg("border", "│");
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	dispose(): void {
		if (this.renderTimeout) {
			clearTimeout(this.renderTimeout);
			this.renderTimeout = null;
		}
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}
