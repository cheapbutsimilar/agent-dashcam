import type { FileDiff } from './diff';

export type EventType =
  | 'file_edit'
  | 'file_create'
  | 'file_delete'
  | 'shell_cmd'
  | 'tool_call'
  | 'checkpoint';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Risk {
  /** Stable rule id, e.g. "rm-rf" or "sensitive-file". */
  rule: string;
  severity: Severity;
  message: string;
}

export type EventSource = 'claude' | 'git' | 'dashcam';

export interface TimelineEvent {
  /** Unique id inside a timeline. */
  id: string;
  /** Position in the sorted timeline (0-based), assigned by finalizeEvents. */
  seq: number;
  /** ISO timestamp. */
  ts: string;
  type: EventType;
  source: EventSource;
  title: string;
  /** Tool name for agent events (Bash, Edit, Write, Read, ...). */
  tool?: string;
  /** Project-relative path when inside the project root, otherwise absolute. */
  path?: string;
  /** True when `path` is outside the project root. */
  outsideRoot?: boolean;
  /**
   * File content before the event. `null` = file did not exist.
   * `undefined` = unknown (not captured by the log).
   */
  before?: string | null;
  /** File content after the event. Same null/undefined semantics as `before`. */
  after?: string | null;
  /** For edits whose full content is unknown: the replaced snippet. */
  snippet?: { old: string; new: string };
  /** Recursive delete (rm -r) of a directory: everything under `path` is gone. */
  recursive?: boolean;
  /** Files known to be removed by this event (expanded recursive deletes, git status). */
  deletedFiles?: string[];
  command?: string;
  output?: string;
  isError?: boolean;
  /** What the agent said right before this action. */
  reasoning?: string;
  /** Raw tool input for generic tool calls. */
  input?: unknown;
  /** Git commit hash for checkpoint events coming from git. */
  commit?: string;
  /** Changed files for git checkpoints. */
  files?: { path: string; status: string }[];
  /** Unified diff text for git working-tree checkpoints. */
  diffText?: string;
  risks: Risk[];
  /** Precomputed diff (before -> after) for file events, added by the server. */
  diff?: FileDiff;
}

export interface SessionInfo {
  id: string;
  file: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  eventCount?: number;
}

export interface Timeline {
  root: string;
  session: SessionInfo | null;
  events: TimelineEvent[];
  stats: {
    total: number;
    byType: Record<string, number>;
    risks: number;
    critical: number;
  };
}
