#!/usr/bin/env node
/**
 * validate-spec.mjs — validate a pi-squad strict v1 file spec and print the
 * exact specSha256 to pass to the squad tool.
 *
 * Usage: node validate-spec.mjs <spec.v1.json>
 *
 * This runs the SAME validator the squad tool uses (src/file-spec.ts), so a
 * VALID result here is exactly what squad({ specFile, specSha256 }) accepts.
 */
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.features.typescript) {
	console.error(
		"This validator needs Node.js with type stripping: Node >= 23.6, or Node >= 22.6 run as\n" +
		"  node --experimental-strip-types validate-spec.mjs <spec.v1.json>",
	);
	process.exit(2);
}

// The extension sources use ".js" specifiers resolved by Pi; map them to the
// on-disk ".ts" files when loading the real validator outside Pi.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try {
				return nextResolve(specifier, context);
			} catch {
				return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const specArg = process.argv[2];
if (!specArg) {
	console.error("Usage: node validate-spec.mjs <spec.v1.json>");
	process.exit(2);
}
const specPath = resolve(process.cwd(), specArg);

const { prepareSpec } = await import(new URL("../../file-spec.ts", import.meta.url).href);

try {
	const raw = readFileSync(specPath);
	const sha256 = createHash("sha256").update(raw).digest("hex");
	// Validation with the self-computed hash: the hash gate passes trivially and
	// every structural/strictness rule still runs.
	const prepared = prepareSpec(specPath, sha256, process.cwd());
	console.log("VALID");
	console.log(`specFile:   ${specPath}`);
	console.log(`specSha256: ${prepared.sha256}`);
	console.log(`bytes:      ${prepared.raw.length}`);
	console.log(`tasks:      ${prepared.spec.tasks.length}`);
	console.log(`agents:     ${Object.keys(prepared.spec.agents).join(", ")}`);
	console.log("");
	console.log(`squad({ specFile: ${JSON.stringify(specPath)}, specSha256: ${JSON.stringify(prepared.sha256)} })`);
} catch (error) {
	console.error(`INVALID: ${error.message}`);
	process.exit(1);
}
