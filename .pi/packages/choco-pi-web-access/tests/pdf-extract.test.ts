// @ts-nocheck
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractorUrl = new URL("../pdf-extract.ts", import.meta.url).href;

function childScript(provider = "unpdf", datalab = false) {
	return `
		import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
		import { tmpdir } from 'node:os';
		import { join } from 'node:path';
		const root = await mkdtemp(join(tmpdir(), 'choco-pi-pdf-'));
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.DATALAB_API_KEY = ${JSON.stringify(datalab ? "datalab-test" : "")};
		await writeFile(join(root, 'web-search.json'), JSON.stringify({ pdf: { provider: ${JSON.stringify(provider)} } }));
		const calls = [];
		if (${JSON.stringify(datalab)}) globalThis.fetch = async (url) => {
			const target = String(url); calls.push(target);
			if (target.includes('/files/upload')) return new Response(JSON.stringify({ file_id: 7, upload_url: 'https://storage.test/put/abc', reference: 'datalab://file-7' }), { status: 200 });
			if (target.includes('/put/')) return new Response(null, { status: 200 });
			if (target.includes('/files/7/confirm')) return new Response(JSON.stringify({ file_id: 7, reference: 'datalab://file-7' }), { status: 200 });
			if (target.endsWith('/files/7')) return new Response(null, { status: 200 });
			if (target.includes('/convert')) return new Response(JSON.stringify({ status: 'processing', request_check_url: '/check/1' }), { status: 200 });
			if (target.includes('/check/1')) return new Response(JSON.stringify({ status: 'complete', success: true, markdown: '<!-- Page 1 -->\\nDatalab PDF', page_count: 1 }), { status: 200 });
			throw new Error('unexpected fetch ' + target);
		};
		const { extractPDFToMarkdown } = await import(${JSON.stringify(extractorUrl)});
		const output = await mkdtemp(join(tmpdir(), 'choco-pi-pdf-output-'));
		const result = await extractPDFToMarkdown(makePdf('Hello PDF'), 'https://example.test/hello.pdf', { outputDir: output });
		console.log(JSON.stringify({ content: await readFile(result.outputPath, 'utf8'), pages: result.pages, calls }));
		function makePdf(text) {
			const content = 'BT /F1 24 Tf 72 720 Td (' + text + ') Tj ET';
			const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length ' + Buffer.byteLength(content, 'ascii') + ' >>\\nstream\\n' + content + '\\nendstream'];
			let body = '%PDF-1.4\\n'; const offsets = [0];
			for (let i=0;i<objects.length;i++){ offsets.push(Buffer.byteLength(body,'ascii')); body += String(i+1)+' 0 obj\\n'+objects[i]+'\\nendobj\\n'; }
			const xref = Buffer.byteLength(body,'ascii'); body += 'xref\\n0 '+String(objects.length+1)+'\\n0000000000 65535 f \\n';
			for (const offset of offsets.slice(1)) body += String(offset).padStart(10,'0')+' 00000 n \\n';
			body += 'trailer\\n<< /Size '+String(objects.length+1)+' /Root 1 0 R >>\\nstartxref\\n'+String(xref)+'\\n%%EOF\\n';
			return new TextEncoder().encode(body).buffer;
		}
	`;
}

test("local unpdf extraction works without native Promise.try", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: childScript(), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.match(result.content, /Hello PDF/);
	assert.equal(result.pages, 1);
	assert.deepEqual(result.calls, []);
});

test("auto PDF extraction uses Datalab when configured", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: childScript("auto", true), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.match(result.content, /Datalab PDF/);
	assert.ok(result.calls.some((url) => url.includes("/convert")));
});

test("provider=unpdf skips an available Datalab backend", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: childScript("unpdf", true), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.match(result.content, /Hello PDF/);
	assert.deepEqual(result.calls, []);
});

test("isPDF recognizes URL and content type", async () => {
	const { isPDF } = await import(extractorUrl);
	assert.equal(isPDF("https://example.test/file.pdf"), true);
	assert.equal(isPDF("https://example.test/download", "application/pdf"), true);
	assert.equal(isPDF("https://example.test/page", "text/html"), false);
});
