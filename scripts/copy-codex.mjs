// n8n reads the codex file (categories, search aliases, docs links) from next to the compiled node.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
for (const file of ['nodes/Rendley/Rendley.node.json']) {
	mkdirSync(dirname('dist/' + file), { recursive: true });
	cpSync(file, 'dist/' + file);
	console.log('copied', file);
}
