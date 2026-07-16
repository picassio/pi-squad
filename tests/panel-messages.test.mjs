import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-panel-messages-"));
const piTuiEntry = path.join(tempHome, "pi-tui-stub.mjs");
fs.writeFileSync(piTuiEntry, `
export function visibleWidth(value) { return value.replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function truncateToWidth(value, width, suffix = "") {
	if (visibleWidth(value) <= width) return value;
	return value.slice(0, Math.max(0, width - suffix.length)) + suffix;
}
`);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") {
			return { url: pathToFileURL(piTuiEntry).href, shortCircuit: true };
		}
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { MessageView } = await import("../src/panel/message-view.ts");
const { TaskListView } = await import("../src/panel/task-list.ts");
const { setupSquadWidget } = await import("../src/panel/squad-widget.ts");

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function createFixture(squadId, status = "in_progress") {
	store.saveSquad({
		id: squadId,
		goal: "Keep durable messages visible",
		status: "done",
		created: "2026-07-16T09:00:00.000Z",
		cwd: process.cwd(),
		agents: { frontend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 2 },
	});
	store.createTask(squadId, {
		id: "ui-task",
		title: "Durable history",
		description: "Render every durable message",
		agent: "frontend",
		status,
		depends: [],
		created: "2026-07-16T09:00:00.000Z",
		started: "2026-07-16T09:00:01.000Z",
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});
}

function append(squadId, from, type, text, second) {
	store.appendMessage(squadId, "ui-task", {
		ts: `2026-07-16T09:00:${String(second).padStart(2, "0")}.000Z`,
		from,
		type,
		text,
	});
}

test("task panel scrolls from the newest message through full durable history", () => {
	const squadId = "sq-panel-full-history";
	createFixture(squadId);
	append(squadId, "orchestrator", "message", Array.from({ length: 7 }, (_, i) => `old-line-${i + 1}`).join("\n"), 0);
	for (let i = 1; i <= 35; i++) append(squadId, "frontend", "text", `later-message-${i}`, i);

	const view = new MessageView(theme, squadId);
	view.setTaskId("ui-task");
	const newest = view.render(80, 12);
	assert.equal(newest.length, 12, "viewport height stays deterministic");
	assert.ok(newest.some((line) => line.includes("later-message-35")), "opens at newest history");
	assert.ok(newest.some((line) => line.includes("36 msgs")));

	for (let i = 0; i < 200; i++) view.scrollUp();
	const oldest = view.render(80, 12);
	assert.equal(oldest.length, 12, "scrolling does not change viewport height");
	assert.ok(oldest.some((line) => line.includes("ORCHESTRATOR")));
	assert.ok(oldest.some((line) => line.includes("old-line-1")), "messages older than the former 30-message cap remain reachable");
	assert.ok(oldest.some((line) => line.includes("old-line-7")), "message bodies are not line-truncated");
	assert.ok(!oldest.some((line) => line.includes("older messages")));

	for (let i = 0; i < 200; i++) view.scrollDown();
	const returnedToNewest = view.render(80, 12);
	assert.equal(returnedToNewest.length, 12);
	assert.ok(returnedToNewest.some((line) => line.includes("later-message-35")), "down-scroll returns to the live tail");
});

test("task panel labels human and orchestrator messages unambiguously", () => {
	const squadId = "sq-panel-labels";
	createFixture(squadId);
	append(squadId, "orchestrator", "message", "Please check the durable history", 1);
	append(squadId, "human", "message", "I need the complete result", 2);

	const view = new MessageView(theme, squadId);
	view.setTaskId("ui-task");
	const lines = view.render(100, 12);
	assert.ok(lines.some((line) => line.includes("ORCHESTRATOR")));
	assert.ok(lines.some((line) => line.includes("YOU")));
});

test("live preview and compact widget visibly prioritize a recent orchestrator message", () => {
	const squadId = "sq-panel-orchestrator-preview";
	createFixture(squadId);
	append(squadId, "frontend", "tool", "read", 1);
	append(squadId, "orchestrator", "message", "Keep the original durable session", 2);
	append(squadId, "frontend", "tool", "bash", 3);

	const scheduler = { getPool: () => ({ getActivity: () => null }) };
	const taskLines = new TaskListView(theme, squadId).render(100, 0, 18, scheduler);
	assert.ok(taskLines.some((line) => line.includes("ORCHESTRATOR")));
	assert.ok(taskLines.some((line) => line.includes("Keep the original durable session")));

	let widgetFactory;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_id, value) => { if (typeof value === "function") widgetFactory = value; },
			setStatus: () => {},
		},
	};
	const controls = setupSquadWidget(ctx, { squadId, enabled: true });
	try {
		assert.equal(typeof widgetFactory, "function");
		const component = widgetFactory({ terminal: { columns: 120 } }, theme);
		const widgetLines = component.render(120);
		assert.ok(widgetLines[0].includes("✉ ORCH"), "widget header signals recent orchestrator traffic");
		assert.ok(widgetLines.some((line) => line.includes("← ORCH")));
		assert.ok(widgetLines.some((line) => line.includes("Keep the original")));
	} finally {
		controls.dispose();
	}
});
