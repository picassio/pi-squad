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
import { createHash, randomUUID } from "node:crypto";
import type {
	AgentDef,
	KnowledgeEntry,
	Squad,
	SquadContext,
	Task,
	TaskMailboxEntry,
	TaskMessage,
	TaskSession,
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

// ============================================================================
// Squad Settings (~/.pi/squad/settings.json)
// ============================================================================

import { DEFAULT_SQUAD_SETTINGS, type SquadSettings } from "./types.js";

export function getSquadSettingsPath(): string {
	return path.join(SQUAD_HOME, "settings.json");
}

/** Load global squad settings, merged over defaults (advisor merged deep). */
export function loadSquadSettings(): SquadSettings {
	const loaded = readJson<Partial<SquadSettings>>(getSquadSettingsPath());
	return {
		...DEFAULT_SQUAD_SETTINGS,
		...(loaded || {}),
		// Legacy, missing, and malformed values remain backward-compatible.
		enabled: typeof loaded?.enabled === "boolean" ? loaded.enabled : DEFAULT_SQUAD_SETTINGS.enabled,
		advisor: { ...DEFAULT_SQUAD_SETTINGS.advisor, ...(loaded?.advisor || {}) },
	};
}

export function saveSquadSettings(settings: SquadSettings): void {
	writeJsonAtomic(getSquadSettingsPath(), settings);
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

export function getTaskMailboxFilePath(squadId: string, taskId: string, parentPath?: string): string {
	return path.join(getTaskDir(squadId, taskId, parentPath), "mailbox.json");
}

/** Task-owned directory where Pi creates the task's durable session JSONL. */
export function getTaskSessionDir(squadId: string, taskId: string, parentPath?: string): string {
	return path.join(getTaskDir(squadId, taskId, parentPath), "session");
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

/**
 * Serialize cross-process read/modify/write operations for one JSON file.
 * Atomic rename prevents torn writes but does not prevent two writers from
 * reading the same old value and overwriting each other. The adjacent lock is
 * short-lived; an abandoned lock older than 30s is recoverable after a crash.
 */
function withJsonFileLock<T>(filePath: string, operation: () => T): T {
	ensureDir(path.dirname(filePath));
	const lockPath = `${filePath}.lock`;
	const startedAt = Date.now();
	let lockFd: number | null = null;
	while (lockFd === null) {
		try {
			lockFd = fs.openSync(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() - startedAt > 10_000) {
				throw new Error(`Timed out acquiring durable store lock: ${lockPath}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
		}
	}
	try {
		fs.writeFileSync(lockFd, `${process.pid}\n${Date.now()}\n`, "utf-8");
	} catch (error) {
		try { fs.closeSync(lockFd); } catch { /* ignore */ }
		try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
		throw error;
	}

	try {
		return operation();
	} finally {
		try { fs.closeSync(lockFd); } catch { /* ignore */ }
		try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
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
		// Parse each line individually — skip partial/corrupt lines
		// (can happen when reading while an agent is mid-write)
		const results: T[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				results.push(JSON.parse(line) as T);
			} catch {
				// Skip corrupt/partial line — likely mid-write
			}
		}
		return results;
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

/** Atomically publish a new file-spec squad, canonical bytes and initial tasks as one directory rename. */
export function publishFileSquad(squad: Squad, tasks: Task[], canonicalBytes: Buffer): void {
	if (!squad.spec) throw new Error("PUBLISH_FAILED: file squad is missing spec metadata");
	const root = path.resolve(getSquadRoot()); ensureDir(root);
	if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(squad.id)) throw new Error(`PUBLISH_FAILED: unsafe squad id ${squad.id}`);
	const finalDir = path.resolve(getSquadDir(squad.id));
	if (path.dirname(finalDir) !== root) throw new Error(`PUBLISH_FAILED: squad destination escapes root`);
	const expectedSpecPath = path.join(finalDir, "spec", "spec.v1.json");
	if (path.resolve(squad.spec.path) !== expectedSpecPath || canonicalBytes.length !== squad.spec.bytes || createHash("sha256").update(canonicalBytes).digest("hex") !== squad.spec.sha256) throw new Error("PUBLISH_FAILED: canonical bytes or destination do not match spec metadata");
	const taskIds = new Set<string>();
	for (const task of tasks) {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(task.id) || taskIds.has(task.id)) throw new Error(`PUBLISH_FAILED: unsafe or duplicate task id ${task.id}`);
		taskIds.add(task.id);
	}
	if (fs.existsSync(finalDir)) throw new Error(`PUBLISH_FAILED: squad ${squad.id} already exists`);
	const stagingDir = path.join(root, `${squad.id}.creating.${randomUUID()}`);
	fs.mkdirSync(stagingDir, { mode: 0o700 });
	try {
		const writeDurable = (filePath: string, content: string): void => { const fd = fs.openSync(filePath, "wx", 0o600); try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
		const specDir = path.join(stagingDir, "spec"); fs.mkdirSync(specDir, { mode: 0o700 });
		const specPath = path.join(specDir, "spec.v1.json"); const specFd = fs.openSync(specPath, "wx", 0o600);
		try { fs.writeFileSync(specFd, canonicalBytes); fs.fsyncSync(specFd); } finally { fs.closeSync(specFd); }
		try { fs.chmodSync(specPath, 0o400); } catch { /* Windows/best effort */ }
		for (const task of tasks) {
			const taskDir = path.join(stagingDir, task.id); fs.mkdirSync(taskDir, { mode: 0o700 });
			writeDurable(path.join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");
		}
		writeDurable(path.join(stagingDir, "squad.json"), JSON.stringify(squad, null, 2) + "\n");
		for (const dir of [specDir, stagingDir]) { try { const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* directory fsync unavailable */ } }
		fs.renameSync(stagingDir, finalDir);
		try { const fd = fs.openSync(root, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* directory fsync unavailable */ }
	} catch (error) {
		try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* preserve original failure */ }
		throw new Error(`PUBLISH_FAILED: ${(error as Error).message}`);
	}
}

export function listSquads(): string[] {
	const root = getSquadRoot();
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root)
		.filter((entry) => {
			if (entry === "agents" || entry === "memory.jsonl" || entry.includes(".creating.")) return false;
			const squadFile = path.join(root, entry, "squad.json");
			return fs.existsSync(squadFile);
		});
}

export function findActiveSquads(): Squad[] {
	// Includes "failed" (recoverable) and "review" (main-orchestrator gate), so
	// neither state disappears across session restarts. All callers filter by status.
	return listSquads()
		.map((id) => loadSquad(id))
		.filter((s): s is Squad => s !== null && (s.status === "running" || s.status === "paused" || s.status === "failed" || s.status === "review"));
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

function normalizeLegacyCancelledTask(task: Task | null): Task | null {
	if (task?.status === "failed" && task.error === "Cancelled by user") {
		return { ...task, status: "cancelled", error: null };
	}
	return task;
}

export function loadTask(squadId: string, taskId: string, parentPath?: string): Task | null {
	return normalizeLegacyCancelledTask(readJson<Task>(getTaskFilePath(squadId, taskId, parentPath)));
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
		const task = normalizeLegacyCancelledTask(readJson<Task>(taskFile));
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
		const task = normalizeLegacyCancelledTask(readJson<Task>(taskFile));
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

/** Read the durable Pi session currently bound to a task. */
export function loadTaskSession(squadId: string, taskId: string, parentPath?: string): TaskSession | null {
	return loadTask(squadId, taskId, parentPath)?.session ?? null;
}

/**
 * Bind a task to its durable Pi session. The file identity is write-once: a
 * reconstructed scheduler may repeat the same binding, but cannot replace it
 * with a fresh session and silently discard the task's conversation context.
 */
export function bindTaskSession(
	squadId: string,
	taskId: string,
	session: TaskSession,
	parentPath?: string,
): TaskSession {
	const task = loadTask(squadId, taskId, parentPath);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	if (!path.isAbsolute(session.file)) {
		throw new Error(`Task session file must be absolute: ${session.file}`);
	}

	const normalized: TaskSession = {
		file: path.normalize(session.file),
		...(session.sessionId ? { sessionId: session.sessionId } : {}),
	};
	const existing = task.session;
	if (existing) {
		if (path.normalize(existing.file) !== normalized.file) {
			throw new Error(`Task ${taskId} is already bound to Pi session ${existing.file}`);
		}
		if (existing.sessionId && normalized.sessionId && existing.sessionId !== normalized.sessionId) {
			// Before Pi accepts the first prompt, get_state reserves the eventual
			// file path but the JSONL does not exist yet. Reopening that same path
			// produces a new provisional sessionId. Permit only that pre-materialized
			// same-file recovery; a real JSONL header makes the ID immutable.
			let materialized = false;
			try { materialized = fs.statSync(normalized.file).size > 0; } catch { /* not created yet */ }
			if (materialized) {
				throw new Error(`Task ${taskId} is already bound to Pi session ${existing.file}`);
			}
			task.session = normalized;
			saveTask(squadId, task, parentPath);
			return normalized;
		}
		if (!existing.sessionId && normalized.sessionId) {
			task.session = normalized;
			saveTask(squadId, task, parentPath);
			return normalized;
		}
		return existing;
	}

	task.session = normalized;
	saveTask(squadId, task, parentPath);
	return normalized;
}

// ============================================================================
// Messages
// ============================================================================

export function appendMessage(squadId: string, taskId: string, message: TaskMessage, parentPath?: string): void {
	appendJsonl(getMessagesFilePath(squadId, taskId, parentPath), message);
}

export function loadMessages(squadId: string, taskId: string, parentPath?: string): TaskMessage[] {
	const history = readJsonl<TaskMessage>(getMessagesFilePath(squadId, taskId, parentPath));
	const seen = new Set(history.flatMap((message) => message.id ? [message.id] : []));
	for (const entry of loadTaskMailbox(squadId, taskId, parentPath)) {
		if (!seen.has(entry.id)) {
			history.push(entry.message);
			seen.add(entry.id);
		}
	}
	return history.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Load all task-addressed mailbox entries, including delivered history. */
export function loadTaskMailbox(squadId: string, taskId: string, parentPath?: string): TaskMailboxEntry[] {
	return readJson<TaskMailboxEntry[]>(getTaskMailboxFilePath(squadId, taskId, parentPath)) ?? [];
}

/** Load only mailbox entries still awaiting successful delivery to this task. */
export function loadPendingTaskMessages(squadId: string, taskId: string, parentPath?: string): TaskMailboxEntry[] {
	return loadTaskMailbox(squadId, taskId, parentPath).filter((entry) => entry.deliveredAt === null);
}

/**
 * Durably queue one inbound message for a task. The mailbox is written before
 * the append-only history; loadMessages merges both by stable ID, so the
 * message remains visible even if a process stops between those writes.
 */
export function queueTaskMessage(
	squadId: string,
	taskId: string,
	message: TaskMessage,
	parentPath?: string,
): TaskMailboxEntry {
	if (!loadTask(squadId, taskId, parentPath)) throw new Error(`Task not found: ${taskId}`);

	const mailboxPath = getTaskMailboxFilePath(squadId, taskId, parentPath);
	return withJsonFileLock(mailboxPath, () => {
		const mailbox = loadTaskMailbox(squadId, taskId, parentPath);
		const id = message.id ?? randomUUID();
		const existing = mailbox.find((entry) => entry.id === id);
		if (existing) return existing;

		const durableMessage: TaskMessage = { ...message, id };
		const entry: TaskMailboxEntry = {
			id,
			taskId,
			enqueuedAt: now(),
			deliveredAt: null,
			message: durableMessage,
		};
		mailbox.push(entry);
		writeJsonAtomic(mailboxPath, mailbox);
		appendJsonl(getMessagesFilePath(squadId, taskId, parentPath), durableMessage);
		return entry;
	});
}

/** Mark task mailbox entries delivered while retaining their durable history. */
export function acknowledgeTaskMessages(
	squadId: string,
	taskId: string,
	messageIds: string[],
	parentPath?: string,
): number {
	if (messageIds.length === 0) return 0;
	const wanted = new Set(messageIds);
	const mailboxPath = getTaskMailboxFilePath(squadId, taskId, parentPath);
	return withJsonFileLock(mailboxPath, () => {
		const mailbox = loadTaskMailbox(squadId, taskId, parentPath);
		const deliveredAt = now();
		let count = 0;
		for (const entry of mailbox) {
			if (wanted.has(entry.id) && entry.deliveredAt === null) {
				entry.deliveredAt = deliveredAt;
				count++;
			}
		}
		if (count > 0) writeJsonAtomic(mailboxPath, mailbox);
		return count;
	});
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
