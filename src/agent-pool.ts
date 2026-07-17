/**
 * agent-pool.ts — RpcClient lifecycle management for squad agents.
 *
 * Spawns pi processes in RPC mode, subscribes to events,
 * provides steer/abort/kill, tracks activity.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef, AgentActivity, TaskSession } from "./types.js";
import { buildAgentSystemPrompt, type ProtocolBuildOptions } from "./protocol.js";
import { debug, logError } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentProcess {
	taskId: string;
	agentName: string;
	process: ChildProcess;
	activity: AgentActivity;
	/** Durable Pi session owned by this task. */
	session: TaskSession;
	/** Abort controller for cleanup */
	aborted: boolean;
}

export type AgentEventType =
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_end"
	| "turn_end"
	| "agent_end"
	| "agent_settled"
	| "error";

export interface AgentEvent {
	type: AgentEventType;
	taskId: string;
	agentName: string;
	data: any;
}

export type AgentEventListener = (event: AgentEvent) => void;

// ============================================================================
// RPC JSON Line Protocol
// ============================================================================

function serializeJsonLine(obj: unknown): string {
	return JSON.stringify(obj) + "\n";
}

function attachLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	let buffer = "";
	const onData = (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (line.trim()) onLine(line);
		}
	};
	stream.on("data", onData);
	return () => stream.removeListener("data", onData);
}

// ============================================================================
// Agent Pool
// ============================================================================

export class AgentPool {
	private agents = new Map<string, AgentProcess>();
	private listeners: AgentEventListener[] = [];
	private responseWaiters = new Map<string, {
		process: ChildProcess;
		resolve: (event: any) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	/** Subscribe to agent events */
	onEvent(listener: AgentEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx !== -1) this.listeners.splice(idx, 1);
		};
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* ignore listener errors */
			}
		}
	}

	/** Check if an agent is currently running */
	isRunning(taskId: string): boolean {
		const agent = this.agents.get(taskId);
		return agent !== undefined && !agent.aborted && agent.process.exitCode === null;
	}

	/** Get the task ID a named agent is working on */
	getTaskIdForAgent(agentName: string): string | undefined {
		for (const [taskId, agent] of this.agents) {
			if (agent.agentName === agentName && !agent.aborted) return taskId;
		}
		return undefined;
	}

	/** Get activity tracker for a task */
	getActivity(taskId: string): AgentActivity | undefined {
		return this.agents.get(taskId)?.activity;
	}

	/** Get all running agent names */
	getRunningAgents(): string[] {
		return Array.from(this.agents.values())
			.filter((a) => !a.aborted && a.process.exitCode === null)
			.map((a) => a.agentName);
	}

	/**
	 * Spawn a pi process in RPC mode for a task.
	 */
	async spawn(options: {
		taskId: string;
		agentDef: AgentDef;
		protocolOptions: ProtocolBuildOptions;
		cwd: string;
		skillPaths: string[];
		/** Resume this task's already-bound durable Pi session. */
		resumeSession?: TaskSession;
		/** Create a new durable session here (new tasks only). */
		sessionDir?: string;
		/** Fork the given session file so a new task inherits main-session context. */
		forkSession?: { file: string; sessionDir: string };
		spec?: { squadId: string; path: string; sha256: string; bytes: number; chunkBytes: number };
	}): Promise<AgentProcess> {
		const { taskId, agentDef, protocolOptions, cwd, skillPaths, resumeSession, sessionDir, forkSession, spec } = options;

		// Kill existing process for this task if any
		if (this.agents.has(taskId)) {
			await this.kill(taskId);
		}

		// Write system prompt to temp file
		const systemPrompt = buildAgentSystemPrompt(protocolOptions);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-"));
		const promptFile = path.join(tmpDir, `${agentDef.name}-prompt.md`);
		fs.writeFileSync(promptFile, systemPrompt, "utf-8");

		// Build pi CLI args
		const args = buildPiArgs(agentDef, promptFile, skillPaths, { resumeSession, sessionDir, forkSession }, Boolean(spec));

		// Spawn pi process — set env var to prevent recursive squad extension loading
		const invocation = getPiInvocation(["--mode", "rpc", ...args]);
		debug("squad-pool", `spawn ${agentDef.name}: ${invocation.command} ${invocation.args.join(" ")}`);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SQUAD_CHILD: "1", ...(spec ? {
				PI_SQUAD_ID: spec.squadId,
				PI_SQUAD_TASK_ID: taskId,
				PI_SQUAD_SPEC_PATH: spec.path,
				PI_SQUAD_SPEC_SHA256: spec.sha256,
				PI_SQUAD_SPEC_BYTES: String(spec.bytes),
				PI_SQUAD_SPEC_CHUNK_BYTES: String(spec.chunkBytes),
			} : {}) },
		});

		const activity: AgentActivity = {
			taskId,
			agentName: agentDef.name,
			lastOutputTs: Date.now(),
			startedAt: Date.now(),
			turnCount: 0,
			recentToolCalls: [],
			modifiedFiles: new Set(),
		};

		const agentProc: AgentProcess = {
			taskId,
			agentName: agentDef.name,
			process: proc,
			activity,
			// Replaced with the authoritative get_state values before spawn returns.
			session: resumeSession ?? { file: "" },
			aborted: false,
		};

		this.agents.set(taskId, agentProc);

		// Read stdout events
		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		attachLineReader(proc.stdout!, (line) => {
			stdoutLines++;
			try {
				const event = JSON.parse(line);
				this.handleRpcEvent(agentProc, event);
			} catch {
				/* skip non-JSON lines */
			}
		});

		let terminalEventEmitted = false;
		let stdoutLines = 0;
		proc.on("exit", (code, signal) => {
			this.rejectResponseWaiters(proc, new Error(`Agent ${agentDef.name} exited before RPC response`));
			// Log diagnostic info for debugging spawn failures
			if (code !== 0 && code !== null) {
				logError("squad-pool", `${agentDef.name} exited: code=${code} signal=${signal} pid=${proc.pid} stdoutLines=${stdoutLines} stderr=${stderr || "(empty)"}`);
			}
			// Capture activity stats before cleanup. A delayed exit callback from an
			// old child must never delete or mutate a replacement registered for the
			// same task ID.
			const finalActivity = agentProc.activity;
			const isCurrentChild = this.agents.get(taskId) === agentProc;
			if (isCurrentChild) this.agents.delete(taskId);
			// Only the currently registered child may report an unexpected exit.
			// Intentional shutdown must not reopen a suspended or cancelled task.
			if (isCurrentChild && !terminalEventEmitted && !agentProc.aborted) {
				terminalEventEmitted = true;
				this.emit({
					type: "agent_end",
					taskId,
					agentName: agentDef.name,
					data: {
						exitCode: code,
						unexpectedExit: true,
						// Preserve complete diagnostics for task failure reports and recovery.
						stderr,
						turnCount: finalActivity.turnCount,
						toolCallCount: finalActivity.recentToolCalls.length,
						filesModified: finalActivity.modifiedFiles.size,
					},
				});
			}
			// Cleanup temp files — delay to avoid race with last stdout reads
			setTimeout(() => {
				try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
				try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
			}, 500);
		});

		// Expose the guard so handleRpcEvent can mark final settlement.
		(agentProc as any)._terminalEventEmitted = () => { terminalEventEmitted = true; };

		// Wait for process to initialize — pi needs time to load extensions, models, etc.
		await new Promise((resolve) => setTimeout(resolve, 1000));

		if (proc.exitCode !== null) {
			throw new Error(
				`Agent ${agentDef.name} exited immediately (code ${proc.exitCode}). Stderr: ${stderr}`,
			);
		}

		// Persisted session identity is authoritative. Capture it before any prompt
		// is sent so a crash/retry can only resume this task's original context.
		const state = await this.requestRpc(proc, { type: "get_state" });
		const rawSessionFile = state?.data?.sessionFile;
		if (!state?.success || typeof rawSessionFile !== "string" || rawSessionFile.length === 0) {
			await this.kill(taskId);
			throw new Error(`Agent ${agentDef.name} did not expose a durable session file`);
		}
		agentProc.session = {
			file: path.isAbsolute(rawSessionFile) ? path.normalize(rawSessionFile) : path.resolve(cwd, rawSessionFile),
			...(typeof state.data?.sessionId === "string" && state.data.sessionId
				? { sessionId: state.data.sessionId }
				: {}),
		};

		return agentProc;
	}

	/** Start a turn in an initialized task session. */
	async prompt(taskId: string, message: string): Promise<boolean> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted || agent.process.exitCode !== null) return false;
		return this.requestAccepted(agent.process, { type: "prompt", message });
	}

	/** Inject a steering message into a running agent */
	async steer(taskId: string, message: string): Promise<boolean> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted || agent.process.exitCode !== null) return false;
		return this.requestAccepted(agent.process, { type: "steer", message });
	}

	/** Queue a follow-up message for after the current turn */
	async followUp(taskId: string, message: string): Promise<boolean> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted || agent.process.exitCode !== null) return false;
		return this.requestAccepted(agent.process, { type: "follow_up", message });
	}

	/** Abort the current operation */
	async abort(taskId: string): Promise<void> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted) return;
		try {
			this.sendRpcCommand(agent.process, { type: "abort" });
		} catch {
			/* ignore */
		}
	}

	/** Kill agent process */
	async kill(taskId: string): Promise<void> {
		const agent = this.agents.get(taskId);
		if (!agent) return;
		agent.aborted = true;
		agent.process.kill("SIGTERM");
		// Force kill after 5s
		const timer = setTimeout(() => {
			if (agent.process.exitCode === null) agent.process.kill("SIGKILL");
		}, 5000);
		await new Promise<void>((resolve) => {
			agent.process.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			// If already exited
			if (agent.process.exitCode !== null) {
				clearTimeout(timer);
				resolve();
			}
		});
		this.agents.delete(taskId);
	}

	/** Kill all running agents */
	async killAll(): Promise<void> {
		const kills = Array.from(this.agents.keys()).map((taskId) => this.kill(taskId));
		await Promise.all(kills);
	}

	/** Wait for an agent to finish */
	async waitForCompletion(taskId: string): Promise<number> {
		const agent = this.agents.get(taskId);
		if (!agent) return -1;
		if (agent.process.exitCode !== null) return agent.process.exitCode;
		return new Promise<number>((resolve) => {
			agent.process.on("exit", (code) => resolve(code ?? 1));
		});
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private sendRpcCommand(proc: ChildProcess, command: Record<string, unknown>): boolean {
		if (!proc.stdin || proc.stdin.destroyed) return false;
		try {
			// Writable.write(false) means backpressure, not rejection; the bytes are
			// still buffered. Reaching write() without throwing means the JSONL
			// command was handed to the child stream.
			proc.stdin.write(serializeJsonLine(command));
			return true;
		} catch {
			return false;
		}
	}

	private async requestAccepted(proc: ChildProcess, command: Record<string, unknown>): Promise<boolean> {
		try {
			const response = await this.requestRpc(proc, command);
			return response?.success === true;
		} catch {
			return false;
		}
	}

	private requestRpc(proc: ChildProcess, command: Record<string, unknown>): Promise<any> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.responseWaiters.delete(id);
				reject(new Error(`Timed out waiting for RPC ${String(command.type)}`));
			}, 10_000);
			timer.unref();
			this.responseWaiters.set(id, { process: proc, resolve, reject, timer });
			if (!this.sendRpcCommand(proc, { ...command, id })) {
				clearTimeout(timer);
				this.responseWaiters.delete(id);
				reject(new Error(`Failed to send RPC ${String(command.type)}`));
			}
		});
	}

	private rejectResponseWaiters(proc: ChildProcess, error: Error): void {
		for (const [id, waiter] of this.responseWaiters) {
			if (waiter.process !== proc) continue;
			clearTimeout(waiter.timer);
			this.responseWaiters.delete(id);
			waiter.reject(error);
		}
	}

	private handleRpcEvent(agent: AgentProcess, event: any): void {
		if (event.type === "response" && typeof event.id === "string") {
			const waiter = this.responseWaiters.get(event.id);
			if (waiter) {
				clearTimeout(waiter.timer);
				this.responseWaiters.delete(event.id);
				waiter.resolve(event);
			}
			return;
		}
		// Process stdout can drain after a replacement has already been installed.
		// Ignore every stale lifecycle/activity event so the old child cannot
		// evict, settle, or complete the new task process.
		if (this.agents.get(agent.taskId) !== agent) return;
		// Only genuine agent activity advances the idle clock. Command acks
		// (type=response) and echoes of injected user messages (steer messages
		// recorded as user-role message events) must NOT reset it — otherwise the
		// monitor's own idle/stuck steers keep a silent agent looking "healthy"
		// forever and escalation (advisor rescue) can never fire.
		const msgRole = event.message?.role;
		const isAgentActivity =
			event.type?.startsWith?.("tool_execution") ||
			event.type === "turn_start" ||
			event.type === "turn_end" ||
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			(event.type?.startsWith?.("message_") && msgRole !== "user");
		if (isAgentActivity) {
			agent.activity.lastOutputTs = Date.now();
		}

		// Parse event type and emit (user-message echoes don't count as turns)
		if (event.type === "message_end" && event.message && msgRole !== "user") {
			agent.activity.turnCount++;
			this.emit({
				type: "message_end",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: event.message,
			});
		} else if (event.type === "tool_execution_start") {
			const sig = `${event.toolName}:${JSON.stringify(event.args || {}).slice(0, 100)}`;
			agent.activity.recentToolCalls.push(sig);
			if (agent.activity.recentToolCalls.length > 20) {
				agent.activity.recentToolCalls.shift();
			}
			this.emit({
				type: "tool_execution_start",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: event,
			});
		} else if (event.type === "tool_execution_end") {
			// Track modified files
			if (event.toolName === "write" || event.toolName === "edit") {
				const filePath = event.args?.path || event.args?.file_path;
				if (filePath) agent.activity.modifiedFiles.add(filePath);
			}
			this.emit({
				type: "tool_execution_end",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: event,
			});
		} else if (event.type === "agent_end") {
			// agent_end is one low-level run. Pi may still process queued steer,
			// follow-up, retry, or compaction continuations. Killing here races and
			// drops main-session steering. agent_settled is the final lifecycle edge.
			debug("squad-pool", `agent_end from RPC (awaiting settled): ${agent.agentName} (task: ${agent.taskId})`);
		} else if (event.type === "agent_settled") {
			debug("squad-pool", `agent_settled from RPC: ${agent.agentName} (task: ${agent.taskId})`);
			// Mark the guard to prevent double-emit from proc.on("exit")
			const guardFn = (agent as any)._terminalEventEmitted;
			if (guardFn) guardFn();
			// Capture activity stats BEFORE deleting
			const endActivity = agent.activity;
			// Remove from agents map BEFORE emitting so getRunningAgents() doesn't count it
			this.agents.delete(agent.taskId);
			this.emit({
				type: "agent_settled",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: {
					exitCode: 0,
					stderr: "",
					turnCount: endActivity.turnCount,
					toolCallCount: endActivity.recentToolCalls.length,
					filesModified: endActivity.modifiedFiles.size,
				},
			});
			// The session is fully settled, so the RPC process can now close.
			agent.process.kill("SIGTERM");
			const forceKill = setTimeout(() => {
				if (agent.process.exitCode === null) agent.process.kill("SIGKILL");
			}, 3000);
			forceKill.unref();
		} else if (event.type === "error") {
			this.emit({
				type: "error",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: event,
			});
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function buildPiArgs(
	agentDef: AgentDef,
	promptFile: string,
	skillPaths: string[],
	sessionOptions: {
		resumeSession?: TaskSession;
		sessionDir?: string;
		forkSession?: { file: string; sessionDir: string };
	},
	fileSpec = false,
): string[] {
	const { resumeSession, sessionDir, forkSession } = sessionOptions;
	if (resumeSession && forkSession) throw new Error("Cannot resume and fork a task session simultaneously");
	// Existing tasks always reopen the exact bound file. Only tasks without a
	// binding create a new session (optionally as a main-session fork).
	const sessionArgs = resumeSession
		? ["--session", resumeSession.file]
		: forkSession
			? ["--fork", forkSession.file, "--session-dir", forkSession.sessionDir]
			: sessionDir
				? ["--session-dir", sessionDir]
				: (() => { throw new Error("A durable task session is required"); })();
	const args: string[] = [...sessionArgs, "--append-system-prompt", promptFile];

	if (agentDef.model) {
		args.push("--model", agentDef.model);
	}

	if (agentDef.thinking) {
		args.push("--thinking", agentDef.thinking);
	}

	if (agentDef.tools && agentDef.tools.length > 0) {
		const tools = fileSpec && !agentDef.tools.includes("squad_spec_read")
			? [...agentDef.tools, "squad_spec_read"]
			: agentDef.tools;
		args.push("--tools", tools.join(","));
	}

	for (const skillPath of skillPaths) {
		args.push("--skill", skillPath);
	}

	return args;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Try to find the pi CLI binary in PATH
	// This is the most reliable approach — works regardless of how the parent was invoked
	const piPaths = [
		// Check PATH
		"pi",
	];

	// Check if process.argv[1] is a .js file we can re-invoke
	const currentScript = process.argv[1];
	if (currentScript && currentScript.endsWith(".js") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	// Check if process.execPath is pi itself (not node/bun)
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// execPath is the pi binary
		return { command: process.execPath, args };
	}

	// Fall back to pi in PATH
	return { command: "pi", args };
}
