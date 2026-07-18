import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const { coerceInlineSquadStart } = await import("../src/inline-input.ts");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(repoRoot, "src", "skills", "squad-plan", "validate-spec.mjs");

const goodTasks = [
	{ id: "contract", title: "Contract", agent: "architect", depends: [] },
	{ id: "build", title: "Build", agent: "backend", depends: ["contract"], description: "Goal: build. Verify: npm test.", inheritContext: false },
];

test("structured inline input passes through unchanged", () => {
	const result = coerceInlineSquadStart({ goal: "ship it", tasks: goodTasks, agents: { backend: { model: "openai/gpt-5" } }, config: { maxConcurrency: 3 } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.value.tasks, goodTasks);
	assert.deepEqual(result.value.agents, { backend: { model: "openai/gpt-5" } });
	assert.deepEqual(result.value.config, { maxConcurrency: 3 });
});

test("JSON-stringified tasks, agents, and config are decoded", () => {
	const result = coerceInlineSquadStart({
		goal: "ship it",
		tasks: JSON.stringify(goodTasks),
		agents: JSON.stringify({ qa: { thinking: "high" } }),
		config: JSON.stringify({ maxConcurrency: 2, autoUnblock: true, maxRetries: 1 }),
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.value.tasks, goodTasks);
	assert.deepEqual(result.value.agents, { qa: { thinking: "high" } });
	assert.deepEqual(result.value.config, { maxConcurrency: 2, autoUnblock: true, maxRetries: 1 });
});

test("invalid JSON strings and wrong shapes return precise errors", () => {
	const badJson = coerceInlineSquadStart({ goal: "g", tasks: "[{oops" });
	assert.equal(badJson.ok, false);
	assert.match(badJson.error, /tasks arrived as a JSON string/);

	const notArray = coerceInlineSquadStart({ goal: "g", tasks: JSON.stringify({ id: "x" }) });
	assert.equal(notArray.ok, false);
	assert.match(notArray.error, /tasks must be an array/);

	const missingAgent = coerceInlineSquadStart({ goal: "g", tasks: [{ id: "a", title: "A" }] });
	assert.equal(missingAgent.ok, false);
	assert.match(missingAgent.error, /tasks\[0\]\.agent/);

	const badDepends = coerceInlineSquadStart({ goal: "g", tasks: [{ id: "a", title: "A", agent: "qa", depends: [1] }] });
	assert.equal(badDepends.ok, false);
	assert.match(badDepends.error, /depends must be an array of task-id strings/);

	const badConfig = coerceInlineSquadStart({ goal: "g", config: JSON.stringify({ maxConcurrency: "two" }) });
	assert.equal(badConfig.ok, false);
	assert.match(badConfig.error, /maxConcurrency must be a number/);

	const badGoal = coerceInlineSquadStart({ goal: "   " });
	assert.equal(badGoal.ok, false);
	assert.match(badGoal.error, /goal must be a nonempty string/);
});

test("squad-plan validator accepts a strict v1 spec and prints its exact sha256", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-plan-skill-"));
	try {
		const spec = {
			schemaVersion: 1,
			goal: "Validate the squad-plan skill validator end to end",
			tasks: [
				{ id: "only-task", title: "Only task", description: "Goal: prove validity. Verify: validator prints VALID.", agent: "qa", depends: [], inheritContext: false, artifactRefs: [] },
			],
			agents: { qa: { model: null, thinking: null } },
			config: { maxConcurrency: 1, autoUnblock: true, maxRetries: 0 },
			artifacts: [],
		};
		const specPath = path.join(dir, "spec.v1.json");
		fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
		const out = execFileSync(process.execPath, [validator, specPath], { encoding: "utf8", cwd: dir });
		assert.match(out, /^VALID$/m);
		const sha = out.match(/specSha256: ([a-f0-9]{64})/)?.[1];
		assert.ok(sha, "validator prints a lowercase sha256");
		assert.match(out, /tasks:\s+1/);
		assert.match(out, new RegExp(`specSha256: "${sha}"`), "prints a ready-to-use squad call");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("squad-plan validator rejects a malformed spec with the tool's exact error", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-plan-skill-bad-"));
	try {
		// Missing required task keys and undeclared agent.
		const spec = {
			schemaVersion: 1,
			goal: "broken",
			tasks: [{ id: "a", title: "A", agent: "ghost" }],
			agents: {},
			config: { maxConcurrency: 1, autoUnblock: true, maxRetries: 0 },
			artifacts: [],
		};
		const specPath = path.join(dir, "bad.v1.json");
		fs.writeFileSync(specPath, JSON.stringify(spec));
		let failed = false;
		try {
			execFileSync(process.execPath, [validator, specPath], { encoding: "utf8", cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			failed = true;
			assert.equal(error.status, 1);
			assert.match(String(error.stderr), /INVALID: SPEC_MALFORMED/);
		}
		assert.equal(failed, true, "validator exits nonzero for malformed specs");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
