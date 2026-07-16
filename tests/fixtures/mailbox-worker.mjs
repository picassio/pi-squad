import { registerHooks } from "node:module";
import * as fs from "node:fs";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const [storeUrl, squadId, taskId, action, value, readyFile, barrierFile] = process.argv.slice(2);
const store = await import(storeUrl);
fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(barrierFile)) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

if (action === "queue") {
	store.queueTaskMessage(squadId, taskId, {
		id: value,
		ts: store.now(),
		from: "orchestrator",
		type: "message",
		text: `concurrent-${value}`,
	});
} else if (action === "ack") {
	store.acknowledgeTaskMessages(squadId, taskId, [value]);
} else {
	throw new Error(`Unknown action: ${action}`);
}
