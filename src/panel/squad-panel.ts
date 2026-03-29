/**
 * squad-panel.ts — Main overlay component for the squad TUI panel.
 *
 * Manages view switching between task list, message view, and agent list.
 * Adapts layout: wide screen (>=160 cols) = right panel, narrow = centered overlay.
 */

import type { Component, Focusable, TUI, OverlayHandle, OverlayOptions } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PanelState, PanelView } from "../types.js";
import type { Scheduler } from "../scheduler.js";
import { TaskListView } from "./task-list.js";
import { MessageView } from "./message-view.js";
import * as store from "../store.js";

// ============================================================================
// Constants
// ============================================================================

const WIDE_THRESHOLD = 160;

// ============================================================================
// Squad Panel
// ============================================================================

export class SquadPanel implements Component, Focusable {
	focused = false;

	private tui: TUI;
	private theme: Theme;
	private scheduler: Scheduler;
	private squadId: string;
	private handle: OverlayHandle | null = null;
	/** Callback to send a human message — set by the extension */
	onSendMessage?: (taskId: string, message: string) => void;
	/** Callback to notify extension when panel visibility changes */
	onVisibilityChange?: (visible: boolean) => void;

	private state: PanelState = {
		view: "tasks",
		selectedTaskIndex: 0,
		selectedTaskId: null,
		scrollOffset: 0,
		agentSelectedIndex: 0,
	};

	private taskListView: TaskListView;
	private messageView: MessageView;

	private refreshInterval: ReturnType<typeof setInterval> | null = null;

	constructor(tui: TUI, theme: Theme, scheduler: Scheduler, squadId: string) {
		this.tui = tui;
		this.theme = theme;
		this.scheduler = scheduler;
		this.squadId = squadId;

		this.taskListView = new TaskListView(theme, squadId);
		this.messageView = new MessageView(theme, squadId);
	}

	// =========================================================================
	// Overlay Lifecycle
	// =========================================================================

	/** Show the panel as an overlay */
	show(): void {
		if (this.handle) return;

		this.handle = this.tui.showOverlay(this, this.getOverlayOptions());
		this.onVisibilityChange?.(true);

		// Refresh panel periodically (5s — reads from disk)
		this.refreshInterval = setInterval(() => {
			if (!this.handle?.isHidden()) this.tui.requestRender();
		}, 5000);
	}

	/** Hide the panel */
	hide(): void {
		if (this.handle) {
			this.handle.hide();
			this.handle = null;
		}
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}

	/** Toggle panel visibility */
	toggle(): void {
		if (this.handle) {
			if (this.handle.isHidden()) {
				this.handle.setHidden(false);
			} else {
				this.handle.setHidden(true);
			}
		} else {
			this.show();
		}
	}

	/** Toggle focus between panel and main editor.
	 *  Wide screen: panel stays visible, just switch focus.
	 *  Narrow screen: show/hide since overlay covers content.
	 */
	toggleFocus(): void {
		if (!this.handle) {
			this.show();
			this.onVisibilityChange?.(true);
			return;
		}
		const wide = this.tui.terminal.columns >= WIDE_THRESHOLD;

		if (this.handle.isHidden()) {
			this.handle.setHidden(false);
			this.handle.focus();
			this.onVisibilityChange?.(true);
		} else if (this.handle.isFocused()) {
			if (wide) {
				this.handle.unfocus();
			} else {
				this.handle.setHidden(true);
				this.onVisibilityChange?.(false);
			}
		} else {
			this.handle.focus();
		}
	}

	/** Check if panel is visible */
	isVisible(): boolean {
		return this.handle !== null && !this.handle.isHidden();
	}

	dispose(): void {
		this.hide();
	}

	// =========================================================================
	// Overlay Options (adaptive layout)
	// =========================================================================

	private getOverlayOptions(): OverlayOptions {
		const wide = this.tui.terminal.columns >= WIDE_THRESHOLD;
		if (wide) {
			return {
				anchor: "top-right",
				width: "35%",
				maxHeight: "100%",
				margin: { top: 0, right: 0, bottom: 1, left: 0 },
			};
		}
		return {
			anchor: "center",
			width: "90%",
			maxHeight: "85%",
		};
	}

	// =========================================================================
	// Input Handling
	// =========================================================================

	private hidePanel(): void {
		this.handle?.setHidden(true);
		this.onVisibilityChange?.(false);
	}

	handleInput(data: string): void {
		// Ctrl+Q: always hide panel and return to editor
		if (data === "\x11") {
			this.hidePanel();
			return;
		}

		// Escape: back from messages, or hide panel
		if (matchesKey(data, "escape")) {
			if (this.state.view === "messages") {
				this.state.view = "tasks";
				this.tui.requestRender();
				return;
			}
			this.hidePanel();
			return;
		}

		// q: hide panel (from task list only)
		if (matchesKey(data, "q")) {
			if (this.state.view === "tasks") {
				this.hidePanel();
				return;
			}
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
			// Open message view for selected task
			if (this.state.selectedTaskId) {
				this.state.view = "messages";
				this.state.scrollOffset = 0;
				this.messageView.setTaskId(this.state.selectedTaskId);
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "p")) {
			// Pause/resume selected task
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
			// Cancel selected task
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
			// Send message to this task's agent
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

		// Content area: total height minus header (1 line) and footer (3 lines)
		const contentWidth = width - 2; // Account for border chars
		const totalAvailable = this.tui.terminal.rows || 24;
		const availHeight = Math.max(5, totalAvailable - 4); // 1 header + 3 footer

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

		// Footer with keybindings
		lines.push(...this.renderFooter(width));

		return lines;
	}

	private renderHeader(title: string, width: number): string[] {
		const th = this.theme;
		const innerW = width - 2;
		const titleStr = ` ${title} `;
		const titleVW = visibleWidth(titleStr);
		const leftBar = "─";
		const rightBarLen = Math.max(0, innerW - titleVW - 1);
		const rightBar = "─".repeat(rightBarLen);

		return [
			th.fg("border", "╭" + leftBar) +
				th.fg("accent", titleStr) +
				th.fg("border", rightBar + "╮"),
		];
	}

	private renderFooter(width: number): string[] {
		const th = this.theme;
		const innerW = width - 2;
		const wide = this.tui.terminal.columns >= WIDE_THRESHOLD;
		const switchHint = wide ? "^q switch" : "^q close";

		let keys: string;
		switch (this.state.view) {
			case "tasks":
				keys = ` ↑↓ nav  ⏎ msgs  m send  p pause  x cancel  ${switchHint}`;
				break;
			case "messages":
				keys = ` ↑↓ scroll  m send  esc back  ${switchHint}`;
				break;
			default:
				keys = ` ${switchHint}`;
		}

		return [
			th.fg("border", "├" + "─".repeat(innerW) + "┤"),
			this.borderLine(th.fg("dim", keys), width),
			th.fg("border", "╰" + "─".repeat(innerW) + "╯"),
		];
	}

	/** Wrap a content line with border chars, padded to exact width */
	private borderLine(content: string, width: number): string {
		const th = this.theme;
		const innerW = width - 2;
		// Truncate content to fit, preserving ANSI codes
		const truncated = truncateToWidth(content, innerW);
		const contentVW = visibleWidth(truncated);
		const pad = " ".repeat(Math.max(0, innerW - contentVW));
		return th.fg("border", "│") + truncated + pad + th.fg("border", "│");
	}
}
