// The secret scan (cli/secret-scan.ts): each kind of secret is found and masked, the scratch placeholders and allowed
// roots pass, archived file contents are scanned decoded, and a directory is scanned file by file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { endoSecretScanDirectoryV0, endoSecretScanV0 } from "../cli/secret-scan.ts";

const SCRATCH = "/tmp/endo-experiment-abc123";
const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const scan = (text: string) => endoSecretScanV0([{ where: "x", text }], [SCRATCH, PI]);
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the secret scan", () => {
	it.each([
		["api-key", "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv here"],
		["api-key", "token ghp_0123456789abcdefghijABCDEFGHIJ"],
		["api-key", "AKIAABCDEFGHIJKLMNOP"],
		["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
		["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlc2ln"],
		["bearer-token", '"authorization":"Bearer abcdef0123456789"'],
		["secret-env", "OPENAI_API_KEY=abcd1234efgh"],
		["auth-header", "POST /v1 HTTP/1.1\r\nAuthorization: Basic dXNlcjpwYXNz\r\n"],
		["path-outside-scratch", "see /home/someone/project/file.ts"],
	])("finds %s, masked", (kind, text) => {
		const result = scan(text);
		expect(result.passed).toBe(false);
		expect(result.findings.map((finding) => finding.kind)).toContain(kind);
		for (const finding of result.findings.filter((f) => f.kind !== "path-outside-scratch"))
			expect(finding.masked).toMatch(/^.{4}\*+$/);
	});

	it("passes the scratch placeholder key, recorded redactions, and paths under allowed roots (counted)", () => {
		const result = scan(
			`{"apiKey":"local"} Bearer local {"name":"authorization","redacted":true} ${SCRATCH}/work/notes.txt ${PI}/docs/models.md`,
		);
		expect(result).toMatchObject({ passed: true, findings: [], allowedPaths: { [SCRATCH]: 1, [PI]: 1 } });
	});

	it("scans a directory file by file, decoding archived files (a key hidden in a workspace archive is found)", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-secret-scan-"));
		dirs.push(dir);
		mkdirSync(join(dir, "blobs", "fixture-public"), { recursive: true });
		writeFileSync(
			join(dir, "capture.events.jsonl"),
			`{"kind":"capture.request","payload":{"path":"/v1/chat/completions"}}\n`,
		);
		const archive = {
			schemaVersion: "endo.workspace-archive.v0",
			entries: [
				{
					path: ".env",
					type: "file",
					base64: Buffer.from("OPENAI_API_KEY=sk-live-0123456789abcdefghij").toString("base64"),
				},
			],
		};
		writeFileSync(join(dir, "blobs", "fixture-public", "a".repeat(64)), JSON.stringify(archive));
		const result = endoSecretScanDirectoryV0(dir, [SCRATCH]);
		expect(result.passed).toBe(false);
		expect(result.findings.map((finding) => finding.kind).sort()).toEqual(["api-key", "secret-env"]);
		expect(result.findings[0]!.where).toMatch(/blobs\/fixture-public\/a+\.entries\[0\]\.base64/);
	});
});
