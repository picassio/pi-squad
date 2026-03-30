/**
 * logger.ts — Squad debug logging to file, NOT stderr.
 *
 * Writing to stderr (console.error) corrupts the TUI because it bypasses
 * the TUI's differential renderer. All squad debug output goes to a log
 * file instead: ~/.pi/squad/debug.log
 *
 * Set PI_SQUAD_DEBUG=1 to enable logging. Without it, logs are silent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".pi", "squad");
const LOG_FILE = path.join(LOG_DIR, "debug.log");
const DEBUG = process.env.PI_SQUAD_DEBUG === "1";

/** Max log file size before rotation (2MB) */
const MAX_LOG_SIZE = 2 * 1024 * 1024;

let rotationChecked = false;

function ensureLogDir(): void {
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	} catch { /* ignore */ }
}

function rotateIfNeeded(): void {
	if (rotationChecked) return;
	rotationChecked = true;
	try {
		const stat = fs.statSync(LOG_FILE);
		if (stat.size > MAX_LOG_SIZE) {
			const backup = LOG_FILE + ".old";
			try { fs.unlinkSync(backup); } catch { /* ignore */ }
			fs.renameSync(LOG_FILE, backup);
		}
	} catch { /* file doesn't exist yet, fine */ }
}

/**
 * Log a debug message to ~/.pi/squad/debug.log.
 * Only writes when PI_SQUAD_DEBUG=1 is set. Silent otherwise.
 */
export function debug(prefix: string, ...args: unknown[]): void {
	if (!DEBUG) return;
	write(prefix, ...args);
}

/**
 * Always log to ~/.pi/squad/debug.log regardless of PI_SQUAD_DEBUG.
 * Use for errors and critical events that should never be lost.
 */
export function logError(prefix: string, ...args: unknown[]): void {
	write(prefix, ...args);
}

function write(prefix: string, ...args: unknown[]): void {
	try {
		ensureLogDir();
		rotateIfNeeded();
		const ts = new Date().toISOString();
		const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
		fs.appendFileSync(LOG_FILE, `[${ts}] [${prefix}] ${msg}\n`);
	} catch { /* never throw from logging */ }
}
