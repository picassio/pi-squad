/**
 * store.ts — JSON file I/O for squad state.
 *
 * All state lives in .pi/squad/ as JSON files.
 * Writes are atomic (write to temp, rename).
 * JSONL files are append-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
	AgentDef,
	KnowledgeEntry,
	Squad,
	SquadContext,
	Task,
	TaskMessage,
	TaskUsage,
	DEFAULT_SQUAD_CONFIG,
} from "./types.js";

// ============================================================================
// Paths
// ============================================================================

/**
 * Two-tier storage:
 *
 * Global: ~/.pi/squad/
 *   ├── agents/          — default agent definitions
 *   └── {squad-id}/      — all squad instances (each has cwd in squad.json)
 *
 * Local (project override): {project}/.pi/squad/
 *   └── agents/          — project-specific agent overrides (checked first)
 *
 * Squad instances are always global. Agents are merged (local overrides global).
 * Each squad stores its project cwd in squad.json for agent execution.
 * Listing/widget filters squads by current project cwd.
 */
const SQUAD_HOME = path.join(os.homedir(), ".pi", "squad");

export function getSquadRoot(): string {
	return SQUAD_HOME;
}

/** Global agent directory */
export function getGlobalAgentsDir(): string {
	return path.join(SQUAD_HOME, "agents");
}

/** Project-local agent directory (overrides global) */
export function getLocalAgentsDir(projectCwd: string): string {
	return path.join(projectCwd, ".pi", "squad", "agents");
}

/**
 * Effective agents directory. For writes (bootstrap), always use global.
 * For reads, merge local over global via loadAllAgentDefs(projectCwd).
 */
export function getAgentsDir(): string {
	return getGlobalAgentsDir();
}

export function getSquadDir(squadId: string): string {
	return path.join(getSquadRoot(), squadId);
}

export function getSquadFilePath(squadId: string): string {
	return path.join(getSquadDir(squadId), "squad.json");
}

export function getContextFilePath(squadId: string): string {
	return path.join(getSquadDir(squadId), "context.json");
}

export function getKnowledgeDir(squadId: string): string {
	return path.join(getSquadDir(squadId), "knowledge");
}

export function getMemoryFilePath(): string {
	return path.join(getSquadRoot(), "memory.jsonl");
}

/** Resolve task dir, supporting nested subtasks via parentPath */
export function getTaskDir(squadId: string, taskId: string, parentPath?: string): string {
	const base = parentPath
		? path.join(getSquadDir(squadId), parentPath, taskId)
		: path.join(getSquadDir(squadId), taskId);
	return base;
}

export function getTaskFilePath(squadId: string, taskId: string, parentPath?: string): string {
	return path.join(getTaskDir(squadId, taskId, parentPath), "task.json");
}

export function getMessagesFilePath(squadId: string, taskId: string, parentPath?: string): string {
	return path.join(getTaskDir(squadId, taskId, parentPath), "messages.jsonl");
}

// ============================================================================
// Atomic File Operations
// ============================================================================

function ensureDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

/** Write JSON atomically: write to temp file, then rename */
function writeJsonAtomic(filePath: string, data: unknown): void {
	ensureDir(path.dirname(filePath));
	const tmp = filePath + `.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
	fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/** Append a JSONL line */
function appendJsonl(filePath: string, entry: unknown): void {
	ensureDir(path.dirname(filePath));
	fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/** Read all JSONL lines */
function readJsonl<T>(filePath: string): T[] {
	try {
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		return content.split("\n").map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

// ============================================================================
// Agent Definitions (global + local override)
// ============================================================================

/**
 * Load agent by name. Checks project-local first, then global.
 */
export function loadAgentDef(name: string, projectCwd?: string): AgentDef | null {
	// Check local override first
	if (projectCwd) {
		const localFile = path.join(getLocalAgentsDir(projectCwd), `${name}.json`);
		const local = readJson<AgentDef>(localFile);
		if (local) return local;
	}
	// Fall back to global
	return readJson<AgentDef>(path.join(getGlobalAgentsDir(), `${name}.json`));
}

/**
 * Load all agents, merging local overrides on top of global.
 * Local agents with the same name replace global ones.
 */
export function loadAllAgentDefs(projectCwd?: string): AgentDef[] {
	const agents = new Map<string, AgentDef>();

	// Load global first
	const globalDir = getGlobalAgentsDir();
	if (fs.existsSync(globalDir)) {
		for (const f of fs.readdirSync(globalDir).filter((f) => f.endsWith(".json"))) {
			const agent = readJson<AgentDef>(path.join(globalDir, f));
			if (agent) agents.set(agent.name, agent);
		}
	}

	// Overlay local overrides
	if (projectCwd) {
		const localDir = getLocalAgentsDir(projectCwd);
		if (fs.existsSync(localDir)) {
			for (const f of fs.readdirSync(localDir).filter((f) => f.endsWith(".json"))) {
				const agent = readJson<AgentDef>(path.join(localDir, f));
				if (agent) agents.set(agent.name, agent);
			}
		}
	}

	return Array.from(agents.values());
}

/** Save agent to global directory */
export function saveAgentDef(agent: AgentDef): void {
	writeJsonAtomic(path.join(getGlobalAgentsDir(), `${agent.name}.json`), agent);
}

/** Save agent to project-local directory (override) */
export function saveLocalAgentDef(agent: AgentDef, projectCwd: string): void {
	writeJsonAtomic(path.join(getLocalAgentsDir(projectCwd), `${agent.name}.json`), agent);
}

export function deleteAgentDef(name: string): boolean {
	const filePath = path.join(getGlobalAgentsDir(), `${name}.json`);
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
		return true;
	}
	return false;
}

// ============================================================================
// Squad
// ============================================================================

export function loadSquad(squadId: string): Squad | null {
	return readJson<Squad>(getSquadFilePath(squadId));
}

export function saveSquad(squad: Squad): void {
	writeJsonAtomic(getSquadFilePath(squad.id), squad);
}

export function listSquads(): string[] {
	const root = getSquadRoot();
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.filter((entry) => {
			if (entry === "agents" || entry === "memory.jsonl") return false;
			const squadFile = path.join(root, entry, "squad.json");
			return fs.existsSync(squadFile);
		});
}

export function findActiveSquads(): Squad[] {
	return listSquads()
		.map((id) => loadSquad(id))
		.filter((s): s is Squad => s !== null && (s.status === "running" || s.status === "paused"));
}

/** List squads filtered by project cwd. If no cwd, returns all. */
export function listSquadsForProject(projectCwd?: string): Squad[] {
	return listSquads()
		.map((id) => loadSquad(id))
		.filter((s): s is Squad => {
			if (!s) return false;
			if (!projectCwd) return true;
			return s.cwd === projectCwd;
		});
}

/** Find most recent squad for a project (by creation time) */
export function findLatestSquad(projectCwd?: string): Squad | null {
	const squads = listSquadsForProject(projectCwd);
	if (squads.length === 0) return null;
	return squads.sort((a, b) => b.created.localeCompare(a.created))[0];
}

// ============================================================================
// Tasks
// ============================================================================

export function loadTask(squadId: string, taskId: string, parentPath?: string): Task | null {
	return readJson<Task>(getTaskFilePath(squadId, taskId, parentPath));
}

export function saveTask(squadId: string, task: Task, parentPath?: string): void {
	writeJsonAtomic(getTaskFilePath(squadId, task.id, parentPath), task);
}

/** Load all tasks for a squad (flat list, scans top-level task folders) */
export function loadAllTasks(squadId: string): Task[] {
	const squadDir = getSquadDir(squadId);
	if (!fs.existsSync(squadDir)) return [];

	const tasks: Task[] = [];
	const seen = new Set<string>();
	const entries = fs.readdirSync(squadDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "knowledge") continue;
		const taskFile = path.join(squadDir, entry.name, "task.json");
		const task = readJson<Task>(taskFile);
		if (task && !seen.has(task.id)) {
			seen.add(task.id);
			tasks.push(task);
			// Scan for subtasks
			collectSubtasks(squadDir, entry.name, tasks, seen);
		}
	}

	return tasks;
}

function collectSubtasks(squadDir: string, parentPath: string, tasks: Task[], seen: Set<string>): void {
	const parentDir = path.join(squadDir, parentPath);
	let entries;
	try {
		entries = fs.readdirSync(parentDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const taskFile = path.join(parentDir, entry.name, "task.json");
		const task = readJson<Task>(taskFile);
		if (task && !seen.has(task.id)) {
			seen.add(task.id);
			tasks.push(task);
			collectSubtasks(squadDir, path.join(parentPath, entry.name), tasks, seen);
		}
	}
}

export function createTask(squadId: string, task: Task, parentPath?: string): void {
	ensureDir(getTaskDir(squadId, task.id, parentPath));
	saveTask(squadId, task, parentPath);
}

export function updateTaskStatus(
	squadId: string,
	taskId: string,
	status: Task["status"],
	extra?: Partial<Pick<Task, "output" | "error" | "started" | "completed">>,
): void {
	const task = loadTask(squadId, taskId);
	if (!task) return;
	task.status = status;
	if (extra) {
		if (extra.output !== undefined) task.output = extra.output;
		if (extra.error !== undefined) task.error = extra.error;
		if (extra.started !== undefined) task.started = extra.started;
		if (extra.completed !== undefined) task.completed = extra.completed;
	}
	saveTask(squadId, task);
}

export function updateTaskUsage(squadId: string, taskId: string, usage: Partial<TaskUsage>): void {
	const task = loadTask(squadId, taskId);
	if (!task) return;
	if (usage.inputTokens !== undefined) task.usage.inputTokens += usage.inputTokens;
	if (usage.outputTokens !== undefined) task.usage.outputTokens += usage.outputTokens;
	if (usage.cost !== undefined) task.usage.cost += usage.cost;
	if (usage.turns !== undefined) task.usage.turns += usage.turns;
	saveTask(squadId, task);
}

// ============================================================================
// Messages
// ============================================================================

export function appendMessage(squadId: string, taskId: string, message: TaskMessage, parentPath?: string): void {
	appendJsonl(getMessagesFilePath(squadId, taskId, parentPath), message);
}

export function loadMessages(squadId: string, taskId: string, parentPath?: string): TaskMessage[] {
	return readJsonl<TaskMessage>(getMessagesFilePath(squadId, taskId, parentPath));
}

// ============================================================================
// Context
// ============================================================================

export function loadContext(squadId: string): SquadContext | null {
	return readJson<SquadContext>(getContextFilePath(squadId));
}

export function saveContext(squadId: string, context: SquadContext): void {
	writeJsonAtomic(getContextFilePath(squadId), context);
}

// ============================================================================
// Knowledge
// ============================================================================

export function appendKnowledge(squadId: string, type: KnowledgeEntry["type"], entry: KnowledgeEntry): void {
	const file = path.join(getKnowledgeDir(squadId), `${type}s.jsonl`);
	appendJsonl(file, entry);
}

export function loadKnowledge(squadId: string, type: KnowledgeEntry["type"]): KnowledgeEntry[] {
	const file = path.join(getKnowledgeDir(squadId), `${type}s.jsonl`);
	return readJsonl<KnowledgeEntry>(file);
}

export function loadAllKnowledge(squadId: string): KnowledgeEntry[] {
	return [
		...loadKnowledge(squadId, "decision"),
		...loadKnowledge(squadId, "convention"),
		...loadKnowledge(squadId, "finding"),
	].sort((a, b) => a.ts.localeCompare(b.ts));
}

// ============================================================================
// Rework Helpers
// ============================================================================

/** Find all retry tasks for a given original task ID */
export function findRetries(squadId: string, originalTaskId: string): Task[] {
	return loadAllTasks(squadId).filter((t) => t.retryOf === originalTaskId);
}

/** Get the retry count for a task chain (original + all retries) */
export function getRetryCount(squadId: string, taskId: string): number {
	const task = loadTask(squadId, taskId);
	if (!task) return 0;
	if (task.retryCount !== undefined) return task.retryCount;
	return findRetries(squadId, taskId).length;
}

// ============================================================================
// Memory (cross-squad)
// ============================================================================

export function appendMemory(entry: KnowledgeEntry): void {
	appendJsonl(getMemoryFilePath(), entry);
}

export function loadMemory(): KnowledgeEntry[] {
	return readJsonl<KnowledgeEntry>(getMemoryFilePath());
}

// ============================================================================
// Bootstrap — first-run agent initialization
// ============================================================================

/**
 * Copy default agents to .pi/squad/agents/ if they don't exist yet.
 * Never overwrites user's existing files.
 */
export function bootstrapAgents(defaultsDir: string): { copied: string[]; skipped: string[] } {
	const targetDir = getAgentsDir();
	ensureDir(targetDir);

	const copied: string[] = [];
	const skipped: string[] = [];

	if (!fs.existsSync(defaultsDir)) return { copied, skipped };

	for (const file of fs.readdirSync(defaultsDir)) {
		if (!file.endsWith(".json")) continue;
		const target = path.join(targetDir, file);
		if (fs.existsSync(target)) {
			skipped.push(file);
		} else {
			fs.copyFileSync(path.join(defaultsDir, file), target);
			copied.push(file);
		}
	}

	return { copied, skipped };
}

// ============================================================================
// Utility
// ============================================================================

export function now(): string {
	return new Date().toISOString();
}

export function makeTaskId(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

export function squadExists(squadId: string): boolean {
	return fs.existsSync(getSquadFilePath(squadId));
}
