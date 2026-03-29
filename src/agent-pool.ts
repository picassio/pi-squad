/**
 * agent-pool.ts — RpcClient lifecycle management for squad agents.
 *
 * Spawns pi processes in RPC mode, subscribes to events,
 * provides steer/abort/kill, tracks activity.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef, AgentActivity, Task, TaskMessage } from "./types.js";
import { buildAgentSystemPrompt, type ProtocolBuildOptions } from "./protocol.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentProcess {
	taskId: string;
	agentName: string;
	process: ChildProcess;
	activity: AgentActivity;
	/** Queued messages for this agent (received while stopped, consumed on spawn) */
	pendingMessages: TaskMessage[];
	/** Abort controller for cleanup */
	aborted: boolean;
}

export type AgentEventType =
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_end"
	| "turn_end"
	| "agent_end"
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
	private messageQueues = new Map<string, TaskMessage[]>();

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

	/** Queue a message for an agent (delivered on next spawn or via steer if running) */
	queueMessage(agentName: string, message: TaskMessage): void {
		const queue = this.messageQueues.get(agentName) || [];
		queue.push(message);
		this.messageQueues.set(agentName, queue);
	}

	/** Consume queued messages for an agent */
	consumeQueue(agentName: string): TaskMessage[] {
		const queue = this.messageQueues.get(agentName) || [];
		this.messageQueues.delete(agentName);
		return queue;
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
	}): Promise<AgentProcess> {
		const { taskId, agentDef, protocolOptions, cwd, skillPaths } = options;

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
		const args = buildPiArgs(agentDef, promptFile, skillPaths);

		// Spawn pi process — set env var to prevent recursive squad extension loading
		const invocation = getPiInvocation(["--mode", "rpc", ...args]);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SQUAD_CHILD: "1" },
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
			pendingMessages: this.consumeQueue(agentDef.name),
			aborted: false,
		};

		this.agents.set(taskId, agentProc);

		// Read stdout events
		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		attachLineReader(proc.stdout!, (line) => {
			try {
				const event = JSON.parse(line);
				this.handleRpcEvent(agentProc, event);
			} catch {
				/* skip non-JSON lines */
			}
		});

		let agentEndEmitted = false;
		proc.on("exit", (code) => {
			// Only emit if we haven't already emitted via RPC agent_end event
			if (!agentEndEmitted) {
				agentEndEmitted = true;
				this.emit({
					type: "agent_end",
					taskId,
					agentName: agentDef.name,
					data: { exitCode: code, stderr: stderr.slice(-2000) },
				});
			}
			// Cleanup temp files — delay to avoid race with last stdout reads
			setTimeout(() => {
				try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
				try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
			}, 500);
		});

		// Expose the guard so handleRpcEvent can set it
		(agentProc as any)._agentEndEmitted = () => { agentEndEmitted = true; };

		// Wait for process to initialize — pi needs time to load extensions, models, etc.
		await new Promise((resolve) => setTimeout(resolve, 1000));

		if (proc.exitCode !== null) {
			throw new Error(
				`Agent ${agentDef.name} exited immediately (code ${proc.exitCode}). Stderr: ${stderr}`,
			);
		}

		// Send initial prompt
		const taskPrompt = `Your task: ${protocolOptions.task.title}\n\n${protocolOptions.task.description || ""}`;
		this.sendRpcCommand(proc, { type: "prompt", message: taskPrompt });

		return agentProc;
	}

	/** Inject a steering message into a running agent */
	async steer(taskId: string, message: string): Promise<boolean> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted || agent.process.exitCode !== null) return false;
		this.sendRpcCommand(agent.process, { type: "steer", message });
		return true;
	}

	/** Queue a follow-up message for after the current turn */
	async followUp(taskId: string, message: string): Promise<boolean> {
		const agent = this.agents.get(taskId);
		if (!agent || agent.aborted || agent.process.exitCode !== null) return false;
		this.sendRpcCommand(agent.process, { type: "follow_up", message });
		return true;
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
			if (!agent.process.killed) agent.process.kill("SIGKILL");
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

	private sendRpcCommand(proc: ChildProcess, command: Record<string, unknown>): void {
		if (!proc.stdin || proc.stdin.destroyed) return;
		proc.stdin.write(serializeJsonLine(command));
	}

	private handleRpcEvent(agent: AgentProcess, event: any): void {
		agent.activity.lastOutputTs = Date.now();

		// Parse event type and emit
		if (event.type === "message_end" && event.message) {
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
		} else if (event.type === "tool_result_end") {
			this.emit({
				type: "tool_execution_end",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: event,
			});
		} else if (event.type === "agent_end") {
			// Pi RPC mode emits agent_end when the agent loop finishes.
			// The RPC process stays alive waiting for more commands,
			// so we need to explicitly kill it and emit our own agent_end.
			console.error(`[squad-pool] agent_end from RPC: ${agent.agentName} (task: ${agent.taskId})`);
			// Mark the guard to prevent double-emit from proc.on("exit")
			const guardFn = (agent as any)._agentEndEmitted;
			if (guardFn) guardFn();
			// Remove from agents map BEFORE emitting so getRunningAgents() doesn't count it
			this.agents.delete(agent.taskId);
			this.emit({
				type: "agent_end",
				taskId: agent.taskId,
				agentName: agent.agentName,
				data: { exitCode: 0, stderr: "" },
			});
			// Kill the RPC process since the agent's work is done
			agent.process.kill("SIGTERM");
			setTimeout(() => {
				if (!agent.process.killed) agent.process.kill("SIGKILL");
			}, 3000);
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

function buildPiArgs(agentDef: AgentDef, promptFile: string, skillPaths: string[]): string[] {
	const args: string[] = ["--no-session", "--append-system-prompt", promptFile];

	if (agentDef.model) {
		args.push("--model", agentDef.model);
	}

	if (agentDef.tools && agentDef.tools.length > 0) {
		args.push("--tools", agentDef.tools.join(","));
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
