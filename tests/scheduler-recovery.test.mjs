import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Map ./x.js → ./x.ts for src imports (Node type stripping doesn't rewrite).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try {
				return nextResolve(specifier, context);
			} catch {
				return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
			}
		}
		return nextResolve(specifier, context);
	},
});

// Isolate squad storage (~/.pi/squad) in a temp HOME before importing store.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-recovery-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { Scheduler } = await import("../src/scheduler.ts");

let squadCounter = 0;

function makeSquad({ squadStatus, tasks }) {
	const id = `sq-recovery-${++squadCounter}`;
	store.saveSquad({
		id,
		goal: "test recovery",
		status: squadStatus,
		created: store.now(),
		cwd: tempHome,
		agents: {},
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: false, maxRetries: 2 },
	});
	for (const t of tasks) {
		store.createTask(id, {
			id: t.id,
			title: t.id,
			description: "",
			agent: "backend",
			status: t.status,
			depends: t.depends ?? [],
			created: store.now(),
			started: null,
			completed: null,
			output: null,
			error: t.status === "failed" ? "boom" : null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		});
	}
	const scheduler = new Scheduler(id, []);
	// Stub agent spawning — record instead of launching real pi processes.
	const spawned = [];
	scheduler.spawnAgentForTask = async (task) => {
		spawned.push(task.id);
		store.updateTaskStatus(id, task.id, "in_progress");
	};
	// Silence monitor timer in tests
	scheduler.monitor.start = () => {};
	return { id, scheduler, spawned };
}

test("assistant handoffs are persisted and promoted to task output without truncation", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "report", status: "in_progress" }],
	});
	const report = Array.from({ length: 15 }, (_, i) =>
		`ROLE-${i + 1}\n${String(i + 1).repeat(1000)}\nEND-ROLE-${i + 1}`,
	).join("\n\n");
	assert.ok(report.length > 15_000);

	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "report",
		agentName: "backend",
		data: { role: "assistant", content: [{ type: "text", text: report }] },
	});

	const messages = store.loadMessages(id, "report");
	assert.equal(messages.at(-1).text, report, "durable message must equal the complete report");

	await scheduler.handleTaskCompleted("report");
	assert.equal(store.loadTask(id, "report").output, report, "task handoff must equal the complete report");
	await scheduler.stop();
});

test("resume() recovers a terminal-failed squad: failed tasks reset and respawn", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "failed",
		tasks: [
			{ id: "frontend", status: "failed" },
			{ id: "crosscut", status: "pending", depends: ["frontend"] },
		],
	});

	await scheduler.resume();

	assert.equal(store.loadSquad(id).status, "running");
	assert.deepEqual(spawned, ["frontend"]); // failed → pending → respawned
	assert.equal(store.loadTask(id, "frontend").error, null);
	await scheduler.stop();
});

test("reconcile() heals out-of-band recovery: dep marked done directly, squad failed", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "failed",
		tasks: [
			{ id: "frontend", status: "failed" },
			{ id: "crosscut", status: "pending", depends: ["frontend"] },
		],
	});

	// Out-of-band recovery: direct store write, no scheduler event (the incident).
	store.updateTaskStatus(id, "frontend", "done", { output: "recovered", completed: store.now() });

	scheduler.running = true; // reconcile is a no-op on a stopped scheduler
	await scheduler.reconcile();

	assert.equal(store.loadSquad(id).status, "running", "failed squad with runnable work self-heals");
	assert.deepEqual(spawned, ["crosscut"], "dependent transitions pending → running");
	await scheduler.stop();
});

test("reconcile() unblocks blocked tasks whose deps are all done", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "running",
		tasks: [
			{ id: "api", status: "done" },
			{ id: "ui", status: "blocked", depends: ["api"] },
		],
	});

	scheduler.running = true;
	await scheduler.reconcile();

	assert.deepEqual(spawned, ["ui"]);
	await scheduler.stop();
});

test("completeTask() routes recovery through the completion flow (unblock + schedule)", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "failed",
		tasks: [
			{ id: "frontend", status: "failed" },
			{ id: "crosscut", status: "blocked", depends: ["frontend"] },
		],
	});

	scheduler.running = true;
	await scheduler.completeTask("frontend", "work recovered from worktree");

	const frontend = store.loadTask(id, "frontend");
	assert.equal(frontend.status, "done");
	assert.equal(frontend.output, "work recovered from worktree");
	assert.deepEqual(spawned, ["crosscut"], "blocked dependent unblocked and scheduled");
	assert.equal(store.loadSquad(id).status, "running", "squad healed from failed");
	await scheduler.stop();
});

test("reconcile() leaves genuinely stalled squads failed (no runnable work)", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "failed",
		tasks: [
			{ id: "a", status: "failed" },
			{ id: "b", status: "blocked", depends: ["a"] },
		],
	});

	scheduler.running = true;
	await scheduler.reconcile();

	assert.equal(store.loadSquad(id).status, "failed", "no runnable work — stays failed");
	assert.deepEqual(spawned, []);
	await scheduler.stop();
});
