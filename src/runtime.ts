import { completeSimple, type Message, type TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorConsultText, type AdvisorConsultInput } from "./advisor.js";
import { logError, debug } from "./logger.js";
import type { Squad, SquadAgentEntry, SuspendedStallAttention, Task } from "./types.js";
import { THINKING_LEVELS } from "./types.js";
import type { Scheduler, SchedulerSpawnContext } from "./scheduler.js";
import type { SquadWidgetControls, SquadWidgetState } from "./panel/squad-widget.js";
import * as store from "./store.js";

export interface InlineSquadStart {
	goal: string;
	agents?: Record<string, SquadAgentEntry>;
	tasks?: Array<{ id: string; title: string; description?: string; agent: string; depends?: string[]; inheritContext?: boolean }>;
	config?: { maxConcurrency?: number; autoUnblock?: boolean; maxRetries?: number };
}

/** All mutable extension state has one owner. */
export const runtime = {
	squadEnabled: true,
	schedulers: new Map<string, Scheduler>(),
	activeSquadId: null as string | null,
	overlayOpen: false,
	closeOverlay: null as (() => void) | null,
	uiCtx: null as ExtensionContext | null,
	widgetState: { squadId: null, enabled: true } as SquadWidgetState,
	widgetControls: null as SquadWidgetControls | null,
	getMainSessionThinking: (() => undefined) as () => string | undefined,
};

export const DISABLED_GUIDANCE = "pi-squad is disabled. Run /squad enable, then retry this operation; no squad work was changed.";
export const disabledToolResult = () => ({
	content: [{ type: "text" as const, text: DISABLED_GUIDANCE }],
	details: undefined,
});

/** Keep main-session focus, compact widget, and detail panel targeting identical. */
export function focusSquad(squadId: string | null): void {
	runtime.activeSquadId = squadId;
	runtime.widgetState.squadId = squadId;
	if (squadId && runtime.squadEnabled) runtime.widgetState.enabled = true;
	runtime.widgetControls?.refreshNow();
}

/** Format completion against active work while retaining cancelled history. */
export function formatTaskProgress(tasks: Task[]): string {
	const done = tasks.filter((task) => task.status === "done").length;
	const cancelled = tasks.filter((task) => task.status === "cancelled").length;
	const active = tasks.length - cancelled;
	return cancelled > 0
		? `${done}/${active} active tasks done · ${cancelled} cancelled · ${tasks.length} total`
		: `${done}/${tasks.length} tasks done`;
}

function resolveContextWindow(model: string | null): number | undefined {
	const ctx = runtime.uiCtx;
	if (!ctx) return undefined;
	try {
		if (!model) return ctx.model?.contextWindow;
		let clean = model;
		const lastColon = model.lastIndexOf(":");
		if (lastColon > 0 && (THINKING_LEVELS as readonly string[]).includes(model.slice(lastColon + 1))) {
			clean = model.slice(0, lastColon);
		}
		const all = ctx.modelRegistry.getAll();
		const slash = clean.indexOf("/");
		if (slash > 0) {
			const provider = clean.slice(0, slash);
			const id = clean.slice(slash + 1);
			const m = all.find((x) => x.provider === provider && x.id === id);
			if (m) return m.contextWindow;
		}
		return all.find((x) => x.id === clean)?.contextWindow;
	} catch {
		return undefined;
	}
}

export function getMainSessionModel(): string | undefined {
	try {
		const m = runtime.uiCtx?.model;
		return m ? `${m.provider}/${m.id}` : undefined;
	} catch {
		return undefined;
	}
}

export function resolveSquadDefaults(): { model?: string; thinking?: string } {
	const settings = store.loadSquadSettings();
	let model: string | undefined;
	if (settings.defaultModel === "main") model = getMainSessionModel();
	else if (settings.defaultModel !== "pi-default") model = settings.defaultModel;
	let thinking: string | undefined;
	if (settings.defaultThinking === "main") thinking = runtime.getMainSessionThinking();
	else if (settings.defaultThinking !== "pi-default") thinking = settings.defaultThinking;
	return { model, thinking };
}

async function consultAdvisor(input: AdvisorConsultInput): Promise<string | null> {
	const ctx = runtime.uiCtx;
	if (!ctx) return null;
	const settings = store.loadSquadSettings();
	if (!settings.advisor.enabled) return null;

	try {
		let model = settings.advisor.model === "main" ? ctx.model : undefined;
		if (!model && settings.advisor.model !== "main") {
			const ref = settings.advisor.model;
			const slash = ref.indexOf("/");
			if (slash > 0) model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		}
		if (!model) {
			logError("squad-advisor", `advisor model "${settings.advisor.model}" not resolvable`);
			return null;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			logError("squad-advisor", `no auth for advisor model ${model.provider}/${model.id}`);
			return null;
		}

		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: buildAdvisorConsultText(input) }],
			timestamp: Date.now(),
		} as Message;

		const response = await completeSimple(
			model,
			{ systemPrompt: ADVISOR_SYSTEM_PROMPT, messages: [userMessage] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: settings.advisor.maxTokens,
				reasoning: settings.advisor.reasoning as never,
			},
		);

		const text = response.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		debug("squad-advisor", `consulted ${model.provider}/${model.id} for ${input.taskId}: in=${response.usage?.input ?? 0} out=${response.usage?.output ?? 0}`);
		return text || null;
	} catch (error) {
		logError("squad-advisor", `consult failed: ${(error as Error).message}`);
		return null;
	}
}

export const schedulerSpawnContext: SchedulerSpawnContext = {
	resolveContextWindow,
	getDefaultModelThinking: resolveSquadDefaults,
	consultAdvisor,
};

export function getActiveScheduler(): Scheduler | null {
	if (!runtime.activeSquadId) return null;
	return runtime.schedulers.get(runtime.activeSquadId) || null;
}

export function repairFocusAfterCancellation(cancelledId: string): void {
	const nextFocus = runtime.activeSquadId === cancelledId || (runtime.activeSquadId !== null && !store.loadSquad(runtime.activeSquadId))
		? null
		: runtime.activeSquadId;
	focusSquad(nextFocus);
}

export function activeSuspendedAttentionForProject(cwd: string): Array<{ squadId: string; attention: SuspendedStallAttention }> {
	return store.listSquadsForProject(cwd)
		.filter((squad) => Boolean(squad.suspendedStallAttention))
		.map((squad) => ({ squadId: squad.id, attention: squad.suspendedStallAttention! }));
}

export function isResumeCandidate(squad: Squad): boolean {
	return squad.status === "paused" || squad.status === "failed" ||
		(squad.status === "review" && squad.review?.status === "failed") ||
		store.loadAllTasks(squad.id).some((task) => task.status === "suspended" || task.status === "failed");
}

export function resolveResumeSquad(cwd: string, explicitId?: string): Squad | null {
	if (explicitId) return store.loadSquad(explicitId);
	if (runtime.activeSquadId) {
		const active = store.loadSquad(runtime.activeSquadId);
		if (active?.cwd === cwd && isResumeCandidate(active)) return active;
	}
	return store.listSquadsForProject(cwd)
		.filter(isResumeCandidate)
		.sort((a, b) => b.created.localeCompare(a.created))[0] ?? null;
}

export function forceWidgetUpdate(): void {
	runtime.widgetControls?.requestUpdate();
}
