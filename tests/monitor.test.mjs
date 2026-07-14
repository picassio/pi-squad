import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// src/*.ts files use ".js" relative import specifiers (jiti/tsc style). Node's
// native type stripping does not rewrite them, so map ./x.js → ./x.ts when the
// .js target does not exist.
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

// Configure a tiny long-run threshold BEFORE importing the monitor (env is
// read at module load).
process.env.PI_SQUAD_CEILING_MS = "1000";

const { Monitor } = await import("../src/monitor.ts");

function makePool(activity) {
	return {
		getRunningAgents: () => ["frontend"],
		getTaskIdForAgent: () => "task-1",
		getActivity: () => activity,
	};
}

test("long-running agents produce notify (never abort) once per threshold multiple", () => {
	const now = Date.now();
	const activity = {
		lastOutputTs: now, // actively producing output — not idle/stuck
		startedAt: now - 1500, // 1.5× the 1s threshold
		recentToolCalls: ["read", "edit", "bash"],
	};
	const monitor = new Monitor(makePool(activity), "squad-1");
	const actions = [];
	monitor.onAction((a) => actions.push(a));

	// First check: one notify
	monitor["checkAll"]();
	assert.equal(actions.length, 1);
	assert.equal(actions[0].type, "notify");
	assert.match(actions[0].reason, /task-1/);
	assert.ok(!actions.some((a) => a.type === "abort"), "monitor must never abort");

	// Same multiple: no repeat notification
	monitor["checkAll"]();
	assert.equal(actions.length, 1);

	// Cross the next multiple (2×): notify again
	activity.startedAt = now - 2500;
	monitor["checkAll"]();
	assert.equal(actions.length, 2);
	assert.equal(actions[1].type, "notify");
});

test("checkHealth classifies long-running work without failing it", () => {
	const monitor = new Monitor(makePool(null), "squad-1");
	const now = Date.now();
	assert.equal(
		monitor.checkHealth({ lastOutputTs: now, startedAt: now - 5000, recentToolCalls: [] }),
		"long_running",
	);
	assert.equal(
		monitor.checkHealth({ lastOutputTs: now, startedAt: now, recentToolCalls: [] }),
		"healthy",
	);
});
