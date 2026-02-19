/**
 * Response validation and safety checks for the agent
 */

import { readFileSync, statSync, existsSync } from "fs";
import { resolve, dirname, relative, isAbsolute, join } from "path";

export interface ValidationConfig {
  maxFileSize: number; // bytes
  maxFilesPerChange: number;
  allowedExtensions: Set<string>;
  forbiddenPaths: Set<string>;
  maxResponseSize: number; // bytes
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxFileSize: 1024 * 1024, // 1MB
  maxFilesPerChange: 20,
  allowedExtensions: new Set(['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.txt', '.gitignore']),
  forbiddenPaths: new Set([
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/root',
    '/home',
    '~',
    '../',
    'node_modules',
    '.git'
  ]),
  maxResponseSize: 500 * 1024 // 500KB
};

export interface FileChange {
  path: string;
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class ResponseValidator {
  constructor(private config: ValidationConfig = DEFAULT_VALIDATION_CONFIG) {}

  /**
   * Validate LLM response format before parsing
   */
  validateResponseFormat(response: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check response size
    if (response.length > this.config.maxResponseSize) {
      errors.push(`Response too large: ${response.length} bytes (max: ${this.config.maxResponseSize})`);
    }

    // Check for basic structure
    if (!response.includes('### FILE:') && !response.includes('CREATE ISSUE:')) {
      warnings.push('Response does not contain file changes or issue creation instructions');
    }

    // Look for malformed file blocks
    const fileBlocks = response.match(/### FILE:[^\n]*\n```[\s\S]*?```/g) || [];
    for (const block of fileBlocks) {
      if (!block.includes('```\n') || !block.endsWith('```')) {
        errors.push('Malformed file block detected - missing or incorrect code fences');
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate file paths for safety
   */
  validateFilePaths(changes: FileChange[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (changes.length > this.config.maxFilesPerChange) {
      errors.push(`Too many files: ${changes.length} (max: ${this.config.maxFilesPerChange})`);
    }

    for (const change of changes) {
      const pathValidation = this.validateSinglePath(change.path);
      if (!pathValidation.valid) {
        errors.push(...pathValidation.errors);
      }
      warnings.push(...pathValidation.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate a single file path
   */
  private validateSinglePath(filePath: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for absolute paths
    if (isAbsolute(filePath)) {
      errors.push(`Absolute path not allowed: ${filePath}`);
      return { valid: false, errors, warnings };
    }

    // Check for path traversal
    const resolvedPath = resolve(filePath);
    const projectRoot = resolve('.');
    const relativePath = relative(projectRoot, resolvedPath);
    
    if (relativePath.startsWith('../')) {
      errors.push(`Path outside project root: ${filePath}`);
    }

    // Check forbidden paths
    for (const forbidden of this.config.forbiddenPaths) {
      if (filePath.includes(forbidden)) {
        errors.push(`Forbidden path component: ${forbidden} in ${filePath}`);
      }
    }

    // Check file extension
    const ext = filePath.split('.').pop();
    if (ext && !this.config.allowedExtensions.has(`.${ext}`)) {
      warnings.push(`Uncommon file extension: .${ext} for ${filePath}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate file contents
   */
  validateFileContents(changes: FileChange[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const change of changes) {
      const contentValidation = this.validateSingleFileContent(change);
      if (!contentValidation.valid) {
        errors.push(...contentValidation.errors);
      }
      warnings.push(...contentValidation.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate individual file content
   */
  private validateSingleFileContent(change: FileChange): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check file size
    const contentSize = Buffer.byteLength(change.content, 'utf8');
    if (contentSize > this.config.maxFileSize) {
      errors.push(`File too large: ${change.path} (${contentSize} bytes, max: ${this.config.maxFileSize})`);
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /rm\s+-rf\s+\//, // dangerous rm commands
      /sudo\s+/, // sudo usage
      /eval\s*\(/, // eval usage
      /exec\s*\(/, // exec usage
      /process\.exit\s*\(\s*1\s*\)/, // hard exit calls
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(change.content)) {
        warnings.push(`Suspicious pattern detected in ${change.path}: ${pattern.source}`);
      }
    }

    // Basic syntax validation for known file types
    const ext = change.path.split('.').pop()?.toLowerCase();
    
    if (ext === 'json') {
      try {
        JSON.parse(change.content);
      } catch (e) {
        errors.push(`Invalid JSON syntax in ${change.path}: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    }

    if (ext === 'ts' || ext === 'js') {
      // Basic TypeScript/JavaScript validation
      if (!this.hasBalancedBraces(change.content)) {
        errors.push(`Unbalanced braces in ${change.path}`);
      }
      
      // Check for unterminated strings
      if (this.hasUnterminatedStrings(change.content)) {
        errors.push(`Unterminated strings detected in ${change.path}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check for balanced braces/brackets/parens
   */
  private hasBalancedBraces(content: string): boolean {
    const pairs = [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ];

    for (const [open, close] of pairs) {
      let count = 0;
      let inString = false;
      let escaped = false;

      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === '"' || char === "'" || char === '`') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === open) count++;
          if (char === close) count--;
        }
      }

      if (count !== 0) return false;
    }

    return true;
  }

  /**
   * Check for unterminated strings
   */
  private hasUnterminatedStrings(content: string): boolean {
    const quotes = ['"', "'", '`'];
    
    for (const quote of quotes) {
      let inString = false;
      let escaped = false;

      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\' && inString) {
          escaped = true;
          continue;
        }

        if (char === quote) {
          inString = !inString;
        }
      }

      if (inString) return true;
    }

    return false;
  }

  /**
   * Comprehensive validation of all changes
   */
  validateChanges(response: string, changes: FileChange[]): ValidationResult {
    const results = [
      this.validateResponseFormat(response),
      this.validateFilePaths(changes),
      this.validateFileContents(changes)
    ];

    const errors = results.flatMap(r => r.errors);
    const warnings = results.flatMap(r => r.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * Content sanitization utilities
 */
export class ContentSanitizer {
  /**
   * Remove potentially dangerous content from files
   */
  static sanitizeContent(content: string, filePath: string): string {
    let sanitized = content;

    // Remove dangerous shell commands (basic patterns)
    const dangerousPatterns = [
      /rm\s+-rf\s+\/[^\s]*/g,
      /sudo\s+rm[^\n]*/g,
      /curl[^|]*\|\s*bash/g,
      /wget[^|]*\|\s*bash/g,
    ];

    for (const pattern of dangerousPatterns) {
      sanitized = sanitized.replace(pattern, '// REMOVED: potentially dangerous command');
    }

    return sanitized;
  }

  /**
   * Basic content normalization
   */
  static normalizeContent(content: string): string {
    // Normalize line endings
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
}