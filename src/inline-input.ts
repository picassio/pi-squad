/**
 * inline-input.ts — tolerant decoding for inline squad-start arguments.
 *
 * Some tool transports (MCP bridges, JSON-over-JSON encoders) deliver the
 * structured `tasks`/`agents`/`config` fields as JSON-encoded strings instead
 * of arrays/objects. The squad tool accepts both and coerces strings back to
 * structures with precise errors, so a correct plan never fails on transport
 * shape alone. Semantic plan validation (ids, dependencies, cycles, agents)
 * still happens in plan-rules/startSquad after coercion.
 */
import type { InlineSquadStart } from "./runtime.js";

export type InlineCoercion =
	| { ok: true; value: InlineSquadStart }
	| { ok: false; error: string };

type InlineTask = NonNullable<InlineSquadStart["tasks"]>[number];
type InlineAgents = NonNullable<InlineSquadStart["agents"]>;
type InlineConfig = NonNullable<InlineSquadStart["config"]>;

function parseIfString(value: unknown, field: string): { ok: true; value: unknown } | { ok: false; error: string } {
	if (typeof value !== "string") return { ok: true, value };
	try {
		return { ok: true, value: JSON.parse(value) };
	} catch (error) {
		return { ok: false, error: `${field} arrived as a JSON string that is not valid JSON (${(error as Error).message}). Send a real ${field === "tasks" ? "array" : "object"}, or a JSON-encoded one.` };
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceTasks(input: unknown): { ok: true; value: InlineTask[] | undefined } | { ok: false; error: string } {
	if (input === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(input)) return { ok: false, error: "tasks must be an array of task objects (or a JSON-encoded array)." };
	const tasks: InlineTask[] = [];
	for (let i = 0; i < input.length; i++) {
		const raw = input[i];
		if (!isPlainObject(raw)) return { ok: false, error: `tasks[${i}] must be an object.` };
		for (const key of ["id", "title", "agent"] as const) {
			if (typeof raw[key] !== "string" || raw[key].length === 0) {
				return { ok: false, error: `tasks[${i}].${key} must be a nonempty string.` };
			}
		}
		if (raw.description !== undefined && typeof raw.description !== "string") {
			return { ok: false, error: `tasks[${i}].description must be a string when present.` };
		}
		if (raw.depends !== undefined && (!Array.isArray(raw.depends) || !raw.depends.every((d) => typeof d === "string"))) {
			return { ok: false, error: `tasks[${i}].depends must be an array of task-id strings when present.` };
		}
		if (raw.inheritContext !== undefined && typeof raw.inheritContext !== "boolean") {
			return { ok: false, error: `tasks[${i}].inheritContext must be a boolean when present.` };
		}
		tasks.push({
			id: raw.id as string,
			title: raw.title as string,
			agent: raw.agent as string,
			...(raw.description !== undefined ? { description: raw.description as string } : {}),
			...(raw.depends !== undefined ? { depends: raw.depends as string[] } : {}),
			...(raw.inheritContext !== undefined ? { inheritContext: raw.inheritContext as boolean } : {}),
		});
	}
	return { ok: true, value: tasks };
}

function coerceAgents(input: unknown): { ok: true; value: InlineAgents | undefined } | { ok: false; error: string } {
	if (input === undefined) return { ok: true, value: undefined };
	if (!isPlainObject(input)) return { ok: false, error: "agents must be an object mapping agent names to overrides (or a JSON-encoded object)." };
	const agents: InlineAgents = {};
	for (const [name, raw] of Object.entries(input)) {
		if (!isPlainObject(raw)) return { ok: false, error: `agents.${name} must be an object.` };
		if (raw.model !== undefined && typeof raw.model !== "string") return { ok: false, error: `agents.${name}.model must be a string when present.` };
		if (raw.thinking !== undefined && typeof raw.thinking !== "string") return { ok: false, error: `agents.${name}.thinking must be a string when present.` };
		agents[name] = {
			...(raw.model !== undefined ? { model: raw.model as string } : {}),
			...(raw.thinking !== undefined ? { thinking: raw.thinking as string } : {}),
		};
	}
	return { ok: true, value: agents };
}

function coerceConfig(input: unknown): { ok: true; value: InlineConfig | undefined } | { ok: false; error: string } {
	if (input === undefined) return { ok: true, value: undefined };
	if (!isPlainObject(input)) return { ok: false, error: "config must be an object (or a JSON-encoded object)." };
	if (input.maxConcurrency !== undefined && typeof input.maxConcurrency !== "number") {
		return { ok: false, error: "config.maxConcurrency must be a number when present." };
	}
	if (input.autoUnblock !== undefined && typeof input.autoUnblock !== "boolean") {
		return { ok: false, error: "config.autoUnblock must be a boolean when present." };
	}
	if (input.maxRetries !== undefined && typeof input.maxRetries !== "number") {
		return { ok: false, error: "config.maxRetries must be a number when present." };
	}
	return {
		ok: true,
		value: {
			...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency as number } : {}),
			...(input.autoUnblock !== undefined ? { autoUnblock: input.autoUnblock as boolean } : {}),
			...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries as number } : {}),
		},
	};
}

/** Decode inline squad-start input, accepting JSON-encoded structured fields. */
export function coerceInlineSquadStart(raw: {
	goal: string;
	agents?: unknown;
	tasks?: unknown;
	config?: unknown;
}): InlineCoercion {
	if (typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
		return { ok: false, error: "goal must be a nonempty string." };
	}

	const tasksParsed = parseIfString(raw.tasks, "tasks");
	if (!tasksParsed.ok) return tasksParsed;
	const agentsParsed = parseIfString(raw.agents, "agents");
	if (!agentsParsed.ok) return agentsParsed;
	const configParsed = parseIfString(raw.config, "config");
	if (!configParsed.ok) return configParsed;

	const tasks = coerceTasks(tasksParsed.value);
	if (!tasks.ok) return tasks;
	const agents = coerceAgents(agentsParsed.value);
	if (!agents.ok) return agents;
	const config = coerceConfig(configParsed.value);
	if (!config.ok) return config;

	return {
		ok: true,
		value: {
			goal: raw.goal,
			...(agents.value !== undefined ? { agents: agents.value } : {}),
			...(tasks.value !== undefined ? { tasks: tasks.value } : {}),
			...(config.value !== undefined ? { config: config.value } : {}),
		},
	};
}
