/**
 * Minimal self-writing agent — bootstrap version.
 * Reads a GitHub issue, sends it + the codebase to Claude,
 * and opens a PR with the proposed changes.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, extname } from "path";

// --- Config from environment ---
const GH_TOKEN = env("GH_TOKEN");
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const REPO = env("GITHUB_REPOSITORY"); // e.g. "yourname/self-agent"
const ISSUE_NUMBER = env("ISSUE_NUMBER");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// --- GitHub API ---

async function ghApi<T = any>(method: string, endpoint: string, data?: unknown): Promise<T> {
  const url = `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- Claude API ---

async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { content: { text: string }[] };
  return json.content[0].text;
}

// --- Codebase gathering ---

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);
const SKIP_EXTS = new Set([".png", ".jpg", ".ico", ".woff", ".ttf", ".lock"]);

function gatherCodebase(dir = "."): string {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (!SKIP_EXTS.has(extname(entry))) {
        try {
          const content = readFileSync(full, "utf-8");
          files.push(`### FILE: ${full}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // skip binary / unreadable files
        }
      }
    }
  }

  walk(dir);
  return files.join("\n\n");
}

// --- Response parser ---

interface FileChange {
  path: string;
  content: string;
}

function parseFileBlocks(response: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = response.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("### FILE: ")) {
      const path = line.slice("### FILE: ".length).trim();
      i++;
      // expect opening ```
      if (i < lines.length && lines[i].startsWith("```")) {
        i++;
        const contentLines: string[] = [];
        while (i < lines.length && !lines[i].startsWith("```")) {
          contentLines.push(lines[i]);
          i++;
        }
        files.push({ path, content: contentLines.join("\n") });
      }
    }
    i++;
  }

  return files;
}

// --- Shell helper ---

function run(cmd: string) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

// --- Main ---

async function main() {
  console.log(`Processing issue #${ISSUE_NUMBER} in ${REPO}`);

  // 1. Fetch the issue
  const issue = await ghApi<{ title: string; body?: string }>(
    "GET",
    `/repos/${REPO}/issues/${ISSUE_NUMBER}`
  );
  console.log(`Issue: ${issue.title}`);

  // 2. Gather current codebase
  const codebase = gatherCodebase();

  // 3. Build prompt
  const prompt = `You are a coding agent. Your job is to modify a codebase based on a GitHub issue.

## IMPORTANT RULES
- Output ONLY the files that need to be created or modified.
- Use this exact format for each file:

### FILE: path/to/file.ts
\`\`\`
full file content here
\`\`\`

- Output the COMPLETE file content, not partial diffs.
- Do NOT add any explanation outside of the file blocks.
- If you need to delete a file, output: ### DELETE: path/to/file.ts
- This is a TypeScript / Node.js project. Use ESM imports. Keep the code modern and clean.

## THE ISSUE

Title: ${issue.title}

${issue.body ?? ""}

## CURRENT CODEBASE

${codebase}
`;

  // 4. Call Claude
  console.log("Calling Claude...");
  const response = await callClaude(prompt);
  console.log(`Got response (${response.length} chars)`);

  // 5. Parse file blocks
  const changes = parseFileBlocks(response);
  if (changes.length === 0) {
    console.log("No file changes parsed. Raw response (first 2000 chars):");
    console.log(response.slice(0, 2000));
    await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
      body: "Agent ran but could not parse any file changes from the LLM response.",
    });
    process.exit(1);
  }

  console.log(`Parsed ${changes.length} file(s):`);
  for (const c of changes) console.log(`  - ${c.path}`);

  // 6. Create branch and apply changes
  const branch = `agent/issue-${ISSUE_NUMBER}`;
  run(`git checkout -b ${branch}`);

  for (const { path, content } of changes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    run(`git add "${path}"`);
  }

  // 7. Commit and push
  run('git config user.name "self-agent"');
  run('git config user.email "agent@noreply"');
  run(`git commit -m "Agent: ${issue.title} (#${ISSUE_NUMBER})"`);
  run(`git push origin ${branch}`);

  // 8. Open PR
  const pr = await ghApi<{ html_url: string }>(
    "POST",
    `/repos/${REPO}/pulls`,
    {
      title: `Agent: ${issue.title}`,
      head: branch,
      base: "main",
      body: `Automated changes for #${ISSUE_NUMBER}.\n\nReview carefully before merging.`,
    }
  );
  console.log(`PR created: ${pr.html_url}`);

  // 9. Comment on issue
  await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    body: `I've opened a PR with the proposed changes: ${pr.html_url}`,
  });

  console.log("Done!");
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});