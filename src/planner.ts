/**
 * planner.ts — One-shot planner agent for goal decomposition.
 *
 * Spawns a pi process in json mode to analyze the codebase
 * and produce a task breakdown with dependencies.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef, PlannerOutput } from "./types.js";
import { loadAllAgentDefs, loadAgentDef } from "./store.js";

// ============================================================================
// Planner
// ============================================================================

export interface PlannerOptions {
	goal: string;
	cwd: string;
	/** If provided, use this model for planning instead of the planner agent's default */
	model?: string;
}

/**
 * Run the planner agent to produce a task breakdown.
 * Returns the parsed plan or throws on failure.
 */
export async function runPlanner(options: PlannerOptions): Promise<PlannerOutput> {
	const { goal, cwd, model } = options;

	const plannerDef = loadAgentDef("planner", cwd);
	const allAgents = loadAllAgentDefs(cwd).filter((a) => a.name !== "planner");

	const agentList = allAgents
		.map((a) => `- **${a.name}** (${a.role}): ${a.description} [tags: ${a.tags.join(", ")}]`)
		.join("\n");

	const prompt = buildPlannerPrompt(goal, agentList);

	// Write prompt to temp file
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-planner-"));
	const promptFile = path.join(tmpDir, "planner-prompt.md");
	const systemFile = path.join(tmpDir, "planner-system.md");

	fs.writeFileSync(promptFile, prompt, "utf-8");

	const systemPrompt = plannerDef?.prompt || DEFAULT_PLANNER_SYSTEM;
	fs.writeFileSync(systemFile, systemPrompt, "utf-8");

	try {
		const output = await runPiJson({
			cwd,
			prompt: `Read the prompt file at ${promptFile} and follow the instructions.`,
			systemPromptFile: systemFile,
			model: model || plannerDef?.model || undefined,
		});

		return parsePlannerOutput(output);
	} finally {
		try {
			fs.unlinkSync(promptFile);
			fs.unlinkSync(systemFile);
			fs.rmdirSync(tmpDir);
		} catch {
			/* ignore */
		}
	}
}

// ============================================================================
// Pi JSON Mode Execution
// ============================================================================

interface PiJsonOptions {
	cwd: string;
	prompt: string;
	systemPromptFile?: string;
	model?: string;
}

async function runPiJson(options: PiJsonOptions): Promise<string> {
	const { cwd, prompt, systemPromptFile, model } = options;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (systemPromptFile) args.push("--append-system-prompt", systemPromptFile);
	args.push(prompt);

	const invocation = getPiInvocation(args);

	return new Promise<string>((resolve, reject) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const messages: any[] = [];

		let buffer = "";
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						messages.push(event.message);
					}
				} catch {
					/* skip */
				}
			}
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						messages.push(event.message);
					}
				} catch {
					/* skip */
				}
			}

			if (code !== 0 && messages.length === 0) {
				reject(new Error(`Planner failed (code ${code}): ${stderr.slice(0, 500)}`));
				return;
			}

			// Extract text from last assistant message
			const lastMsg = messages[messages.length - 1];
			if (!lastMsg) {
				reject(new Error("Planner produced no output"));
				return;
			}

			const text = lastMsg.content
				?.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("\n");

			resolve(text || "");
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to spawn planner: ${err.message}`));
		});
	});
}

// ============================================================================
// Output Parsing
// ============================================================================

function parsePlannerOutput(text: string): PlannerOutput {
	// Try to extract JSON from the text (might be wrapped in markdown code blocks)
	const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);

	if (!jsonMatch) {
		throw new Error("Planner output does not contain valid JSON");
	}

	try {
		const parsed = JSON.parse(jsonMatch[1]);

		// Validate structure
		if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
			throw new Error("Planner output missing 'tasks' array");
		}

		for (const task of parsed.tasks) {
			if (!task.id || !task.title || !task.agent) {
				throw new Error(`Invalid task in planner output: ${JSON.stringify(task)}`);
			}
			if (!task.depends) task.depends = [];
			if (!task.description) task.description = "";
		}

		if (!parsed.agents) parsed.agents = {};

		return parsed as PlannerOutput;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Planner output is not valid JSON: ${text.slice(0, 200)}`);
		}
		throw error;
	}
}

// ============================================================================
// Prompt
// ============================================================================

function buildPlannerPrompt(goal: string, agentList: string): string {
	return `# Task: Create a Squad Plan

## Goal
${goal}

## Available Agents
${agentList}

## Instructions

1. Read the codebase to understand the project structure, tech stack, and existing code
2. Break the goal into concrete, implementable tasks
3. Assign each task to the most appropriate agent based on their specialty
4. Define dependencies between tasks (which tasks must complete before others can start)
5. Keep the plan minimal — don't create tasks for things that aren't needed

## Output Format

Respond with a JSON object (and nothing else outside the JSON):

\`\`\`json
{
  "agents": {
    "agent-name": {},
    "agent-name": { "model": "override-model-if-needed" }
  },
  "tasks": [
    {
      "id": "short-kebab-id",
      "title": "Human-readable task title",
      "description": "Detailed description of what to implement",
      "agent": "agent-name",
      "depends": ["id-of-dependency", "another-dependency"]
    }
  ]
}
\`\`\`

## Rules
- Task IDs must be short kebab-case (e.g., "setup-db", "auth-middleware")
- Only reference agents that exist in the Available Agents list
- Dependencies must reference task IDs from your own plan
- First task(s) should have empty depends: []
- Include a final QA/verification task if there are user-facing changes
- Keep descriptions actionable — agent should know exactly what to build
- Don't over-decompose — 3-7 tasks is usually right for most goals
`;
}

const DEFAULT_PLANNER_SYSTEM = `You are a project planner. You analyze codebases and break goals into concrete tasks for a team of specialized agents. You read the project structure, understand the tech stack, and create minimal but complete task breakdowns. Always output valid JSON.`;

// ============================================================================
// Helpers
// ============================================================================

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}
