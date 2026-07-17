import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-status-presentation-"));
const stubsDir = path.join(tempHome, "stubs");
fs.mkdirSync(stubsDir, { recursive: true });
const typeboxStub = path.join(stubsDir, "typebox.mjs");
const piAiStub = path.join(stubsDir, "pi-ai.mjs");
const piTuiStub = path.join(stubsDir, "pi-tui.mjs");
fs.writeFileSync(typeboxStub, `export const Type = new Proxy({}, { get: () => (..._args) => ({}) });\n`);
fs.writeFileSync(piAiStub, `export async function completeSimple() { throw new Error("not used"); }\n`);
fs.writeFileSync(piTuiStub, `
export function visibleWidth(value) { return value.length; }
export function truncateToWidth(value, width, suffix = "") { return value.length <= width ? value : value.slice(0, Math.max(0, width - suffix.length)) + suffix; }
export function matchesKey() { return false; }
`);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") return { url: pathToFileURL(typeboxStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai") return { url: pathToFileURL(piAiStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(piTuiStub).href, shortCircuit: true };
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.PI_SQUAD_CHILD;

const store = await import("../src/store.ts");
const { default: registerExtension } = await import("../src/index.ts");

function apiFixture() {
	const tools = new Map();
	return {
		tools,
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand() {},
		on() {},
		getThinkingLevel() { return "medium"; },
		sendMessage() {},
	};
}

function saveStatusFixture(id, reviewStatus) {
	store.saveSquad({
		id,
		goal: "Make acceptance state explicit",
		status: "review",
		created: "2026-07-17T00:00:00.000Z",
		cwd: tempHome,
		agents: { qa: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		review: {
			status: reviewStatus,
			requestedAt: "2026-07-17T00:01:00.000Z",
			completedAt: reviewStatus === "failed" ? "2026-07-17T00:02:00.000Z" : null,
			verdict: reviewStatus === "failed" ? "fail" : null,
			contractChecks: [], diffReview: "", verificationEvidence: [], integrationEvidence: "", issues: [],
		},
	});
	store.createTask(id, {
		id: "reviewed-work", title: "Reviewed work", description: "", agent: "qa", status: "done", depends: [],
		created: "2026-07-17T00:00:00.000Z", started: null, completed: "2026-07-17T00:01:00.000Z",
		output: "candidate", error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});
	store.saveContext(id, {
		goal: "Make acceptance state explicit", status: "review", elapsed: "2m", costs: { total: 0, byAgent: {} },
		agents: {}, tasks: { "reviewed-work": { status: "done", agent: "qa", title: "Reviewed work" } },
		recentActivity: [], modifiedFiles: {},
	});
}

test("squad_status distinguishes pending from failed review", async () => {
	const pendingId = "sq-status-review-pending";
	const failedId = "sq-status-review-failed";
	saveStatusFixture(pendingId, "pending");
	saveStatusFixture(failedId, "failed");
	const api = apiFixture();
	registerExtension(api);
	const status = api.tools.get("squad_status");
	const ctx = { cwd: tempHome };
	const pending = (await status.execute("pending", { squadId: pendingId }, undefined, undefined, ctx)).content[0].text;
	const failed = (await status.execute("failed", { squadId: failedId }, undefined, undefined, ctx)).content[0].text;
	assert.match(pending, /Acceptance: ◆ REVIEW PENDING · independent review required/);
	assert.doesNotMatch(pending, /REVIEW FAILED/);
	assert.match(failed, /Acceptance: ✗ REVIEW FAILED · awaiting same-squad rework/);
	assert.doesNotMatch(failed, /REVIEW PENDING/);
});

test("squad_status preserves suspended IDs and exact-squad resume guidance", async () => {
	const id = "sq-status-suspended-attention";
	saveStatusFixture(id, "pending");
	const squad = store.loadSquad(id);
	squad.suspendedStallAttention = {
		kind: "suspended_stall",
		fingerprint: "suspended-root|blocked-child|blocked-grandchild",
		suspendedTaskIds: ["suspended-root"],
		blockedTaskIds: ["blocked-child", "blocked-grandchild"],
		detectedAt: "2026-07-17T00:03:00.000Z",
		delivery: "delivered",
		deliveredAt: "2026-07-17T00:03:01.000Z",
	};
	store.saveSquad(squad);
	const api = apiFixture();
	registerExtension(api);
	const result = await api.tools.get("squad_status").execute("attention", { squadId: id }, undefined, undefined, { cwd: tempHome });
	const text = result.content[0].text;
	assert.match(text, /SUSPENDED — explicit resume required/);
	assert.match(text, /Suspended task IDs: suspended-root/);
	assert.match(text, /Blocked by suspended work: blocked-child, blocked-grandchild/);
	assert.match(text, /No task was resumed automatically/);
	assert.match(text, /action: "resume_task", squadId: "sq-status-suspended-attention", taskId: "<exact-task-id>"/);
});
