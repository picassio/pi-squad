import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("completion report includes a git working tree snapshot", (t) => {
	const repo = mkdtempSync(join(tmpdir(), "pi-squad-report-git-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	writeFileSync(join(repo, "tracked.txt"), "before\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
	writeFileSync(join(repo, "tracked.txt"), "after\nmore\n");
	writeFileSync(join(repo, "untracked.txt"), "new\n");

	const report = buildCompletionSummary([task("done-work", "done", "full handoff")], repo);
	assert.match(report, /Working Tree Snapshot/);
	assert.match(report, /tracked\.txt\s+\|/);
	assert.match(report, /Untracked files: 1/);
	assert.ok(report.includes("full handoff"));
});

test("completion report for a non-repo cwd is identical to the legacy output", (t) => {
	const nonRepo = mkdtempSync(join(tmpdir(), "pi-squad-report-non-repo-"));
	t.after(() => rmSync(nonRepo, { recursive: true, force: true }));
	const tasks = [task("done-work", "done", "full handoff"), task("obsolete", "cancelled")];

	assert.equal(buildCompletionSummary(tasks, nonRepo), buildCompletionSummary(tasks));
});

test("failure report preserves complete diagnostics", () => {
	const error = `failure-start\n${"diagnostic\n".repeat(1000)}failure-end`;
	const report = buildFailureSummary([task("broken", "failed", null, error)]);
	assert.ok(report.includes(error));
	assert.ok(report.endsWith("failure-end"));
});
