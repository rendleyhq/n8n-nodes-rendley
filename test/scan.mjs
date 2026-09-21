// Runs n8n's community-package scanner (the gate used at verification) on this
// package the same way n8n does: package.json plus the built dist/ tree.
import { analyzePackage } from '@n8n/scan-community-package/scanner/scanner.mjs';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist'))) {
	console.error('dist/ is missing: run `npm run build` first.');
	process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'n8n-scan-'));
cpSync(join(root, 'package.json'), join(dir, 'package.json'));
cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
try {
	const result = await analyzePackage(dir);
	if (result.passed) {
		console.log('scan-community-package: passed');
	} else {
		console.log('scan-community-package: FAILED');
		console.log(result.message);
		if (result.details) console.log(result.details);
		process.exit(1);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
