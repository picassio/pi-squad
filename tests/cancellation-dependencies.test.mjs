import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-cancel-deps-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { Scheduler } = await import("../src/scheduler.ts");

store.saveAgentDef({ name: "backend", role: "Backend", description: "test", model: null, tools: null, tags: [], prompt: "" });
let counter = 0;
function makeSquad(tasks, status = "running") {
	const id = `sq-cancel-deps-${++counter}`;
	store.saveSquad({
		id, goal: "cancellation dependency repair", status, created: store.now(), cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	for (const input of tasks) {
		store.createTask(id, {
			id: input.id, title: input.id, description: input.id, agent: "backend",
			status: input.status, depends: input.depends ?? [], created: store.now(),
			started: input.status === "in_progress" ? store.now() : null,
			completed: ["done", "failed", "cancelled"].includes(input.status) ? store.now() : null,
			output: input.output ?? null, error: input.error ?? (input.status === "failed" ? "boom" : null),
			usage: { inputTokens: 1, outputTokens: 2, cost: 0.01, turns: 1 },
			...(input.session ? { session: input.session } : {}),
		});
	}
	const scheduler = new Scheduler(id, []);
	scheduler.monitor.start = () => {};
	return { id, scheduler };
}

test("cancel_task preflight lists every non-cancelled direct dependent before killing or mutation", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "old-qa", status: "in_progress" },
		{ id: "release-check", status: "blocked", depends: ["old-qa"] },
		{ id: "integration", status: "failed", depends: ["old-qa"] },
		{ id: "published", status: "done", depends: ["old-qa"] },
		{ id: "obsolete-child", status: "cancelled", depends: ["old-qa"] },
	]);
	let killed = false;
	scheduler.pool.isRunning = (taskId) => taskId === "old-qa";
	scheduler.pool.kill = async () => { killed = true; };

	await assert.rejects(() => scheduler.cancelTask("old-qa"), (error) => {
		assert.match(error.message, /Cannot cancel task 'old-qa'/);
		assert.match(error.message, /integration \[failed\]/);
		assert.match(error.message, /release-check \[blocked\]/);
		assert.match(error.message, /published \[done\]/);
		assert.match(error.message, /set_dependencies/);
		return true;
	});
	assert.equal(killed, false);
	assert.equal(store.loadTask(id, "old-qa").status, "in_progress");
});

test("safe cancellation is durable, neutral, history-preserving, and late callbacks cannot overwrite it", async () => {
	const session = { file: path.join(tempHome, "old-qa.jsonl"), sessionId: "durable-session" };
	const { id, scheduler } = makeSquad([
		{ id: "implementation", status: "done" },
		{ id: "old-qa", status: "failed", output: "prior failure output", session },
	], "failed");
	store.queueTaskMessage(id, "old-qa", { ts: store.now(), from: "orchestrator", type: "message", text: "keep mailbox" });

	await scheduler.cancelTask("old-qa");
	const cancelled = store.loadTask(id, "old-qa");
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.error, null);
	assert.ok(cancelled.completed);
	assert.equal(cancelled.output, "prior failure output");
	assert.deepEqual(cancelled.session, session);
	assert.equal(store.loadTaskMailbox(id, "old-qa").length, 1);
	assert.match(store.loadMessages(id, "old-qa").at(-1).text, /cancelled by orchestrator/i);
	assert.equal(store.loadSquad(id).status, "review", "cancelled is neutral when all relevant tasks are done");

	await scheduler.handleTaskCompleted("old-qa");
	scheduler.handleTaskFailed("old-qa", "late child failure");
	assert.equal(store.loadTask(id, "old-qa").status, "cancelled");
});

test("cancelled dependencies never satisfy readiness and only exact resume_task revives cancelled", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "old-qa", status: "cancelled" },
		{ id: "final", status: "blocked", depends: ["old-qa"] },
	]);
	scheduler.running = true;
	scheduler.spawnAgentForTask = async () => assert.fail("cancelled dependency must not make final runnable");
	await scheduler.reconcile();
	assert.equal(store.loadTask(id, "final").status, "blocked");

	await scheduler.resume();
	assert.equal(store.loadTask(id, "old-qa").status, "cancelled", "squad resume preserves cancellation");
	scheduler.spawnAgentForTask = async (task) => store.updateTaskStatus(id, task.id, "in_progress");
	await scheduler.resumeTask("old-qa");
	assert.equal(store.loadTask(id, "old-qa").status, "in_progress", "exact resume_task revives and schedules the leaf");
	await scheduler.stop();
});

test("setDependencies validates atomically and preserves non-runnable lifecycle states", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "a", status: "done" },
		{ id: "b", status: "blocked", depends: ["a"] },
		{ id: "c", status: "cancelled" },
		{ id: "running", status: "in_progress" },
	], "paused");
	const before = JSON.stringify(store.loadAllTasks(id).sort((x, y) => x.id.localeCompare(y.id)));
	for (const dependencies of [["missing"], ["b"], ["a", "a"], ["c"]]) {
		if (dependencies[0] === "c") {
			await scheduler.setDependencies("c", ["b"]);
			assert.equal(store.loadTask(id, "c").status, "cancelled");
			continue;
		}
		await assert.rejects(() => scheduler.setDependencies("b", dependencies));
	}
	await assert.rejects(() => scheduler.setDependencies("a", []), /done/i);
	await assert.rejects(() => scheduler.setDependencies("running", []), /in_progress|running/i);
	assert.deepEqual(store.loadTask(id, "b").depends, ["a"]);
	assert.deepEqual(store.loadTask(id, "c").depends, ["b"]);
	assert.notEqual(JSON.stringify(store.loadAllTasks(id).sort((x, y) => x.id.localeCompare(y.id))), before, "only the one valid edit writes");
});

test("setDependencies rejects transitive cycles without changing disk state", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "a", status: "failed", depends: [] },
		{ id: "b", status: "blocked", depends: ["a"] },
		{ id: "c", status: "blocked", depends: ["b"] },
	]);
	const before = fs.readFileSync(store.getTaskFilePath(id, "a"), "utf8");
	await assert.rejects(() => scheduler.setDependencies("a", ["c"]), /cycle/i);
	assert.equal(fs.readFileSync(store.getTaskFilePath(id, "a"), "utf8"), before);
	assert.deepEqual(store.loadTask(id, "a").depends, []);
});

test("reported obsolete-QA repair reopens the same failed squad and schedules final-check", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "implementation", status: "done" },
		{ id: "old-qa", status: "failed" },
		{ id: "replacement-qa", status: "done" },
		{ id: "final-check", status: "blocked", depends: ["old-qa"] },
	], "failed");
	const spawned = [];
	scheduler.spawnAgentForTask = async (task) => {
		spawned.push(task.id);
		store.updateTaskStatus(id, task.id, "in_progress");
	};

	await assert.rejects(() => scheduler.cancelTask("old-qa"), /final-check/);
	await scheduler.setDependencies("final-check", ["replacement-qa"]);
	assert.equal(store.loadSquad(id).status, "running");
	assert.deepEqual(spawned, ["final-check"]);
	assert.deepEqual(store.loadTask(id, "final-check").depends, ["replacement-qa"]);
	await scheduler.cancelTask("old-qa");
	assert.equal(store.loadTask(id, "old-qa").status, "cancelled");
	await scheduler.stop();
});

test("cancel succeeds when every direct dependent is already cancelled without cascading", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "parent", status: "failed" },
		{ id: "cancelled-child", status: "cancelled", depends: ["parent"] },
	]);
	await scheduler.cancelTask("parent");
	assert.equal(store.loadTask(id, "parent").status, "cancelled");
	assert.equal(store.loadTask(id, "cancelled-child").status, "cancelled");
	assert.deepEqual(store.loadTask(id, "cancelled-child").depends, ["parent"]);
	assert.equal(store.loadSquad(id).status, "review", "an all-cancelled squad reaches mandatory review");
});

test("setDependencies recomputes pending/blocked while preserving failed and paused squad state", async () => {
	const { id, scheduler } = makeSquad([
		{ id: "done-dep", status: "done" },
		{ id: "unmet", status: "failed" },
		{ id: "pending-target", status: "pending" },
		{ id: "failed-target", status: "failed" },
	], "paused");
	await scheduler.setDependencies("pending-target", ["unmet"]);
	assert.equal(store.loadTask(id, "pending-target").status, "blocked");
	await scheduler.setDependencies("failed-target", ["done-dep"]);
	assert.equal(store.loadTask(id, "failed-target").status, "failed");
	assert.equal(store.loadTask(id, "failed-target").error, "boom");
	assert.equal(store.loadSquad(id).status, "paused");
});

test("legacy cancellation sentinel is read-normalized and canonicalized on the next write", () => {
	const { id } = makeSquad([{ id: "legacy", status: "failed", error: "Cancelled by user" }]);
	assert.equal(store.loadTask(id, "legacy").status, "cancelled");
	assert.equal(store.loadTask(id, "legacy").error, null);
	store.saveTask(id, store.loadTask(id, "legacy"));
	const persisted = JSON.parse(fs.readFileSync(store.getTaskFilePath(id, "legacy"), "utf8"));
	assert.equal(persisted.status, "cancelled");
	assert.equal(persisted.error, null);
});

test("restart reconciliation preserves cancelled task and its pending mailbox", async () => {
	const { id } = makeSquad([
		{ id: "cancelled-work", status: "cancelled", session: { file: path.join(tempHome, "cancelled.jsonl") } },
		{ id: "other", status: "done" },
	], "running");
	store.queueTaskMessage(id, "cancelled-work", { ts: store.now(), from: "orchestrator", type: "message", text: "retain after restart" });
	const reconstructed = new Scheduler(id, []);
	reconstructed.monitor.start = () => {};
	const spawned = [];
	reconstructed.spawnAgentForTask = async (task) => spawned.push(task.id);
	await reconstructed.start();
	assert.equal(store.loadTask(id, "cancelled-work").status, "cancelled");
	assert.equal(store.loadPendingTaskMessages(id, "cancelled-work").length, 1);
	assert.deepEqual(spawned, []);
	assert.equal(store.loadSquad(id).status, "review");
	await reconstructed.stop();
});
