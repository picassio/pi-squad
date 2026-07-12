import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../src/plan-rules.ts";

const task = (id, over = {}) => ({
	id,
	title: id,
	description: "Goal: x. Verify: npm test",
	agent: "fullstack",
	depends: [],
	...over,
});

test("clean plan passes with no errors or warnings", () => {
	const r = validatePlan([
		task("a"),
		task("b", { depends: ["a"] }),
		task("qa-check", { depends: ["b"], agent: "qa" }),
	]);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
});

test("duplicate ids are errors", () => {
	const r = validatePlan([task("a"), task("a")]);
	assert.ok(r.errors.some((e) => e.includes("Duplicate task id")));
});

test("unknown dependency is an error", () => {
	const r = validatePlan([task("a", { depends: ["ghost"] })]);
	assert.ok(r.errors.some((e) => e.includes('unknown task "ghost"')));
});

test("dependency cycle is an error", () => {
	const r = validatePlan([
		task("a", { depends: ["b"] }),
		task("b", { depends: ["a"] }),
	]);
	assert.ok(r.errors.some((e) => e.includes("cycle")));
});

test("no entry task is an error", () => {
	// Both tasks depend on each other's... use valid deps but none empty
	const r = validatePlan([
		task("a", { depends: ["b"] }),
		task("b", { depends: ["c"] }),
		task("c", { depends: ["a"] }),
	]);
	assert.ok(r.errors.length > 0); // cycle also catches this shape
});

test("missing QA task warns at 3+ tasks", () => {
	const r = validatePlan([task("a"), task("b"), task("c")]);
	assert.ok(r.warnings.some((w) => w.includes("QA/verification")));
});

test("QA-like task suppresses the QA warning", () => {
	const r = validatePlan([task("a"), task("b"), task("verify-all", { agent: "qa" })]);
	assert.ok(!r.warnings.some((w) => w.includes("No QA/verification")));
});

test("description without verify criterion warns", () => {
	const r = validatePlan([task("a", { description: "Goal: do stuff" })]);
	assert.ok(r.warnings.some((w) => w.includes("no Verify criterion")));
});

test("empty description warns", () => {
	const r = validatePlan([task("a", { description: "" })]);
	assert.ok(r.warnings.some((w) => w.includes("no description")));
});

test("over-decomposition warns above 9 tasks", () => {
	const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`));
	const r = validatePlan(tasks);
	assert.ok(r.warnings.some((w) => w.includes("over-decomposed")));
});
