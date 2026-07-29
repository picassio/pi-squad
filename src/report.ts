import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildOrchestratorReviewGate } from "./review.js";
import { getSquadDir, now } from "./store.js";
import type { Squad, Task } from "./types.js";

const SNAPSHOT_COMMAND_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	timeout: 2_000,
	maxBuffer: 256 * 1024,
	windowsHide: true,
	stdio: ["ignore", "pipe", "ignore"],
};

function buildWorkingTreeSnapshot(cwd: string): string {
	try {
		const insideWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			...SNAPSHOT_COMMAND_OPTIONS,
			cwd,
		}).trim();
		if (insideWorkTree !== "true") return "";

		const diffStat = execFileSync("git", ["diff", "--stat"], {
			...SNAPSHOT_COMMAND_OPTIONS,
			cwd,
		}).trimEnd();
		const status = execFileSync("git", ["status", "--short"], {
			...SNAPSHOT_COMMAND_OPTIONS,
			cwd,
		});
		const untrackedCount = status.match(/^\?\? /gm)?.length ?? 0;

		return ["Working Tree Snapshot", diffStat, `Untracked files: ${untrackedCount}`]
			.filter(Boolean)
			.join("\n");
	} catch {
		return "";
	}
}

/**
 * Build the full task handoff included in squad completion notifications.
 * This is durable report data, not a UI preview: never shorten task output.
 */
export function buildCompletionSummary(tasks: Task[], cwd?: string): string {
	const completed = tasks
		.filter((task) => task.status === "done")
		.map((task) => `- ${task.id} (${task.agent}): ${task.output || "done"}`)
		.join("\n");
	const cancelled = tasks
		.filter((task) => task.status === "cancelled")
		.map((task) => `- ${task.id} (${task.agent}): cancelled`)
		.join("\n");

	const legacySummary = [completed, cancelled ? `CANCELLED TASKS (neutral; not successful output)\n${cancelled}` : ""]
		.filter(Boolean)
		.join("\n\n");
	const snapshot = cwd ? buildWorkingTreeSnapshot(cwd) : "";

	return [legacySummary, snapshot].filter(Boolean).join("\n\n");
}

/**
 * Inline delivery limit (chars) for the review-required notification. Reports
 * larger than this are written byte-complete to <squad>/review-report.md and
 * the main session receives a bounded digest plus a mandatory-read pointer.
 * Nothing is truncated: the file is the complete canonical handoff.
 */
const DEFAULT_REVIEW_INLINE_LIMIT = 24_000;

export function reviewInlineLimit(): number {
	const value = Number(process.env.PI_SQUAD_REVIEW_INLINE_LIMIT);
	return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : DEFAULT_REVIEW_INLINE_LIMIT;
}

export interface ReviewRequiredNotification {
	/** Message delivered to the main session (bounded when spilled). */
	content: string;
	/** Path of the complete durable report file, or null when delivered inline. */
	reportPath: string | null;
}

/**
 * Build the review-required notification. Small squads keep today's fully
 * inline report. When the assembled report exceeds the inline limit (e.g. an
 * 89-task squad), the COMPLETE report — every task handoff, working-tree
 * snapshot, and the full review gate — is written untruncated to
 * <squad>/review-report.md, and the main session receives a bounded digest:
 * total counts/cost, a per-task index with output sizes, a compact review
 * gate, and a mandate to read the report file to the end before reviewing.
 */
export function buildReviewRequiredNotification(squad: Squad, tasks: Task[]): ReviewRequiredNotification {
	const summary = buildCompletionSummary(tasks, squad.cwd);
	const totalCost = tasks.reduce((sum, task) => sum + task.usage.cost, 0);
	const header = `[squad] TASK EXECUTION FINISHED for "${squad.id}" — WORK IS UNTRUSTED AND NOT YET ACCEPTED.\n\n`;
	const gate = buildOrchestratorReviewGate(squad, tasks);
	const inline = header +
		`Squad claims (review inputs only):\n${summary}\n\n` +
		`Total cost: $${totalCost.toFixed(4)}\n\n` + gate;
	if (inline.length <= reviewInlineLimit()) return { content: inline, reportPath: null };

	const reportPath = path.join(getSquadDir(squad.id), "review-report.md");
	const fileBody = `# Squad review report — ${squad.id}\n` +
		`Generated: ${now()}\n` +
		`This file is the complete, untruncated review handoff for this squad.\n\n` +
		`## Squad claims (review inputs only)\n\n${summary}\n\n` +
		`Total cost: $${totalCost.toFixed(4)}\n\n` +
		`## Review gate\n\n${gate}\n`;
	try {
		fs.mkdirSync(path.dirname(reportPath), { recursive: true });
		fs.writeFileSync(reportPath, fileBody, "utf8");
	} catch {
		// If the durable report cannot be written, inline delivery (today's
		// behavior) is the only lossless fallback.
		return { content: inline, reportPath: null };
	}

	const statusCounts = new Map<string, number>();
	for (const task of tasks) statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
	const counts = [...statusCounts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
	const index = tasks
		.map((task) => `- ${task.id} (${task.agent}) [${task.status}] — output ${task.output?.length ?? 0} chars${task.error ? `; error: yes` : ""}`)
		.join("\n");
	const content = header +
		`This squad has ${tasks.length} tasks (${counts}); the complete report (${fileBody.length} chars) exceeds the inline limit, so it was written untruncated to:\n` +
		`${reportPath}\n\n` +
		`MANDATORY: read that ENTIRE file before reviewing (Read tool with offset/limit, continuing until the end). This digest is an index, not the report — no task handoff content appears below.\n\n` +
		`Task index:\n${index}\n\n` +
		`Total cost: $${totalCost.toFixed(4)}\n\n` +
		buildOrchestratorReviewGate(squad, tasks, { compactPlan: true });
	return { content, reportPath };
}

/** Build the full failure handoff without shortening diagnostics. */
export function buildFailureSummary(tasks: Task[]): string {
	return tasks
		.filter((task) => task.status === "failed")
		.map((task) => `${task.id}: ${task.error || "unknown error"}`)
		.join("; ");
}
