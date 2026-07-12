import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAdvisorConsultText,
	formatAdvisorSteerMessage,
	adviceNeedsHuman,
} from "../src/advisor.ts";

const baseInput = {
	taskId: "auth-api",
	taskTitle: "Build auth API",
	taskDescription: "Goal: JWT auth endpoints. Verify: npm test -- auth",
	agentName: "backend",
	agentRole: "Backend Engineer",
	reason: "no output for 5 minutes",
	recentMessages: [
		{ from: "backend", type: "text", text: "Trying to fix the migration error" },
	],
	recentToolCalls: ["bash: npm test (failed)", "edit src/db.ts"],
	turnCount: 14,
	elapsedMinutes: 12.4,
};

test("consult text includes task, reason, activity, and messages", () => {
	const text = buildAdvisorConsultText(baseInput);
	assert.ok(text.includes("auth-api"));
	assert.ok(text.includes("no output for 5 minutes"));
	assert.ok(text.includes("bash: npm test (failed)"));
	assert.ok(text.includes("Trying to fix the migration error"));
	assert.ok(text.includes("14 turns"));
});

test("consult text clamps long messages", () => {
	const text = buildAdvisorConsultText({
		...baseInput,
		recentMessages: [{ from: "backend", type: "text", text: "x".repeat(2000) }],
	});
	assert.ok(!text.includes("x".repeat(500)));
	assert.ok(text.includes("…"));
});

test("consult text tails messages to 12", () => {
	const messages = Array.from({ length: 30 }, (_, i) => ({
		from: "backend",
		type: "text",
		text: `msg-${i}`,
	}));
	const text = buildAdvisorConsultText({ ...baseInput, recentMessages: messages });
	assert.ok(!text.includes("msg-0 "));
	assert.ok(text.includes("msg-29"));
});

test("steer message wraps advice with execution instruction", () => {
	const msg = formatAdvisorSteerMessage("Course-correct\n1. Run npm test", "looping");
	assert.ok(msg.startsWith("[squad advisor]"));
	assert.ok(msg.includes("looping"));
	assert.ok(msg.includes("Course-correct"));
	assert.ok(msg.includes("state the conflict explicitly"));
});

test("adviceNeedsHuman detects the verdict near the top only", () => {
	assert.equal(adviceNeedsHuman("Needs human input\n1. Ask which provider to use"), true);
	assert.equal(adviceNeedsHuman("Course-correct\n1. Fix the test"), false);
	// mention far into the body doesn't trigger
	assert.equal(adviceNeedsHuman(`Course-correct\n${"a".repeat(300)}\nneeds human input maybe`), false);
});
