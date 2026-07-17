import test from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSummary, buildFailureSummary } from "../src/report.ts";

function task(id, status, output = null, error = null) {
	return {
		id,
		title: `Task ${id}`,
		description: "",
		agent: `role-${id}`,
		status,
		depends: [],
		created: "2026-07-14T00:00:00.000Z",
		started: null,
		completed: null,
		output,
		error,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	};
}

test("completion report preserves all 15 long task handoffs without truncation", () => {
	const tasks = Array.from({ length: 15 }, (_, i) => {
		const id = String(i + 1).padStart(2, "0");
		return task(id, "done", `ROLE-${id}\n${id.repeat(1500)}\nEND-ROLE-${id}`);
	});

	const report = buildCompletionSummary(tasks);
	for (const task of tasks) {
		assert.ok(report.includes(task.output), `full output missing for ${task.id}`);
		assert.ok(report.includes(`END-ROLE-${task.id}`), `tail missing for ${task.id}`);
	}
	assert.ok(report.length > 45_000, "fixture must exceed the former 2,000-character limit by a wide margin");
});

test("completion report preserves cancelled tasks in a distinct neutral section", () => {
	const report = buildCompletionSummary([
		task("done-work", "done", "done-work output"),
		task("obsolete-qa", "cancelled"),
	]);

	assert.match(report, /- done-work \(role-done-work\): done-work output/);
	assert.match(report, /CANCELLED TASKS \(neutral; not successful output\)/);
	assert.match(report, /- obsolete-qa \(role-obsolete-qa\): cancelled/);
	assert.doesNotMatch(report, /obsolete-qa.*done/);
});

test("failure report preserves complete diagnostics", () => {
	const error = `failure-start\n${"diagnostic\n".repeat(1000)}failure-end`;
	const report = buildFailureSummary([task("broken", "failed", null, error)]);
	assert.ok(report.includes(error));
	assert.ok(report.endsWith("failure-end"));
});
