// ============================================================================
// Agent Definitions
// ============================================================================

export interface AgentDef {
	/** Agent identifier, matches filename */
	name: string;
	/** One-line role title */
	role: string;
	/** What this agent does (used by planner to pick agents) */
	description: string;
	/** Override model (null = squad default or pi default) */
	model: string | null;
	/** Override tool list (null = all standard tools) */
	tools: string[] | null;
	/** Tags for planner's automatic agent matching */
	tags: string[];
	/** System prompt injected via --append-system-prompt */
	prompt: string;
}

/** Agent entry in squad.json — just overrides, references an AgentDef by key */
export interface SquadAgentEntry {
	model?: string | null;
}

// ============================================================================
// Squad
// ============================================================================

export type SquadStatus = "planning" | "running" | "paused" | "done" | "failed";

export interface SquadConfig {
	maxConcurrency: number;
	autoUnblock: boolean;
	reviewOnComplete: boolean;
	/** Max rework attempts when QA fails a task (0 = no rework, just fail) */
	maxRetries: number;
}

export const DEFAULT_SQUAD_CONFIG: SquadConfig = {
	maxConcurrency: 2,
	autoUnblock: true,
	reviewOnComplete: false,
	maxRetries: 2,
};

export interface Squad {
	id: string;
	goal: string;
	status: SquadStatus;
	created: string;
	cwd: string;
	/** Agent name → overrides. Keys must exist in .pi/squad/agents/ */
	agents: Record<string, SquadAgentEntry>;
	config: SquadConfig;
}

// ============================================================================
// Tasks
// ============================================================================

export type TaskStatus = "pending" | "blocked" | "in_progress" | "done" | "failed" | "suspended";

export interface TaskUsage {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	turns: number;
}

export interface Task {
	id: string;
	title: string;
	description: string;
	agent: string;
	status: TaskStatus;
	depends: string[];
	created: string;
	started: string | null;
	completed: string | null;
	output: string | null;
	error: string | null;
	usage: TaskUsage;
	/** If this is a rework task, the original task ID it's fixing */
	retryOf?: string;
	/** How many times this task chain has been retried */
	retryCount?: number;
	/** QA feedback that triggered this rework */
	qaFeedback?: string;
}

// ============================================================================
// Messages (JSONL entries)
// ============================================================================

export type MessageType = "status" | "text" | "tool" | "mention" | "reply" | "message" | "done" | "error";

export interface TaskMessage {
	ts: string;
	from: string;
	type: MessageType;
	text: string;
	to?: string;
	name?: string;
	args?: Record<string, unknown>;
}

// ============================================================================
// Context (extension-maintained live state)
// ============================================================================

export interface ContextAgentState {
	role: string;
	status: "working" | "idle";
	task: string | null;
}

export interface ContextTaskState {
	status: TaskStatus;
	agent: string;
	title: string;
	output?: string;
	blockedBy?: string[];
	subtasks?: Record<string, ContextTaskState>;
}

export interface ContextActivity {
	ts: string;
	agent: string;
	action: string;
}

export interface SquadContext {
	goal: string;
	status: SquadStatus;
	elapsed: string;
	costs: {
		total: number;
		byAgent: Record<string, number>;
	};
	agents: Record<string, ContextAgentState>;
	tasks: Record<string, ContextTaskState>;
	recentActivity: ContextActivity[];
	modifiedFiles: Record<string, string[]>;
}

// ============================================================================
// Knowledge (JSONL entries)
// ============================================================================

export type KnowledgeType = "decision" | "convention" | "finding";

export interface KnowledgeEntry {
	ts: string;
	from: string;
	squad?: string;
	type: KnowledgeType;
	text: string;
}

// ============================================================================
// Scheduler
// ============================================================================

export interface AgentActivity {
	taskId: string;
	agentName: string;
	lastOutputTs: number;
	startedAt: number;
	turnCount: number;
	/** Ring buffer of recent tool call signatures for loop detection */
	recentToolCalls: string[];
	/** Set of file paths this agent has modified */
	modifiedFiles: Set<string>;
}

export type HealthStatus = "healthy" | "idle_warning" | "stuck" | "looping" | "exceeded_ceiling";

// ============================================================================
// Supervisor
// ============================================================================

export type SupervisorVerdict = "approve" | "revise" | "escalate";

export interface SupervisorResult {
	verdict: SupervisorVerdict;
	reason: string;
	feedback?: string;
}

// ============================================================================
// Planner
// ============================================================================

export interface PlannerOutput {
	agents: Record<string, { model?: string }>;
	tasks: Array<{
		id: string;
		title: string;
		description: string;
		agent: string;
		depends: string[];
	}>;
}

// ============================================================================
// Panel
// ============================================================================

export type PanelView = "tasks" | "messages" | "agents";

export interface PanelState {
	view: PanelView;
	selectedTaskIndex: number;
	selectedTaskId: string | null;
	scrollOffset: number;
	agentSelectedIndex: number;
}
