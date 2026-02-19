/**
 * Rollback mechanisms for failed changes
 */

import { execSync } from "child_process";

export interface RollbackSnapshot {
  commitHash: string;
  branch: string;
  timestamp: number;
  changes: string[];
}

export class RollbackManager {
  private snapshots: Map<string, RollbackSnapshot> = new Map();

  /**
   * Create a snapshot before making changes
   */
  createSnapshot(identifier: string): RollbackSnapshot {
    const commitHash = this.getCurrentCommitHash();
    const branch = this.getCurrentBranch();
    
    const snapshot: RollbackSnapshot = {
      commitHash,
      branch,
      timestamp: Date.now(),
      changes: []
    };

    this.snapshots.set(identifier, snapshot);
    console.log(`Created rollback snapshot: ${identifier} at ${commitHash}`);
    
    return snapshot;
  }

  /**
   * Add a file change to track for rollback
   */
  trackChange(identifier: string, filePath: string): void {
    const snapshot = this.snapshots.get(identifier);
    if (snapshot) {
      snapshot.changes.push(filePath);
    }
  }

  /**
   * Rollback to a snapshot
   */
  rollbackToSnapshot(identifier: string): void {
    const snapshot = this.snapshots.get(identifier);
    if (!snapshot) {
      throw new Error(`No snapshot found with identifier: ${identifier}`);
    }

    console.log(`Rolling back to snapshot: ${identifier}`);
    
    try {
      // Reset to the snapshot commit
      this.run(`git reset --hard ${snapshot.commitHash}`);
      
      // If we were on a different branch, switch back
      const currentBranch = this.getCurrentBranch();
      if (currentBranch !== snapshot.branch) {
        this.run(`git checkout ${snapshot.branch}`);
      }

      console.log(`Rollback completed successfully`);
    } catch (error) {
      console.error(`Rollback failed:`, error);
      throw error;
    } finally {
      this.snapshots.delete(identifier);
    }
  }

  /**
   * Rollback specific files only
   */
  rollbackFiles(identifier: string, files?: string[]): void {
    const snapshot = this.snapshots.get(identifier);
    if (!snapshot) {
      throw new Error(`No snapshot found with identifier: ${identifier}`);
    }

    const filesToRollback = files || snapshot.changes;
    
    if (filesToRollback.length === 0) {
      console.log('No files to rollback');
      return;
    }

    console.log(`Rolling back files: ${filesToRollback.join(', ')}`);
    
    try {
      for (const file of filesToRollback) {
        this.run(`git checkout ${snapshot.commitHash} -- "${file}"`);
      }
      
      console.log(`File rollback completed successfully`);
    } catch (error) {
      console.error(`File rollback failed:`, error);
      throw error;
    }
  }

  /**
   * Check if current state can be safely rolled back
   */
  canRollback(identifier: string): boolean {
    const snapshot = this.snapshots.get(identifier);
    if (!snapshot) {
      return false;
    }

    try {
      // Check if the snapshot commit still exists
      this.run(`git cat-file -e ${snapshot.commitHash}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up old snapshots
   */
  cleanupSnapshots(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, snapshot] of this.snapshots.entries()) {
      if (now - snapshot.timestamp > maxAge) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.snapshots.delete(id);
      console.log(`Cleaned up old snapshot: ${id}`);
    }
  }

  /**
   * Validate git state before operations
   */
  validateGitState(): boolean {
    try {
      // Check if we're in a git repo
      this.run('git rev-parse --git-dir');
      
      // Check if there are uncommitted changes
      const status = this.run('git status --porcelain').trim();
      if (status) {
        console.warn('Git working directory is not clean');
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current commit hash
   */
  private getCurrentCommitHash(): string {
    return this.run('git rev-parse HEAD').trim();
  }

  /**
   * Get current branch name
   */
  private getCurrentBranch(): string {
    return this.run('git rev-parse --abbrev-ref HEAD').trim();
  }

  /**
   * Execute git command with error handling
   */
  private run(cmd: string): string {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (error) {
      console.error(`Command failed: ${cmd}`);
      throw error;
    }
  }

  /**
   * Get snapshot information
   */
  getSnapshot(identifier: string): RollbackSnapshot | undefined {
    return this.snapshots.get(identifier);
  }

  /**
   * List all snapshots
   */
  listSnapshots(): { id: string; snapshot: RollbackSnapshot }[] {
    return Array.from(this.snapshots.entries()).map(([id, snapshot]) => ({ id, snapshot }));
  }
}