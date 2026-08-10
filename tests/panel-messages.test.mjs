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

test("cancelled tasks stay visible with a neutral icon and active-task counts", () => {
	const squadId = "sq-panel-cancelled-status";
	createFixture(squadId, "done");
	store.createTask(squadId, {
		id: "obsolete-qa",
		title: "Obsolete QA",
		description: "Retain cancellation in history",
		agent: "qa",
		status: "cancelled",
		depends: [],
		created: "2026-07-16T09:00:00.000Z",
		started: null,
		completed: "2026-07-16T09:00:02.000Z",
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});

	const scheduler = { getPool: () => ({ getActivity: () => null }) };
	const taskLines = new TaskListView(theme, squadId).render(100, 0, 12, scheduler);
	assert.ok(taskLines.some((line) => line.includes("⊘ obsolete-qa (qa) cancelled")));
	assert.ok(taskLines.some((line) => line.includes("1/1 active tasks done · 1 cancelled · 2 total")));

	let widgetFactory;
	let statusText;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_id, value) => { if (typeof value === "function") widgetFactory = value; },
			setStatus: (_id, value) => { statusText = value; },
		},
	};
	const controls = setupSquadWidget(ctx, { squadId, enabled: true });
	try {
		const widgetLines = widgetFactory({ terminal: { columns: 120 } }, theme).render(120);
		assert.ok(widgetLines.some((line) => line.includes("⊘ obsolete-qa (qa) cancelled")));
		assert.ok(widgetLines[0].includes("1/1 active tasks done · 1 cancelled · 2 total"));
		assert.ok(statusText.includes("1/1 active tasks done · 1 cancelled · 2 total"));
	} finally {
		controls.dispose();
	}
});

test("refreshNow switches the installed widget to the exact focused squad synchronously", () => {
	const firstId = "sq-widget-focus-first";
	const secondId = "sq-widget-focus-second";
	createFixture(firstId, "done");
	createFixture(secondId, "done");
	const first = store.loadSquad(firstId); first.goal = "FIRST_WIDGET_GOAL"; store.saveSquad(first);
	const second = store.loadSquad(secondId); second.goal = "SECOND_WIDGET_GOAL"; store.saveSquad(second);
	let widgetFactory;
	const state = { squadId: firstId, enabled: true };
	const controls = setupSquadWidget({ hasUI: true, ui: {
		theme,
		setWidget: (_id, value) => { if (typeof value === "function") widgetFactory = value; },
		setStatus: () => {},
	} }, state);
	try {
		const component = widgetFactory({ terminal: { columns: 160 } }, theme);
		assert.ok(component.render(160)[0].includes("FIRST_WIDGET_GOAL"));
		state.squadId = secondId;
		controls.refreshNow();
		const switched = component.render(160)[0];
		assert.ok(switched.includes("SECOND_WIDGET_GOAL"));
		assert.ok(!switched.includes("FIRST_WIDGET_GOAL"));
	} finally {
		controls.dispose();
	}
});

test("pending and failed independent review render distinctly and invalidate widget cache", async () => {
	const squadId = "sq-panel-review-presentation";
	createFixture(squadId, "done");
	const squad = store.loadSquad(squadId);
	squad.status = "review";
	squad.review = {
		status: "pending",
		requestedAt: "2026-07-16T09:01:00.000Z",
		completedAt: null,
		verdict: null,
		contractChecks: [],
		diffReview: "",
		verificationEvidence: [],
		integrationEvidence: "",
		issues: [],
	};
	store.saveSquad(squad);

	let widgetFactory;
	const statuses = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_id, value) => { if (typeof value === "function") widgetFactory = value; },
			setStatus: (_id, value) => { statuses.push(value); },
		},
	};
	const controls = setupSquadWidget(ctx, { squadId, enabled: true });
	try {
		const component = widgetFactory({ terminal: { columns: 160 } }, theme);
		assert.ok(component.render(160)[0].includes("◆ REVIEW PENDING · independent review required"));
		assert.ok(statuses.at(-1).includes("REVIEW PENDING"));

		const failed = store.loadSquad(squadId);
		failed.review = {
			...failed.review,
			status: "failed",
			completedAt: "2026-07-16T09:02:00.000Z",
			verdict: "fail",
			issues: ["Candidate still violates the contract"],
		};
		store.saveSquad(failed);
		const statusCountBefore = statuses.length;
		controls.requestUpdate();
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.ok(component.render(160)[0].includes("✗ REVIEW FAILED · awaiting same-squad rework"));
		assert.ok(statuses.at(-1).includes("REVIEW FAILED · awaiting same-squad rework"));
		assert.equal(statuses.length, statusCountBefore + 1, "review.status changes the render cache key");

		const scheduler = { getPool: () => ({ getActivity: () => null }) };
		const detail = new TaskListView(theme, squadId).render(160, 0, 12, scheduler);
		assert.ok(detail.some((line) => line.includes("REVIEW FAILED · awaiting same-squad rework")));
		assert.ok(!detail.some((line) => line.includes("REVIEW PENDING")));
	} finally {
		controls.dispose();
	}
});

test("suspended attention shows exact IDs and widget clears when focus is cleared", async () => {
	const squadId = "sq-panel-suspended-attention";
	createFixture(squadId, "suspended");
	const squad = store.loadSquad(squadId);
	squad.status = "paused";
	squad.suspendedStallAttention = {
		kind: "suspended_stall",
		fingerprint: "ui-task|blocked-child|blocked-grandchild",
		suspendedTaskIds: ["ui-task"],
		blockedTaskIds: ["blocked-child", "blocked-grandchild"],
		detectedAt: "2026-07-16T09:03:00.000Z",
		delivery: "delivered",
		deliveredAt: "2026-07-16T09:03:01.000Z",
	};
	store.saveSquad(squad);

	let widgetFactory;
	const widgetValues = [];
	const statusValues = [];
	const state = { squadId, enabled: true };
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_id, value) => {
				widgetValues.push(value);
				if (typeof value === "function") widgetFactory = value;
			},
			setStatus: (_id, value) => { statusValues.push(value); },
		},
	};
	const controls = setupSquadWidget(ctx, state);
	try {
		const component = widgetFactory({ terminal: { columns: 180 } }, theme);
		assert.ok(component.render(180).some((line) => line.includes("SUSPENDED — explicit resume required")));

		const scheduler = { getPool: () => ({ getActivity: () => null }) };
		const detail = new TaskListView(theme, squadId).render(180, 0, 16, scheduler).join("\n");
		assert.match(detail, /Suspended task IDs: ui-task/);
		assert.match(detail, /Blocked by suspended work: blocked-child, blocked-grandchild/);
		assert.match(detail, /squadId: "sq-panel-suspended-attention"/);

		state.squadId = null;
		controls.requestUpdate();
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(widgetValues.at(-1), undefined, "cleared focus removes the compact widget");
		assert.equal(statusValues.at(-1), undefined, "cleared focus removes the status line");
	} finally {
		controls.dispose();
	}
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

test("widget repaints via tui.requestRender on updates and live squads bypass the render cache", async () => {
	const squadId = "sq-widget-repaint";
	store.saveSquad({
		id: squadId, goal: "live repaint", status: "running", created: store.now(), cwd: process.cwd(),
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 2 },
	});
	store.createTask(squadId, {
		id: "busy", title: "Busy", description: "", agent: "backend", status: "in_progress", depends: [],
		created: store.now(), started: store.now(), completed: null, output: null, error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});

	let widgetFactory = null;
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_id, factory) => { widgetFactory = factory; },
			setStatus: () => {},
		},
	};
	const controls = setupSquadWidget(ctx, { squadId, enabled: true });
	try {
		assert.ok(widgetFactory, "widget installed");
		// The factory hands the TUI to the widget; later refreshes must repaint.
		widgetFactory({ terminal: { columns: 120 }, requestRender: () => { renderRequests++; } }, theme);

		// A running task makes the cache key time-bucketed: a later refresh
		// re-renders (and requests a repaint) even with identical task state.
		const before = renderRequests;
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		controls.refreshNow();
		assert.ok(renderRequests > before,
			"refresh with an in_progress task must request a terminal repaint (frozen-widget regression)");
	} finally {
		controls.dispose();
	}
});
