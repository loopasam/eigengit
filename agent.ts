/**
 * Minimal self-writing agent — bootstrap version.
 * Reads a GitHub issue, sends it + the codebase to Claude,
 * and opens a PR with the proposed changes.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, extname } from "path";
import { ResponseValidator, ContentSanitizer, DEFAULT_VALIDATION_CONFIG } from "./lib/validation.js";
import { RollbackManager } from "./lib/rollback.js";

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

// --- Issue creation functionality ---

interface IssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string;
  assignees?: string[];
}

async function createGitHubIssue(issueData: IssueInput): Promise<{ html_url: string; number: number }> {
  const issue = await ghApi<{ html_url: string; number: number }>(
    "POST",
    `/repos/${REPO}/issues`,
    issueData
  );
  console.log(`Created issue #${issue.number}: ${issue.html_url}`);
  return issue;
}

function parseIssueInstructions(content: string): IssueInput[] {
  const issues: IssueInput[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Look for issue creation instruction patterns
    if (line.startsWith("### CREATE ISSUE:") || line.startsWith("CREATE ISSUE:")) {
      const titleMatch = line.match(/CREATE ISSUE:\s*(.+)/);
      if (titleMatch) {
        const title = titleMatch[1].trim();
        i++;
        
        // Collect body content until next instruction or end
        const bodyLines: string[] = [];
        const labels: string[] = [];
        let assignee: string | undefined;
        
        while (i < lines.length) {
          const currentLine = lines[i].trim();
          
          // Check for next issue or end of instructions
          if (currentLine.startsWith("### CREATE ISSUE:") || 
              currentLine.startsWith("CREATE ISSUE:") ||
              currentLine.startsWith("### FILE:") ||
              currentLine.startsWith("### DELETE:")) {
            break;
          }
          
          // Parse special directives
          if (currentLine.startsWith("LABELS:")) {
            const labelStr = currentLine.replace("LABELS:", "").trim();
            labels.push(...labelStr.split(",").map(l => l.trim()).filter(Boolean));
          } else if (currentLine.startsWith("ASSIGNEE:")) {
            assignee = currentLine.replace("ASSIGNEE:", "").trim();
          } else if (currentLine) {
            bodyLines.push(lines[i]); // Keep original formatting
          } else if (bodyLines.length > 0) {
            bodyLines.push(""); // Preserve empty lines within body
          }
          
          i++;
        }
        
        // Remove trailing empty lines
        while (bodyLines.length > 0 && !bodyLines[bodyLines.length - 1].trim()) {
          bodyLines.pop();
        }
        
        const issueData: IssueInput = {
          title,
          body: bodyLines.length > 0 ? bodyLines.join("\n") : undefined,
          labels: labels.length > 0 ? labels : undefined,
          assignee: assignee || undefined,
        };
        
        issues.push(issueData);
        continue; // Don't increment i since we already positioned at next instruction
      }
    }
    i++;
  }

  return issues;
}

// --- Main ---

async function main() {
  console.log(`Processing issue #${ISSUE_NUMBER} in ${REPO}`);

  // Initialize validation and rollback systems
  const validator = new ResponseValidator(DEFAULT_VALIDATION_CONFIG);
  const rollbackManager = new RollbackManager();
  
  // Validate git state
  if (!rollbackManager.validateGitState()) {
    throw new Error("Git working directory is not clean or not in a git repository");
  }

  // Create rollback snapshot
  const snapshotId = `issue-${ISSUE_NUMBER}-${Date.now()}`;
  rollbackManager.createSnapshot(snapshotId);

  try {
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
- Output ONLY the files that need to be created or modified AND any issues to create.
- Use this exact format for each file:

### FILE: path/to/file.ts
\`\`\`
full file content here
\`\`\`

- To create GitHub issues, use this format:

### CREATE ISSUE: Issue Title Here
LABELS: bug, enhancement
ASSIGNEE: username

Issue body content goes here.
Multiple lines are supported.

- Output the COMPLETE file content, not partial diffs.
- Do NOT add any explanation outside of the file blocks and issue creation blocks.
- If you need to delete a file, output: ### DELETE: path/to/file.ts
- This is a TypeScript / Node.js project. Use ESM imports. Keep the code modern and clean.
- You can create issues when the main issue requests it, or when you think additional issues would be helpful for tracking follow-up work.

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

    // 5. Validate response format
    const formatValidation = validator.validateResponseFormat(response);
    if (!formatValidation.valid) {
      console.error("Response format validation failed:");
      formatValidation.errors.forEach(error => console.error(`  - ${error}`));
      throw new Error("Invalid response format from LLM");
    }

    if (formatValidation.warnings.length > 0) {
      console.warn("Response format warnings:");
      formatValidation.warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    // 6. Parse issue creation instructions first
    const issuesToCreate = parseIssueInstructions(response);
    console.log(`Found ${issuesToCreate.length} issues to create`);

    // Create the issues
    const createdIssues: { title: string; url: string; number: number }[] = [];
    for (const issueData of issuesToCreate) {
      try {
        const createdIssue = await createGitHubIssue(issueData);
        createdIssues.push({
          title: issueData.title,
          url: createdIssue.html_url,
          number: createdIssue.number
        });
      } catch (error) {
        console.error(`Failed to create issue "${issueData.title}":`, error);
      }
    }

    // 7. Parse and validate file blocks
    const changes = parseFileBlocks(response);
    
    if (changes.length === 0 && createdIssues.length === 0) {
      console.log("No file changes or issues parsed. Raw response (first 2000 chars):");
      console.log(response.slice(0, 2000));
      await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
        body: "Agent ran but could not parse any file changes or issue creation instructions from the LLM response.",
      });
      process.exit(1);
    }

    // 8. Validate changes if any exist
    let prUrl = "";
    if (changes.length > 0) {
      console.log(`Parsed ${changes.length} file(s):`);
      for (const c of changes) console.log(`  - ${c.path}`);

      // Comprehensive validation
      const validation = validator.validateChanges(response, changes);
      
      if (!validation.valid) {
        console.error("Validation failed:");
        validation.errors.forEach(error => console.error(`  - ${error}`));
        
        // Comment on the issue about validation failure
        await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
          body: `Agent validation failed:\n\n${validation.errors.map(e => `- ${e}`).join('\n')}\n\nNo changes were applied.`,
        });
        
        throw new Error("Validation failed - changes rejected for safety");
      }

      if (validation.warnings.length > 0) {
        console.warn("Validation warnings:");
        validation.warnings.forEach(warning => console.warn(`  - ${warning}`));
      }

      // 9. Apply changes with safety measures
      const branch = `agent/issue-${ISSUE_NUMBER}`;
      run(`git checkout -b ${branch}`);

      try {
        for (const change of changes) {
          // Track file for rollback
          rollbackManager.trackChange(snapshotId, change.path);
          
          // Sanitize content
          const sanitizedContent = ContentSanitizer.normalizeContent(
            ContentSanitizer.sanitizeContent(change.content, change.path)
          );
          
          // Create directory and write file
          mkdirSync(dirname(change.path), { recursive: true });
          writeFileSync(change.path, sanitizedContent, "utf-8");
          run(`git add "${change.path}"`);
        }

        // 10. Commit and push with validation check
        run('git config user.name "self-agent"');
        run('git config user.email "agent@noreply"');
        run(`git commit -m "Agent: ${issue.title} (#${ISSUE_NUMBER})"`);
        
        // Final validation: check if commit was created successfully
        const commitHash = run('git rev-parse HEAD').trim();
        console.log(`Created commit: ${commitHash}`);
        
        run(`git push origin ${branch}`);

        // 11. Open PR
        const pr = await ghApi<{ html_url: string }>(
          "POST",
          `/repos/${REPO}/pulls`,
          {
            title: `Agent: ${issue.title}`,
            head: branch,
            base: "main",
            body: `Automated changes for #${ISSUE_NUMBER}.\n\n**Validation Results:**\n${validation.warnings.length > 0 ? `Warnings:\n${validation.warnings.map(w => `- ${w}`).join('\n')}\n\n` : ''}Review carefully before merging.\n\n**Safety measures applied:**\n- Response format validated\n- File paths sanitized\n- Content validated and normalized\n- Rollback snapshot created: \`${snapshotId}\``,
          }
        );
        prUrl = pr.html_url;
        console.log(`PR created: ${prUrl}`);

      } catch (error) {
        console.error("Error applying changes:", error);
        
        // Attempt rollback
        try {
          console.log("Attempting rollback...");
          rollbackManager.rollbackToSnapshot(snapshotId);
          console.log("Rollback completed successfully");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError);
        }
        
        throw error;
      }
    }

    // 12. Comment on issue with results
    let commentBody = "";
    
    if (prUrl) {
      commentBody += `I've opened a PR with the proposed changes: ${prUrl}\n\n`;
      commentBody += `**Safety measures applied:**\n`;
      commentBody += `- ✅ Response format validated\n`;
      commentBody += `- ✅ File paths sanitized\n`;
      commentBody += `- ✅ Content validated and normalized\n`;
      commentBody += `- ✅ Rollback snapshot created\n\n`;
    }
    
    if (createdIssues.length > 0) {
      commentBody += `I've also created ${createdIssues.length} additional issue(s):\n`;
      for (const issue of createdIssues) {
        commentBody += `- #${issue.number}: ${issue.title} (${issue.url})\n`;
      }
    }
    
    if (!commentBody) {
      commentBody = "Agent processed the issue but no changes or additional issues were needed.";
    }

    await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
      body: commentBody.trim(),
    });

    console.log("Done!");

  } catch (error) {
    console.error("Agent execution failed:", error);
    
    // Comment on issue about the failure
    await ghApi("POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
      body: `Agent execution failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nRollback snapshot available: \`${snapshotId}\``,
    });
    
    throw error;
  }
}

main().catch((err) => {
  console.error("Agent failed:", err);
  process.exit(1);
});