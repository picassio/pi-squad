/**
 * pi-squad — Multi-agent collaboration extension for Pi.
 *
 * Registers tools, commands, panel/widget controls, and session lifecycle hooks.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildSpecReader } from "./file-spec.js";
import { registerCommands } from "./commands.js";
import { registerLifecycle } from "./lifecycle.js";
import { focusSquad, runtime } from "./runtime.js";
import * as store from "./store.js";
import { registerTools } from "./tools-registration.js";

export default function (pi: ExtensionAPI) {
	// File-spec children load only the non-recursive reader and fail-closed guard.
	if (process.env.PI_SQUAD_CHILD === "1") { registerChildSpecReader(pi); return; }

	// Load the global master switch before any session lifecycle work can run.
	runtime.squadEnabled = store.loadSquadSettings().enabled;
	runtime.widgetState.enabled = runtime.squadEnabled;
	if (!runtime.squadEnabled) focusSquad(null);

	// Wire main-session thinking lookup (needs `pi`, guarded against stale API)
	runtime.getMainSessionThinking = () => {
		try {
			return pi.getThinkingLevel();
		} catch {
			return undefined;
		}
	};

	// Bootstrap default agents on first load
	const defaultsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "agents", "_defaults");
	store.bootstrapAgents(defaultsDir);

	// Collect squad skill paths
	const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "skills");
	const squadSkillPaths = getSquadSkillPaths(skillsDir);

	registerTools(pi, squadSkillPaths);
	registerLifecycle(pi, squadSkillPaths);
	registerCommands(pi, squadSkillPaths);
}

function getSquadSkillPaths(skillsDir: string): string[] {
	if (!fs.existsSync(skillsDir)) return [];
	return fs
		.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => path.join(skillsDir, d.name))
		.filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
}
