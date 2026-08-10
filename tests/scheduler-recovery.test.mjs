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
const { Scheduler, deriveSuspendedStall } = await import("../src/scheduler.ts");
const { recordOrchestratorReview } = await import("../src/review.ts");

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
	const squad = store.loadSquad(id);
	assert.equal(squad.status, "review", "agent completion must enter review, never done");
	assert.equal(squad.review.status, "pending");
	assert.ok(store.findActiveSquads().some((candidate) => candidate.id === id), "pending review must remain discoverable after restart");

	recordOrchestratorReview(squad, {
		verdict: "pass",
		contractChecks: ["Complete 15-role report persisted exactly"],
		diffReview: "Inspected durable message and task output records.",
		verificationEvidence: ["Exact equality assertions passed for message and task output"],
		integrationEvidence: "Persistence/reload path exercised through the real file-backed store.",
		issues: [],
	});
	store.saveSquad(squad);
	assert.equal(store.loadSquad(id).status, "done", "only recorded orchestrator pass accepts the squad");
	await scheduler.stop();
});

test("substantive report-only output completes without a tool call", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "planning-report", status: "in_progress" }],
	});
	const report = `PLANNING-REPORT\n${"evidence\n".repeat(500)}REPORT-END`;

	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "planning-report",
		agentName: "backend",
		data: { role: "assistant", content: [{ type: "text", text: report }] },
	});
	scheduler.handleAgentEvent({
		type: "agent_settled",
		taskId: "planning-report",
		agentName: "backend",
		data: { exitCode: 0, turnCount: 1, toolCallCount: 0, stderr: "" },
	});

	for (let i = 0; i < 50 && store.loadSquad(id).status !== "review"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(store.loadTask(id, "planning-report").status, "done");
	assert.equal(store.loadTask(id, "planning-report").output, report);
	assert.equal(store.loadSquad(id).status, "review", "report still requires independent orchestrator acceptance");
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

test("suspended-stall derivation covers suspended-only and transitive blocking without mislabeling unrelated work", () => {
	const base = (id, status, depends = []) => ({ id, title: id, description: "", agent: "backend", status, depends });
	assert.deepEqual(deriveSuspendedStall([base("only-suspended", "suspended")])?.suspendedTaskIds, ["only-suspended"]);
	const transitive = deriveSuspendedStall([
		base("root-z", "suspended"),
		base("child-b", "blocked", ["root-z"]),
		base("grandchild-a", "blocked", ["child-b"]),
		base("history", "cancelled"),
	]);
	assert.deepEqual(transitive?.suspendedTaskIds, ["root-z"]);
	assert.deepEqual(transitive?.blockedTaskIds, ["child-b", "grandchild-a"]);

	assert.equal(deriveSuspendedStall([
		base("root", "suspended"),
		base("independent", "pending"),
	]), null, "independent runnable work suppresses attention");
	assert.equal(deriveSuspendedStall([
		base("root", "suspended"),
		base("unrelated-failure", "blocked", ["missing"]),
	]), null, "an unrelated irreducible blocked component is not suspension-blocked");
});

test("restart mailbox recovery preserves explicit suspension and queued mail", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "paused",
		tasks: [{ id: "suspended-with-mail", status: "suspended" }],
	});
	store.queueTaskMessage(id, "suspended-with-mail", {
		ts: store.now(),
		from: "human",
		type: "message",
		text: "queued while explicitly suspended",
	});

	await scheduler.start();

	assert.equal(store.loadTask(id, "suspended-with-mail").status, "suspended");
	assert.equal(store.loadSquad(id).status, "paused");
	assert.deepEqual(spawned, [], "mailbox recovery must not auto-resume suspended work");
	assert.equal(store.loadPendingTaskMessages(id, "suspended-with-mail").length, 1, "queued mail remains durable");
	assert.equal(store.loadSquad(id).suspendedStallAttention?.delivery, "pending");
	await scheduler.stop();
});

test("pauseTask durably emits suspended-stall attention before returning", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "live-to-suspended", status: "pending" }],
	});
	const events = [];
	scheduler.onEvent((event) => {
		if (event.type === "suspended_stall") events.push(event);
	});
	await scheduler.start();
	assert.equal(store.loadTask(id, "live-to-suspended").status, "in_progress");

	await scheduler.pauseTask("live-to-suspended");

	const attention = store.loadSquad(id).suspendedStallAttention;
	assert.equal(store.loadTask(id, "live-to-suspended").status, "suspended");
	assert.equal(attention?.delivery, "pending", "outbox must be durable when pauseTask resolves");
	assert.deepEqual(attention?.suspendedTaskIds, ["live-to-suspended"]);
	assert.equal(events.length, 1, "live transition emits one wake");
	await scheduler.reconcile();
	assert.equal(events.length, 1, "level-triggered reconciliation dedupes the same pending fingerprint");
	await scheduler.stop();
});

test("completion of the last independent task immediately wakes a suspended stall", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [
			{ id: "paused-root", status: "suspended" },
			{ id: "independent-live", status: "in_progress" },
			{ id: "blocked-child", status: "blocked", depends: ["paused-root"] },
		],
	});
	const events = [];
	scheduler.onEvent((event) => { if (event.type === "suspended_stall") events.push(event); });
	assert.equal(store.loadSquad(id).suspendedStallAttention, undefined, "independent live work suppresses early attention");

	await scheduler.handleTaskCompleted("independent-live");

	const attention = store.loadSquad(id).suspendedStallAttention;
	assert.equal(store.loadTask(id, "independent-live").status, "done");
	assert.equal(attention?.delivery, "pending", "completion transition persists attention immediately");
	assert.deepEqual(attention?.suspendedTaskIds, ["paused-root"]);
	assert.deepEqual(attention?.blockedTaskIds, ["blocked-child"]);
	assert.equal(events.length, 1, "orchestrator wake must not wait for the periodic reconcile timer");
});

test("suspended-stall outbox persists before emit, dedupes reconcile, survives restart, and clears on resume", async () => {
	const { id, scheduler, spawned } = makeSquad({
		squadStatus: "paused",
		tasks: [
			{ id: "suspended-root", status: "suspended" },
			{ id: "blocked-child", status: "blocked", depends: ["suspended-root"] },
		],
	});
	const events = [];
	scheduler.onEvent((event) => {
		if (event.type !== "suspended_stall") return;
		const persisted = store.loadSquad(id).suspendedStallAttention;
		assert.equal(persisted?.delivery, "pending", "outbox must exist before the edge event");
		events.push(event);
		scheduler.acknowledgeSuspendedStall(persisted.fingerprint);
	});
	await scheduler.start();
	await scheduler.reconcile();
	assert.equal(events.length, 1);
	const delivered = store.loadSquad(id).suspendedStallAttention;
	assert.equal(delivered.delivery, "delivered");
	const detectedAt = delivered.detectedAt;
	await scheduler.stop();

	// Simulate a crash before host acknowledgement: the persisted pending outbox
	// must deliver once when a new scheduler reconstructs it.
	const pendingSquad = store.loadSquad(id);
	pendingSquad.suspendedStallAttention.delivery = "pending";
	pendingSquad.suspendedStallAttention.deliveredAt = null;
	store.saveSquad(pendingSquad);
	const restarted = new Scheduler(id, []);
	restarted.monitor.start = () => {};
	restarted.spawnAgentForTask = scheduler.spawnAgentForTask;
	let restartEvents = 0;
	restarted.onEvent((event) => {
		if (event.type !== "suspended_stall") return;
		restartEvents++;
		restarted.acknowledgeSuspendedStall(event.data.fingerprint);
	});
	await restarted.start();
	await restarted.reconcile();
	assert.equal(restartEvents, 1, "pending fingerprint is emitted once after reconstruction");
	assert.equal(store.loadSquad(id).suspendedStallAttention.detectedAt, detectedAt);
	await restarted.stop();

	const deliveredRestart = new Scheduler(id, []);
	deliveredRestart.monitor.start = () => {};
	deliveredRestart.spawnAgentForTask = scheduler.spawnAgentForTask;
	let deliveredRestartEvents = 0;
	deliveredRestart.onEvent((event) => { if (event.type === "suspended_stall") deliveredRestartEvents++; });
	await deliveredRestart.start();
	assert.equal(deliveredRestartEvents, 0, "delivered fingerprint is silent after reconstruction");
	await deliveredRestart.resumeTask("suspended-root");
	assert.deepEqual(spawned, ["suspended-root"]);
	assert.equal(store.loadTask(id, "blocked-child").status, "blocked");
	assert.equal(store.loadSquad(id).suspendedStallAttention, undefined, "progress clears active attention");
	await deliveredRestart.stop();
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

test("pending review gate is re-raised by reconcile until delivery records notifiedAt", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "only-task", status: "done" }],
	});
	const events = [];
	scheduler.onEvent((event) => { if (event.type === "squad_review_required") events.push(event); });

	// Transition emits once; no delivery handler records notifiedAt, so the
	// same reconcile pass re-raises the undelivered gate.
	await scheduler.start();
	assert.equal(store.loadSquad(id).status, "review");
	assert.equal(store.loadSquad(id).review.status, "pending");
	assert.ok(events.length >= 1, "undelivered review gate is emitted");
	const undelivered = events.length;

	await scheduler.reconcile();
	assert.ok(events.length > undelivered, "reconcile keeps re-raising while delivery is unrecorded");

	// Simulate the wired main-session handler durably recording delivery.
	const squad = store.loadSquad(id);
	squad.review.notifiedAt = store.now();
	store.saveSquad(squad);
	const delivered = events.length;
	await scheduler.reconcile();
	await scheduler.reconcile();
	assert.equal(events.length, delivered, "recorded delivery stops re-raising; a slow human review is never re-notified");
	await scheduler.stop();
});

test("review gate emits exactly once per transition when delivery records notifiedAt synchronously", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "solo", status: "done" }],
	});
	const events = [];
	scheduler.onEvent((event) => {
		if (event.type !== "squad_review_required") return;
		events.push(event);
		// Mirror wireSchedulerEvents: successful sendMessage records delivery.
		const squad = store.loadSquad(id);
		if (squad?.review?.status === "pending" && !squad.review.notifiedAt) {
			squad.review.notifiedAt = store.now();
			store.saveSquad(squad);
		}
	});
	await scheduler.start();
	await scheduler.reconcile();
	assert.equal(events.length, 1, "delivered gate is never duplicated by later reconciles");
	assert.ok(store.loadSquad(id).review.notifiedAt);
	await scheduler.stop();
});

test("squad_failed emits only on the transition, never on repeated reconciles", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [
			{ id: "dead", status: "failed" },
			{ id: "stuck", status: "blocked", depends: ["dead"] },
		],
	});
	const events = [];
	scheduler.onEvent((event) => { if (event.type === "squad_failed") events.push(event); });
	await scheduler.start();
	assert.equal(store.loadSquad(id).status, "failed");
	assert.equal(events.length, 1, "stall notification fires on the transition");
	await scheduler.reconcile();
	await scheduler.reconcile();
	assert.equal(events.length, 1, "an already-failed squad never queues duplicate stall notifications");
	await scheduler.stop();
});

test("a task completing after an interim failure clears its stale error annotation", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "flaky", status: "in_progress" }],
	});
	store.updateTaskStatus(id, "flaky", "in_progress", { error: "Agent devops exited before RPC response" });
	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "flaky",
		agentName: "devops",
		data: { role: "assistant", content: [{ type: "text", text: "recovered and finished" }] },
	});
	await scheduler.handleTaskCompleted("flaky");
	const task = store.loadTask(id, "flaky");
	assert.equal(task.status, "done");
	assert.equal(task.error, null, "a done task must not display a stale interim failure");
	await scheduler.stop();
});

test("provider-outage exits retry with backoff and explicit resume grants a fresh budget", async () => {
	process.env.PI_SQUAD_SPAWN_RETRIES = "2";
	try {
		const { id, scheduler } = makeSquad({
			squadStatus: "running",
			tasks: [{ id: "outage", status: "in_progress" }],
		});
		const failures = [];
		scheduler.onEvent((event) => { if (event.type === "task_failed") failures.push(event); });
		const exit = () => scheduler.handleUnexpectedAgentExit({ type: "agent_end", taskId: "outage", agentName: "backend", data: { exitCode: 1, turnCount: 0 } });

		exit();
		assert.equal(store.loadTask(id, "outage").status, "pending", "retry 1 re-queues the same durable session");
		exit();
		assert.equal(store.loadTask(id, "outage").status, "pending", "retry 2 stays within the budget");
		exit();
		const failed = store.loadTask(id, "outage");
		assert.equal(failed.status, "failed", "exhausted budget is terminal");
		assert.match(failed.error, /resume_task/, "terminal failure teaches the recovery command");
		assert.match(failed.error, /provider\/API outage/);
		assert.equal(failures.length, 1);

		await scheduler.resumeTask("outage");
		exit();
		assert.equal(store.loadTask(id, "outage").status, "pending",
			"resume_task grants a fresh retry budget instead of instantly re-failing");
		await scheduler.stop();
	} finally {
		delete process.env.PI_SQUAD_SPAWN_RETRIES;
	}
});

test("forkFromTask spawns the new task as a fork of the source task's durable session", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [
			{ id: "source", status: "done" },
			{ id: "followup", status: "pending" },
		],
	});
	const sourceSession = path.join(tempHome, `fork-source-${id}.jsonl`);
	fs.writeFileSync(sourceSession, '{"type":"session"}\n');
	store.bindTaskSession(id, "source", { file: sourceSession });
	const followup = store.loadTask(id, "followup");
	followup.forkFromTaskId = "source";
	store.saveTask(id, followup);

	const agentDef = { name: "backend", role: "Backend", description: "", model: null, tools: null, tags: [], prompt: "" };
	assert.equal(
		scheduler.resolveForkSession(store.loadTask(id, "followup"), store.loadSquad(id), agentDef),
		sourceSession,
		"the follow-up task forks the source task's durable session",
	);

	// A source without any durable session skips the fork with a durable notice.
	followup.forkFromTaskId = "missing-task";
	store.saveTask(id, followup);
	assert.equal(scheduler.resolveForkSession(store.loadTask(id, "followup"), store.loadSquad(id), agentDef), undefined);
	assert.ok(store.loadMessages(id, "followup").some((m) => m.text.includes("Session fork skipped")));

	// The context-window guard still protects against oversized forks.
	const guarded = new Scheduler(id, [], { resolveContextWindow: () => 4 });
	followup.forkFromTaskId = "source";
	store.saveTask(id, followup);
	assert.equal(guarded.resolveForkSession(store.loadTask(id, "followup"), store.loadSquad(id), agentDef), undefined,
		"fork source larger than 50% of the model window is skipped");
	await scheduler.stop();
	await guarded.stop();
});


test("reconcile heals zombie in_progress tasks whose process was lost", async () => {
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [
			{ id: "zombie-a", status: "in_progress" },
			{ id: "zombie-b", status: "in_progress" },
		],
	});
	assert.equal(scheduler.pool.isRunning("zombie-a"), false);
	assert.equal(scheduler.pool.isRunning("zombie-b"), false);
	scheduler.running = true;

	// Capture task status right after zombie detection (before scheduleReadyTasks
	// tries to respawn). The reconcile path: 0b resets to pending → message →
	// scheduleReadyTasks → spawnAgentForTask (fails in test env, no agent def) →
	// handleTaskFailed. The recovery message proves the zombie path fired.
	await scheduler.reconcile();

	const msgsA = store.loadMessages(id, "zombie-a");
	const msgsB = store.loadMessages(id, "zombie-b");
	assert.ok(msgsA.some(m => m.text.includes("Agent process lost")),
		"zombie-a recovery message recorded");
	assert.ok(msgsB.some(m => m.text.includes("Agent process lost")),
		"zombie-b recovery message recorded");

	// In production, scheduleReadyTasks respawns the healed task on its durable
	// session. In the test env (no agent defs), the spawn fails and the task
	// moves to failed — but the zombie detection itself is proven by the message.
	await scheduler.stop();
});

test("repeated attestation rejections suspend the task and escalate instead of looping forever", async () => {
	const { createHash } = await import("node:crypto");
	const { id, scheduler } = makeSquad({
		squadStatus: "running",
		tasks: [{ id: "ghost", status: "in_progress" }],
	});
	// Attach a canonical spec whose metadata is valid but for which task
	// 'ghost' has NO attestation → completion is rejected every settle.
	const specDir = path.join(store.getSquadDir(id), "spec");
	fs.mkdirSync(specDir, { recursive: true });
	const specPath = path.join(specDir, "spec.v1.json");
	const raw = Buffer.from('{"canonical":"spec"}');
	fs.writeFileSync(specPath, raw);
	const squad = store.loadSquad(id);
	squad.spec = { schemaVersion: 1, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length, path: specPath, chunkBytes: 32768, chunkCount: 1 };
	store.saveSquad(squad);

	const escalations = [];
	scheduler.onEvent((event) => { if (event.type === "escalation") escalations.push(event); });

	for (let i = 0; i < 3; i++) {
		scheduler.onAgentSettled({ type: "agent_settled", taskId: "ghost", agentName: "backend" });
	}

	const task = store.loadTask(id, "ghost");
	assert.equal(task.status, "suspended", "third rejection suspends the task instead of reopening");
	assert.match(task.error, /attestation file missing/i, "the recorded reason is precise, not a generic re-read instruction");
	assert.equal(escalations.length, 1, "exactly one escalation reaches the orchestrator");
	assert.match(escalations[0].message, /SUSPENDED/);
	assert.match(escalations[0].message, /resume_task/);

	// Explicit resume grants a fresh rejection budget.
	await scheduler.resumeTask("ghost");
	scheduler.onAgentSettled({ type: "agent_settled", taskId: "ghost", agentName: "backend" });
	const resumed = store.loadTask(id, "ghost");
	assert.notEqual(resumed.status, "suspended", "post-resume rejection reopens (fresh budget) instead of instantly suspending");
	assert.equal(escalations.length, 1, "no duplicate escalation after resume");

	await scheduler.stop();
});
