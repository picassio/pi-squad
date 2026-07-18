import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import type { Task } from "./types.js";

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

/** Build the full failure handoff without shortening diagnostics. */
export function buildFailureSummary(tasks: Task[]): string {
	return tasks
		.filter((task) => task.status === "failed")
		.map((task) => `${task.id}: ${task.error || "unknown error"}`)
		.join("; ");
}
