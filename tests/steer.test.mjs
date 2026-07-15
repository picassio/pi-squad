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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-steer-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { AgentPool } = await import("../src/agent-pool.ts");
const { Scheduler } = await import("../src/scheduler.ts");
const store = await import("../src/store.ts");

function attachFakeRunningAgent(pool, taskId = "qa-task", agentName = "qa") {
	const writes = [];
	const kills = [];
	const process = {
		stdin: {
			destroyed: false,
			write: (data) => { writes.push(data.toString()); return true; },
		},
		exitCode: null,
		killed: false,
		kill: (signal) => { kills.push(signal); process.killed = true; return true; },
	};
	const agent = {
		taskId,
		agentName,
		process,
		activity: {
			taskId,
			agentName,
			lastOutputTs: Date.now(),
			startedAt: Date.now(),
			turnCount: 0,
			recentToolCalls: [],
			modifiedFiles: new Set(),
		},
		pendingMessages: [],
		aborted: false,
	};
	pool.agents.set(taskId, agent);
	return { agent, writes, kills };
}

test("main-session steer writes the documented Pi RPC command exactly", async () => {
	const pool = new AgentPool();
	const { writes } = attachFakeRunningAgent(pool);
	assert.equal(pool.getTaskIdForAgent("qa"), "qa-task");

	const sent = await pool.steer("qa-task", "[squad] Main orchestrator: use the completed contract");
	assert.equal(sent, true);
	assert.equal(writes.length, 1);
	assert.deepEqual(JSON.parse(writes[0]), {
		type: "steer",
		message: "[squad] Main orchestrator: use the completed contract",
	});
	assert.ok(writes[0].endsWith("\n"), "RPC framing must be JSONL/LF");
});

test("scheduler main-session message persists fully and steers the live task", async () => {
	const id = "sq-main-steer";
	store.saveSquad({
		id,
		goal: "verify main steering",
		status: "running",
		created: store.now(),
		cwd: tempHome,
		agents: { qa: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(id, {
		id: "qa-task",
		title: "QA",
		description: "Verify steering",
		agent: "qa",
		status: "in_progress",
		depends: [],
		created: store.now(),
		started: store.now(),
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});
	const scheduler = new Scheduler(id, []);
	const pool = scheduler.getPool();
	const { writes } = attachFakeRunningAgent(pool);
	const message = `Use the complete contract\n${"detail\n".repeat(1000)}MESSAGE-END`;

	assert.equal(pool.getTaskIdForAgent("qa"), "qa-task", "agent-name targeting resolves to live task");
	assert.equal(await scheduler.sendHumanMessage("qa-task", message), true);
	assert.deepEqual(JSON.parse(writes[0]), { type: "steer", message: `[squad] Human: ${message}` });
	const durable = store.loadMessages(id, "qa-task").at(-1);
	assert.equal(durable.from, "human");
	assert.equal(durable.text, message, "main message is persisted without truncation");
	pool.agents.delete("qa-task");
});

test("agent_end does not kill queued steer; only agent_settled finalizes the child", () => {
	const pool = new AgentPool();
	const { agent, kills } = attachFakeRunningAgent(pool);
	const events = [];
	pool.onEvent((event) => events.push(event));

	pool.handleRpcEvent(agent, { type: "agent_end", messages: [], willRetry: false });
	assert.equal(pool.isRunning("qa-task"), true, "agent_end is low-level and steer continuations may remain");
	assert.deepEqual(kills, []);
	assert.equal(events.filter((event) => event.type === "agent_end").length, 0);

	pool.handleRpcEvent(agent, { type: "agent_settled" });
	assert.equal(pool.isRunning("qa-task"), false);
	assert.deepEqual(kills, ["SIGTERM"]);
	assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
});

test("steer reports false when child stdin is unavailable", async () => {
	const pool = new AgentPool();
	const { agent, writes } = attachFakeRunningAgent(pool);
	agent.process.stdin.destroyed = true;
	assert.equal(await pool.steer("qa-task", "message"), false);
	assert.deepEqual(writes, []);
});
