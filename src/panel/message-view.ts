/**
 * message-view.ts — Scrollable message log for a task.
 * The durable history is never sliced; only the fixed-height viewport is
 * collected for the TUI so large histories cannot change component height.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskMessage } from "../types.js";
import * as store from "../store.js";

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

		// Fixed layout: header + scrollable content + status line = maxLines exactly.
		// Count lazily, then collect only the visible window. This keeps the renderer
		// bounded without dropping any durable message or body line.
		const statusLines = 1; // always show status/scroll bar
		const contentHeight = Math.max(1, maxLines - header.length - statusLines);
		const messageLineCount = this.countMessageLines(allMessages, w);
		const maxScroll = Math.max(0, messageLineCount - contentHeight);

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

		// Content area: collect and pad to exact contentHeight.
		const visible = this.collectMessageLines(allMessages, w, this.scrollOffset, contentHeight);
		while (visible.length < contentHeight) visible.push("");
		lines.push(...visible);

		// Status bar (always present, keeps layout stable)
		const pct = maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 100;
		const scrollInfo = maxScroll > 0
			? th.fg("dim", ` ─ ${pct}% ─ ${allMessages.length} msgs ─ ↑↓ scroll`)
			: th.fg("dim", ` ─ ${allMessages.length} msgs`);
		lines.push(fit(scrollInfo, w));

		// Strict: return exactly maxLines
		return lines.slice(0, maxLines);
	}

	private countMessageLines(messages: TaskMessage[], width: number): number {
		let count = 0;
		for (const _line of this.iterMessageLines(messages, width)) count++;
		return count;
	}

	private collectMessageLines(
		messages: TaskMessage[],
		width: number,
		start: number,
		limit: number,
	): string[] {
		const visible: string[] = [];
		let index = 0;
		for (const line of this.iterMessageLines(messages, width)) {
			if (index++ < start) continue;
			visible.push(line);
			if (visible.length >= limit) break;
		}
		return visible;
	}

	private *iterMessageLines(messages: TaskMessage[], width: number): Generator<string> {
		const th = this.theme;
		let lastFrom: string | null = null;
		let hasOutput = false;

		for (const msg of messages) {
			if (msg.type === "status" && msg.from === "system" && msg.text === "Agent starting work") continue;

			const showHeader = msg.from !== lastFrom;
			lastFrom = msg.from;

			if (showHeader) {
				if (hasOutput) yield "";
				const time = fmtTime(msg.ts);
				const color = msg.from === "human" || msg.from === "orchestrator"
					? "accent"
					: msg.from === "system" ? "dim" : "success";
				const name = senderLabel(msg.from);
				yield fit(` ${th.fg("dim", time)} ${th.fg(color as any, name)}`, width);
				hasOutput = true;
			}

			switch (msg.type) {
				case "tool": {
					const name = msg.name || msg.text;
					// Tool args can contain multi-line bash commands — take first line only.
					const rawArg = (msg.args?.path || msg.args?.command || "").toString();
					const arg = rawArg.split("\n")[0];
					yield fit(`   ${th.fg("muted", `→ ${name}${arg ? " " + arg : ""}`)}`, width);
					break;
				}
				case "mention":
					yield fit(`   ${th.fg("accent", `@${msg.to || "?"}`)} ${th.fg("dim", msg.text)}`, width);
					break;
				case "text":
				case "message":
				case "reply":
					for (const textLine of msg.text.replace(/\r/g, "").split("\n")) {
						for (const line of wrap(`   ${textLine}`, width, "      ")) yield line;
					}
					break;
				case "done":
					for (const line of wrap(`   ✓ ${msg.text}`, width, "      ")) yield line;
					break;
				case "error":
					for (const line of wrap(`   ✗ ${msg.text}`, width, "      ")) yield line;
					break;
				case "status":
					yield fit(`   ${th.fg("dim", msg.text)}`, width);
					break;
			}
			hasOutput = true;
		}
	}
}

/** Truncate a single line (for headers, tool calls, status — not text content) */
function fit(line: string, width: number): string {
	const clean = line.replace(/[\n\r]/g, " ");
	return truncateToWidth(clean, width, "…");
}

/** Wrap a text line into multiple lines that fit within width.
 *  Uses ANSI-aware visibleWidth for correct wrapping with styled text.
 *  Returns array of lines, each guaranteed to fit within width. */
function wrap(line: string, width: number, indent: string = "   "): string[] {
	const clean = line.replace(/[\n\r]/g, " ");
	// Fast path: already fits
	if (visibleWidth(clean) <= width) return [clean];

	// For styled text, we can't word-wrap by chars (ANSI codes break).
	// Instead, strip to plain text, wrap that, then truncate styled lines.
	const plain = stripAnsi(clean);
	const indentW = visibleWidth(indent);
	const firstW = width;
	const contW = width - indentW;

	const results: string[] = [];
	let remaining = plain;
	let isFirst = true;

	while (remaining.length > 0) {
		const maxW = isFirst ? firstW : contW;
		if (remaining.length <= maxW) {
			results.push(isFirst ? remaining : indent + remaining);
			break;
		}
		// Find word break point
		let breakAt = remaining.lastIndexOf(" ", maxW);
		if (breakAt <= maxW * 0.3) breakAt = maxW; // No good break, hard cut
		const chunk = remaining.slice(0, breakAt);
		results.push(isFirst ? chunk : indent + chunk);
		remaining = remaining.slice(breakAt).trimStart();
		isFirst = false;
	}

	// Truncate each to be safe (handles edge cases)
	return results.map(r => truncateToWidth(r, width, ""));
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function senderLabel(from: string): string {
	if (from === "human") return "YOU";
	if (from === "orchestrator") return "ORCHESTRATOR";
	return from;
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
