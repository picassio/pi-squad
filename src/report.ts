import type { Task } from "./types.js";

/**
 * Build the full task handoff included in squad completion notifications.
 * This is durable report data, not a UI preview: never shorten task output.
 */
export function buildCompletionSummary(tasks: Task[]): string {
	const completed = tasks
		.filter((task) => task.status === "done")
		.map((task) => `- ${task.id} (${task.agent}): ${task.output || "done"}`)
		.join("\n");
	const cancelled = tasks
		.filter((task) => task.status === "cancelled")
		.map((task) => `- ${task.id} (${task.agent}): cancelled`)
		.join("\n");

	return [completed, cancelled ? `CANCELLED TASKS (neutral; not successful output)\n${cancelled}` : ""]
		.filter(Boolean)
		.join("\n\n");
}

/** Build the full failure handoff without shortening diagnostics. */
export function buildFailureSummary(tasks: Task[]): string {
	return tasks
		.filter((task) => task.status === "failed")
		.map((task) => `${task.id}: ${task.error || "unknown error"}`)
		.join("; ");
}
