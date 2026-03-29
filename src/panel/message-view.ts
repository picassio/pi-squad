/**
 * message-view.ts — Scrollable message log for a task.
 * Shows tool calls, agent text, @mentions, human messages.
 * All lines are truncated to width to prevent TUI crashes.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskMessage } from "../types.js";
import * as store from "../store.js";

export class MessageView {
	private theme: Theme;
	private squadId: string;
	private taskId: string | null = null;
	private scrollOffset = 0;

	constructor(theme: Theme, squadId: string) {
		this.theme = theme;
		this.squadId = squadId;
	}

	setTaskId(taskId: string): void {
		this.taskId = taskId;
		this.scrollOffset = 0;
	}

	getTaskId(): string | null {
		return this.taskId;
	}

	scrollUp(): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - 1);
	}

	scrollDown(): void {
		this.scrollOffset++;
	}

	invalidate(): void {}

	render(width: number, maxLines: number): string[] {
		const th = this.theme;
		const w = Math.max(10, width);

		if (!this.taskId) {
			return pad(["", th.fg("muted", "  No task selected")], maxLines);
		}

		const task = store.loadTask(this.squadId, this.taskId);
		if (!task) {
			return pad(["", th.fg("error", "  Task not found")], maxLines);
		}

		const messages = store.loadMessages(this.squadId, this.taskId);
		const lines: string[] = [];

		// Header
		const statusColor = task.status === "done" ? "success"
			: task.status === "failed" ? "error"
			: task.status === "in_progress" ? "warning"
			: "muted";
		lines.push(fit(` ${th.fg("accent", th.bold(task.id))} · ${th.fg("dim", task.agent)} ${th.fg(statusColor as any, task.status)}`, w));
		lines.push(fit(` ${th.fg("dim", task.title)}`, w));
		lines.push("");

		if (messages.length === 0) {
			lines.push(th.fg("muted", "  No messages yet"));
			return pad(lines, maxLines);
		}

		// Render messages
		const msgLines = this.renderMessages(messages, w);

		// Scroll
		const contentHeight = Math.max(1, maxLines - lines.length - 1);
		const maxScroll = Math.max(0, msgLines.length - contentHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		if (this.scrollOffset >= maxScroll - 2) this.scrollOffset = maxScroll;

		lines.push(...msgLines.slice(this.scrollOffset, this.scrollOffset + contentHeight));

		if (msgLines.length > contentHeight) {
			const pct = maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 100;
			lines.push(th.fg("dim", ` ─── ${pct}% ───`));
		}

		return pad(lines, maxLines);
	}

	private renderMessages(messages: TaskMessage[], width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		let lastFrom: string | null = null;

		for (const msg of messages) {
			if (msg.type === "status" && msg.from === "system" && msg.text === "Agent starting work") continue;

			const showHeader = msg.from !== lastFrom;
			lastFrom = msg.from;

			if (showHeader) {
				if (lines.length > 0) lines.push("");
				const time = fmtTime(msg.ts);
				const color = msg.from === "human" ? "accent" : msg.from === "system" ? "dim" : "success";
				const name = msg.from === "human" ? "YOU" : msg.from;
				lines.push(fit(` ${th.fg("dim", time)} ${th.fg(color as any, name)}`, width));
			}

			switch (msg.type) {
				case "tool": {
					const name = msg.name || msg.text;
					const arg = msg.args?.path || msg.args?.command || "";
					lines.push(fit(`   ${th.fg("muted", `→ ${name}${arg ? " " + arg : ""}`)}`, width));
					break;
				}
				case "mention": {
					lines.push(fit(`   ${th.fg("accent", `@${msg.to || "?"}`)} ${th.fg("dim", msg.text)}`, width));
					break;
				}
				case "text":
				case "message":
				case "reply": {
					// Split by newline, cap at 10 lines, truncate each
					const textLines = msg.text.split("\n").slice(0, 10);
					for (const tl of textLines) {
						lines.push(fit(`   ${tl}`, width));
					}
					const total = msg.text.split("\n").length;
					if (total > 10) {
						lines.push(fit(`   ${th.fg("dim", `... +${total - 10} lines`)}`, width));
					}
					break;
				}
				case "done": {
					lines.push(fit(`   ${th.fg("success", "✓ " + msg.text)}`, width));
					break;
				}
				case "error": {
					lines.push(fit(`   ${th.fg("error", "✗ " + msg.text)}`, width));
					break;
				}
				case "status": {
					lines.push(fit(`   ${th.fg("dim", msg.text)}`, width));
					break;
				}
			}
		}

		return lines;
	}
}

// Helpers

function fit(line: string, width: number): string {
	return truncateToWidth(line, width, "…");
}

function pad(lines: string[], maxLines: number): string[] {
	while (lines.length < maxLines) lines.push("");
	return lines.slice(0, maxLines);
}

function fmtTime(ts: string): string {
	try {
		const d = new Date(ts);
		return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
	} catch {
		return "??:??";
	}
}
