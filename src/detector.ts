import { stripHeredocs } from './shell';
import type { Risk, Severity, TimelineEvent } from './types';

interface CommandRule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

/** Dangerous shell command patterns. */
export const COMMAND_RULES: CommandRule[] = [
  {
    rule: 'rm-rf',
    severity: 'critical',
    pattern: /(^|[\s;&|(])rm\s+(?:-[a-zA-Z]*\s+)*(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[rR]\s+-f|-f\s+-[rR]|--recursive\s+--force|--force\s+--recursive)\b/i,
    message: 'Recursive force delete (rm -rf)',
  },
  {
    rule: 'rm-recursive',
    severity: 'high',
    pattern: /(^|[\s;&|(])rm\s+(?:-[a-zA-Z]*\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
    message: 'Recursive delete (rm -r)',
  },
  { rule: 'git-reset-hard', severity: 'critical', pattern: /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/, message: 'git reset --hard discards uncommitted work' },
  { rule: 'git-clean', severity: 'critical', pattern: /\bgit\s+clean\s+(?:\S+\s+)*-[a-zA-Z]*f/, message: 'git clean -f permanently deletes untracked files' },
  { rule: 'git-force-push', severity: 'critical', pattern: /\bgit\s+push\b[^\n;&|]*(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S+)/, message: 'Force push rewrites remote history' },
  { rule: 'git-discard', severity: 'high', pattern: /\bgit\s+(?:checkout\s+(?:\S+\s+)*--\s+\.|restore\s+(?:\S+\s+)*\.(?:\s|$)|checkout\s+\.(?:\s|$))/, message: 'Discards working tree changes' },
  { rule: 'git-branch-delete', severity: 'medium', pattern: /\bgit\s+branch\s+(?:\S+\s+)*-D\b/, message: 'Force-deletes a git branch' },
  {
    rule: 'pipe-to-shell',
    severity: 'critical',
    pattern: /\b(?:curl|wget|fetch)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby)\b/,
    message: 'Pipes a remote script straight into a shell',
  },
  { rule: 'eval-remote', severity: 'critical', pattern: /\b(?:eval|source)\s+["']?\$\(\s*(?:curl|wget)\b|(?:ba)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|<\(\s*(?:curl|wget)\b/, message: 'Executes remote code' },
  { rule: 'base64-exec', severity: 'critical', pattern: /base64\s+(?:-d|--decode)[^\n;&]*\|\s*(?:ba|z)?sh\b/, message: 'Executes obfuscated (base64) payload' },
  { rule: 'chmod-777', severity: 'high', pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*(?:0?777|a\+rwx|ugo\+rwx)\b/, message: 'Makes files world-writable (chmod 777)' },
  { rule: 'chmod-recursive', severity: 'medium', pattern: /\bchmod\s+(?:\S+\s+)*-[a-zA-Z]*R/, message: 'Recursive permission change' },
  { rule: 'chown-recursive', severity: 'medium', pattern: /\bchown\s+(?:\S+\s+)*-[a-zA-Z]*R/, message: 'Recursive ownership change' },
  { rule: 'sudo', severity: 'medium', pattern: /(^|[\s;&|(])sudo\s/, message: 'Runs with root privileges (sudo)' },
  { rule: 'disk-wipe', severity: 'critical', pattern: /\b(?:mkfs(?:\.\w+)?|wipefs)\b|\bdd\s+[^\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|disk)/, message: 'Writes directly to a disk device' },
  { rule: 'fork-bomb', severity: 'critical', pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, message: 'Fork bomb' },
  { rule: 'find-delete', severity: 'high', pattern: /\bfind\b[^\n;&|]*\s-delete\b|\bfind\b[^\n;&|]*-exec\s+rm\b/, message: 'Bulk delete via find' },
  { rule: 'sql-destructive', severity: 'high', pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, message: 'Destructive SQL statement' },
  { rule: 'publish', severity: 'medium', pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, message: 'Publishes a package to a public registry' },
  { rule: 'history-wipe', severity: 'medium', pattern: /\bhistory\s+-c\b|>\s*~\/\.\w*_history\b/, message: 'Clears shell history' },
];

export interface SensitiveRule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
  label: string;
}

/** Paths that hold credentials or secrets. Matched against normalized paths and command text. */
export const SENSITIVE_PATHS: SensitiveRule[] = [
  { rule: 'sensitive-file', severity: 'high', pattern: /(^|[\/\s"'=])\.env(?:\.(?!example\b|sample\b|template\b)[\w.-]+)?(?=$|[\s"';|&)])/, label: '.env secrets file' },
  { rule: 'sensitive-file', severity: 'critical', pattern: /(^|[\/\s"'=~])\.ssh\/|(^|[\/\s"'])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b/, label: 'SSH key material' },
  { rule: 'sensitive-file', severity: 'critical', pattern: /\.aws\/credentials\b|\.config\/gcloud\b|\.azure\/|\.kube\/config\b/, label: 'cloud credentials' },
  { rule: 'sensitive-file', severity: 'high', pattern: /(^|[\/\s"'])\.(?:npmrc|pypirc|netrc|git-credentials|pgpass)\b/, label: 'registry / auth token file' },
  { rule: 'sensitive-file', severity: 'high', pattern: /[\w-]\.(?:pem|key|p12|pfx|keystore|jks)(?=$|[\s"';|&)])/, label: 'private key / certificate' },
  { rule: 'sensitive-file', severity: 'high', pattern: /(^|[\/\s"'])[\w-]*(?:credentials|secrets?|service[-_]account)[\w-]*\.(?:json|ya?ml|toml)\b/i, label: 'credentials file' },
  { rule: 'sensitive-file', severity: 'critical', pattern: /\/etc\/(?:shadow|sudoers|passwd)\b/, label: 'system auth file' },
];

const SECRET_CONTENT: { pattern: RegExp; label: string }[] = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key' },
  { pattern: /\bsk-(?:live|proj|ant|test)?-?[A-Za-z0-9_-]{20,}/, label: 'API secret key (sk-…)' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, label: 'GitHub token' },
  { pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, label: 'private key' },
  { pattern: /\b(?:secret|password|passwd|api[_-]?key|token)\w*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i, label: 'hard-coded credential' },
];

export const MASS_DELETE_THRESHOLD = 5;
export const MASS_CHANGE_THRESHOLD = 20;
export const MASS_WINDOW_MS = 2 * 60 * 1000;

const SEV_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxSeverity(risks: Risk[]): Severity | undefined {
  let best: Severity | undefined;
  for (const r of risks) if (!best || SEV_ORDER[r.severity] > SEV_ORDER[best]) best = r.severity;
  return best;
}

/** Risks for a single shell command. */
export function detectCommandRisks(rawCommand: string): Risk[] {
  const command = stripHeredocs(rawCommand);
  const risks: Risk[] = [];
  const seen = new Set<string>();
  for (const r of COMMAND_RULES) {
    if (r.pattern.test(command)) {
      // rm -rf already implies rm -r; chmod 777 -R already implies chmod -R
      if (r.rule === 'rm-recursive' && seen.has('rm-rf')) continue;
      if (r.rule === 'chmod-recursive' && seen.has('chmod-777')) continue;
      seen.add(r.rule);
      risks.push({ rule: r.rule, severity: r.severity, message: r.message });
    }
  }
  for (const s of SENSITIVE_PATHS) {
    if (s.pattern.test(command)) {
      risks.push({ rule: 'sensitive-file', severity: s.severity, message: `Command touches ${s.label}` });
      break;
    }
  }
  return risks;
}

export function detectSensitivePath(p: string): SensitiveRule | undefined {
  return SENSITIVE_PATHS.find((s) => s.pattern.test(p));
}

export function detectSecretContent(content: string): string | undefined {
  return SECRET_CONTENT.find((s) => s.pattern.test(content))?.label;
}

/** Risks for one event in isolation. */
export function detectEventRisks(ev: TimelineEvent): Risk[] {
  const risks: Risk[] = [];
  if (ev.type === 'shell_cmd' && ev.command) risks.push(...detectCommandRisks(ev.command));

  if (ev.path && ev.type !== 'shell_cmd' && ev.type !== 'checkpoint') {
    const s = detectSensitivePath(ev.path);
    if (s) {
      const verb = ev.type === 'tool_call' ? 'Reads' : ev.type === 'file_delete' ? 'Deletes' : 'Modifies';
      risks.push({ rule: 'sensitive-file', severity: s.severity, message: `${verb} ${s.label} (${ev.path})` });
    }
    if (ev.outsideRoot && ev.type !== 'tool_call') {
      risks.push({ rule: 'outside-project', severity: 'high', message: `Writes outside the project root: ${ev.path}` });
    }
  }

  if ((ev.type === 'file_create' || ev.type === 'file_edit') && !ev.path?.match(/\.env(\.|$)/)) {
    const written = ev.after ?? ev.snippet?.new;
    // Only flag secrets that were introduced by this event.
    const label = written ? detectSecretContent(written) : undefined;
    if (label && !(ev.before && detectSecretContent(ev.before) === label)) {
      risks.push({ rule: 'hardcoded-secret', severity: 'high', message: `Writes a secret (${label}) into source code` });
    }
  }

  const deleted = ev.deletedFiles?.length ?? 0;
  if (deleted >= MASS_DELETE_THRESHOLD) {
    risks.push({ rule: 'mass-delete', severity: 'critical', message: `Mass deletion: ${deleted} files removed` });
  }
  if (ev.type === 'checkpoint' && ev.files && ev.files.length >= MASS_CHANGE_THRESHOLD) {
    risks.push({ rule: 'mass-change', severity: 'medium', message: `Large change set: ${ev.files.length} files` });
  }
  return risks;
}

/**
 * Annotate every event with risks, including cross-event rules
 * (bursts of deletes / edits within a short time window).
 * Mutates and returns the given events.
 */
export function detectIncidents(events: TimelineEvent[]): TimelineEvent[] {
  for (const ev of events) {
    ev.risks = dedupe([...(ev.risks ?? []), ...detectEventRisks(ev)]);
  }
  burst(events, (e) => e.type === 'file_delete' && !e.deletedFiles?.length, MASS_DELETE_THRESHOLD, 'mass-delete', 'critical', (n) => `Mass deletion: ${n} delete operations within 2 minutes`);
  burst(events, (e) => e.type === 'file_edit' || e.type === 'file_create' || e.type === 'file_delete', MASS_CHANGE_THRESHOLD, 'mass-change', 'medium', (n) => `Mass change: ${n} file operations within 2 minutes`);
  return events;
}

function burst(
  events: TimelineEvent[],
  match: (e: TimelineEvent) => boolean,
  threshold: number,
  rule: string,
  severity: Severity,
  msg: (n: number) => string,
): void {
  const hits = events.filter(match);
  let lo = 0;
  const flagged = new Set<TimelineEvent>();
  for (let hi = 0; hi < hits.length; hi++) {
    const t = Date.parse(hits[hi].ts);
    while (t - Date.parse(hits[lo].ts) > MASS_WINDOW_MS) lo++;
    if (hi - lo + 1 >= threshold) for (let k = lo; k <= hi; k++) flagged.add(hits[k]);
  }
  for (const e of flagged) {
    if (!e.risks.some((r) => r.rule === rule)) e.risks.push({ rule, severity, message: msg(flagged.size) });
  }
}

function dedupe(risks: Risk[]): Risk[] {
  const seen = new Set<string>();
  return risks.filter((r) => {
    const k = r.rule + '|' + r.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
