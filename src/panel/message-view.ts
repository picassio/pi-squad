/**
 * message-view.ts — Scrollable message log for a task.
 * All lines truncated to width. Caps rendered messages to prevent
 * TUI corruption from large message histories.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskMessage } from "../types.js";
import * as store from "../store.js";

/** Max messages to render (most recent). Older messages are skipped. */
const MAX_MESSAGES = 30;
/** Max lines per text message before truncation */
const MAX_TEXT_LINES = 5;

export class MessageView {
	private theme: Theme;
	private squadId: string;
	private taskId: string | null = null;
	private scrollOffset = 0;
	/** Track if user has manually scrolled up */
	private userScrolled = false;

	constructor(theme: Theme, squadId: string) {
		this.theme = theme;
		this.squadId = squadId;
	}

	setTaskId(taskId: string): void {
		this.taskId = taskId;
		this.scrollOffset = 0;
		this.userScrolled = false;
	}

	getTaskId(): string | null {
		return this.taskId;
	}

	scrollUp(): void {
		this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		this.userScrolled = true;
	}

	scrollDown(): void {
		this.scrollOffset++;
		// Will be clamped in render
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

		const allMessages = store.loadMessages(this.squadId, this.taskId);

		// Header (fixed, always visible)
		const header: string[] = [];
		const statusColor = task.status === "done" ? "success"
			: task.status === "failed" ? "error"
			: task.status === "in_progress" ? "warning"
			: "muted";
		header.push(fit(` ${th.fg("accent", th.bold(task.id))} · ${th.fg("dim", task.agent)} ${th.fg(statusColor as any, task.status)}`, w));
		header.push(fit(` ${th.fg("dim", task.title)}`, w));
		header.push("");

		if (allMessages.length === 0) {
			header.push(th.fg("muted", "  No messages yet"));
			return pad(header, maxLines);
		}

		// Only render recent messages to prevent TUI overload
		const messages = allMessages.slice(-MAX_MESSAGES);
		const skipped = allMessages.length - messages.length;

		const msgLines: string[] = [];
		if (skipped > 0) {
			msgLines.push(fit(th.fg("dim", ` ··· ${skipped} older messages ···`), w));
			msgLines.push("");
		}
		msgLines.push(...this.renderMessages(messages, w));

		// Fixed layout: header + scrollable content + status line = maxLines exactly
		const statusLines = 1; // always show status/scroll bar
		const contentHeight = Math.max(1, maxLines - header.length - statusLines);
		const maxScroll = Math.max(0, msgLines.length - contentHeight);

		// Auto-scroll to bottom unless user scrolled up
		if (!this.userScrolled) {
			this.scrollOffset = maxScroll;
		} else {
			this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
			if (this.scrollOffset >= maxScroll) {
				this.userScrolled = false;
			}
		}

		// Build output — exact height every time
		const lines = [...header];

		// Content area: pad to exact contentHeight
		const visible = msgLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		while (visible.length < contentHeight) visible.push("");
		lines.push(...visible.slice(0, contentHeight));

		// Status bar (always present, keeps layout stable)
		const pct = maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 100;
		const scrollInfo = maxScroll > 0
			? th.fg("dim", ` ─ ${pct}% ─ ${allMessages.length} msgs ─ ↑↓ scroll`)
			: th.fg("dim", ` ─ ${allMessages.length} msgs`);
		lines.push(fit(scrollInfo, w));

		// Strict: return exactly maxLines
		return lines.slice(0, maxLines);
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
					// Tool args can contain multi-line bash commands — take first line only
					const rawArg = (msg.args?.path || msg.args?.command || "").toString();
					const arg = rawArg.split("\n")[0];
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
					// Split text, strip any \r, ensure no embedded newlines survive
					const textLines = msg.text.replace(/\r/g, "").split("\n");
					const show = textLines.slice(0, MAX_TEXT_LINES);
					for (const tl of show) {
						lines.push(fit(`   ${tl}`, width));
					}
					if (textLines.length > MAX_TEXT_LINES) {
						lines.push(fit(`   ${th.fg("dim", `... +${textLines.length - MAX_TEXT_LINES} lines`)}`, width));
					}
					break;
				}
				case "done":
					lines.push(fit(`   ${th.fg("success", "✓ " + msg.text)}`, width));
					break;
				case "error":
					lines.push(fit(`   ${th.fg("error", "✗ " + msg.text)}`, width));
					break;
				case "status":
					lines.push(fit(`   ${th.fg("dim", msg.text)}`, width));
					break;
			}
		}

		return lines;
	}
}

function fit(line: string, width: number): string {
	// Strip any newlines that would create extra terminal lines and break layout math
	const clean = line.replace(/[\n\r]/g, " ");
	return truncateToWidth(clean, width, "…");
}

function pad(lines: string[], max: number): string[] {
	while (lines.length < max) lines.push("");
	return lines.slice(0, max);
}

function fmtTime(ts: string): string {
	try {
		const d = new Date(ts);
		return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
	} catch {
		return "??:??";
	}
}
