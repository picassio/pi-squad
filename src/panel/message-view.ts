/**
 * message-view.ts — Scrollable message log for a task.
 * Shows tool calls, agent text, @mentions, human messages.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { TaskMessage } from "../types.js";
import * as store from "../store.js";

// ============================================================================
// Message View
// ============================================================================

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

	invalidate(): void {
		/* stateless */
	}

	render(width: number, maxLines: number): string[] {
		const th = this.theme;

		if (!this.taskId) {
			return this.padToHeight(["", th.fg("muted", "  No task selected")], maxLines);
		}

		const task = store.loadTask(this.squadId, this.taskId);
		if (!task) {
			return this.padToHeight(["", th.fg("error", "  Task not found")], maxLines);
		}

		const messages = store.loadMessages(this.squadId, this.taskId);
		const lines: string[] = [];

		// Header: task info
		const statusColor = task.status === "done" ? "success"
			: task.status === "failed" ? "error"
			: task.status === "in_progress" ? "warning"
			: "muted";
		lines.push(` ${th.fg("accent", th.bold(task.id))} · ${th.fg("dim", task.agent)} ${th.fg(statusColor as any, task.status)}`);
		lines.push(` ${th.fg("dim", task.title.slice(0, width - 2))}`);
		lines.push("");

		if (messages.length === 0) {
			lines.push(th.fg("muted", "  No messages yet"));
			return this.padToHeight(lines, maxLines);
		}

		// Render messages
		const msgLines = this.renderMessages(messages, width);

		// Apply scroll
		const contentHeight = maxLines - lines.length - 1;
		const maxScroll = Math.max(0, msgLines.length - contentHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		// Auto-scroll to bottom if near the end
		if (this.scrollOffset >= maxScroll - 2) {
			this.scrollOffset = maxScroll;
		}

		const visible = msgLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		lines.push(...visible);

		// Scroll indicator
		if (msgLines.length > contentHeight) {
			const pos = maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 100;
			lines.push(th.fg("dim", ` ─── ${pos}% ───`));
		}

		return this.padToHeight(lines, maxLines);
	}

	// =========================================================================
	// Message Rendering
	// =========================================================================

	private renderMessages(messages: TaskMessage[], width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		let lastFrom: string | null = null;

		for (const msg of messages) {
			// Skip system status messages that are noise
			if (msg.type === "status" && msg.from === "system" && msg.text === "Agent starting work") {
				continue;
			}

			// Group consecutive messages from the same sender
			const showHeader = msg.from !== lastFrom;
			lastFrom = msg.from;

			if (showHeader) {
				// Blank line between different senders
				if (lines.length > 0) lines.push("");

				// Sender header with timestamp
				const time = this.formatTime(msg.ts);
				const senderColor = this.getSenderColor(msg.from);
				const senderName = msg.from === "human" ? "YOU" : msg.from;
				lines.push(` ${th.fg("dim", time)} ${th.fg(senderColor as any, senderName)}`);
			}

			// Message content
			switch (msg.type) {
				case "tool": {
					const toolName = msg.name || msg.text;
					const argsStr = msg.args?.path || msg.args?.command || "";
					const preview = argsStr
						? `→ ${toolName} ${argsStr}`
						: `→ ${toolName}`;
					lines.push(`   ${th.fg("muted", preview.slice(0, width - 4))}`);
					break;
				}

				case "mention": {
					const target = msg.to ? `→ ${msg.to}` : "";
					lines.push(`   ${th.fg("accent", `@${msg.to || "?"}`)} ${th.fg("dim", msg.text.slice(0, width - 10))}`);
					break;
				}

				case "text":
				case "message":
				case "reply": {
					// Wrap long text
					const textLines = this.wrapText(msg.text, width - 4);
					for (const textLine of textLines.slice(0, 10)) {
						lines.push(`   ${textLine}`);
					}
					if (textLines.length > 10) {
						lines.push(`   ${th.fg("dim", `... +${textLines.length - 10} lines`)}`);
					}
					break;
				}

				case "done": {
					lines.push(`   ${th.fg("success", "✓ " + msg.text.slice(0, width - 6))}`);
					break;
				}

				case "error": {
					lines.push(`   ${th.fg("error", "✗ " + msg.text.slice(0, width - 6))}`);
					break;
				}

				case "status": {
					lines.push(`   ${th.fg("dim", msg.text.slice(0, width - 4))}`);
					break;
				}
			}
		}

		return lines;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private getSenderColor(from: string): string {
		if (from === "human") return "accent";
		if (from === "system") return "dim";
		// Rotate through available colors for different agents
		const colors = ["success", "warning", "accent", "muted"];
		let hash = 0;
		for (const c of from) hash = (hash * 31 + c.charCodeAt(0)) & 0x7fffffff;
		return colors[hash % colors.length];
	}

	private formatTime(ts: string): string {
		try {
			const d = new Date(ts);
			const h = d.getHours().toString().padStart(2, "0");
			const m = d.getMinutes().toString().padStart(2, "0");
			return `${h}:${m}`;
		} catch {
			return "??:??";
		}
	}

	private wrapText(text: string, maxWidth: number): string[] {
		const lines: string[] = [];
		for (const rawLine of text.split("\n")) {
			if (rawLine.length <= maxWidth) {
				lines.push(rawLine);
			} else {
				// Simple word wrap
				let remaining = rawLine;
				while (remaining.length > maxWidth) {
					const breakAt = remaining.lastIndexOf(" ", maxWidth);
					const splitAt = breakAt > maxWidth * 0.3 ? breakAt : maxWidth;
					lines.push(remaining.slice(0, splitAt));
					remaining = remaining.slice(splitAt).trimStart();
				}
				if (remaining) lines.push(remaining);
			}
		}
		return lines;
	}

	private padToHeight(lines: string[], maxLines: number): string[] {
		while (lines.length < maxLines) {
			lines.push("");
		}
		return lines.slice(0, maxLines);
	}
}
