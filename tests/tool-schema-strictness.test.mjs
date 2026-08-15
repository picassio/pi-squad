import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Map ./x.js → ./x.ts for src imports (Node type stripping doesn't rewrite).
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

// Isolate squad storage in a temp HOME before importing store-touching code.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-schema-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { default: registerExtension } = await import("../src/index.ts");

function createFakeExtensionApi() {
	const tools = new Map();
	return {
		tools,
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand() {},
		on() {},
		sendMessage() {},
		getThinkingLevel() { return "medium"; },
	};
}

/**
 * Strict-provider JSON-Schema constraints for tool parameters.
 *
 * REGRESSION CONTEXT: pi sends EVERY registered tool's schema with EVERY
 * provider request. When the `squad` tool used a root-level Type.Union,
 * TypeBox emitted `{anyOf: [...]}` with no root `type`; strict OpenAI-style
 * providers (DeepSeek and others) rejected the ENTIRE request — so every
 * message in every session failed with a pi-squad error, even sessions that
 * never used squad tools. Gemini/Anthropic tolerated it, hiding the bug
 * until a model switch. This gate makes that class of schema unshippable.
 */
function violations(schema, where, out = []) {
	if (schema === null || typeof schema !== "object") return out;
	if (Array.isArray(schema)) {
		for (const item of schema) violations(item, where, out);
		return out;
	}
	const isSchemaNode =
		"type" in schema || "anyOf" in schema || "oneOf" in schema || "allOf" in schema ||
		"const" in schema || "enum" in schema || "$ref" in schema || "properties" in schema;
	if (isSchemaNode) {
		if (schema.type === null) out.push(`${where}: explicit "type": null`);
		const carriesType =
			typeof schema.type === "string" || "const" in schema || "enum" in schema || "$ref" in schema;
		const branches = schema.anyOf ?? schema.oneOf;
		if (!carriesType && !branches && !schema.allOf && "properties" in schema) {
			out.push(`${where}: object-shaped schema without "type": "object"`);
		}
		if (branches) {
			branches.forEach((branch, index) => {
				const branchTyped =
					branch && (typeof branch.type === "string" || "const" in branch || "enum" in branch || "$ref" in branch);
				if (!branchTyped) out.push(`${where}.anyOf[${index}]: union branch without a concrete "type"`);
				violations(branch, `${where}.anyOf[${index}]`, out);
			});
		}
	}
	for (const [key, value] of Object.entries(schema)) {
		if (key === "anyOf" || key === "oneOf") continue; // handled above
		if (value && typeof value === "object") violations(value, `${where}.${key}`, out);
	}
	return out;
}

test("every registered tool schema satisfies strict OpenAI-compatible providers", () => {
	const api = createFakeExtensionApi();
	registerExtension(api);
	assert.ok(api.tools.size >= 5, `expected the full tool set, got ${api.tools.size}`);

	for (const [name, tool] of api.tools) {
		const schema = tool.parameters;
		assert.ok(schema && typeof schema === "object", `${name}: missing parameters schema`);
		assert.equal(schema.type, "object",
			`${name}: root schema must be "type": "object" — a root union bricks every session on strict providers (DeepSeek regression)`);
		const problems = violations(schema, name);
		assert.deepEqual(problems, [], `${name}: strict-provider schema violations:\n${problems.join("\n")}`);
	}
});
