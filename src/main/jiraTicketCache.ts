import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { exec, execFile, type ExecFileOptions, type ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { JiraTicketSummary } from "../shared/jira";
import { ticketMatchesQuery } from "../shared/jira";

const execAsyncDefault = promisify(exec);
const execFileAsyncDefault = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };
type ExecAsyncFn = (command: string, options?: ExecOptions) => Promise<ExecResult>;
type ExecFileAsyncFn = (file: string, args: string[], options?: ExecFileOptions) => Promise<ExecResult>;

interface CachePayload {
  tickets: JiraTicketSummary[];
  fetchedAt: number;
}

const KEY_FIELDS = [
  "key",
  "Key",
  "id",
  "ID",
  "ticket",
  "Ticket",
  "issue",
  "Issue",
  "ISSUE",
  "issueKey",
  "IssueKey",
  "ISSUE_KEY",
  "issue key",
];

const SUMMARY_FIELDS = ["summary", "Summary", "title", "Title", "name", "Name", "description", "Description"];

const URL_FIELDS = ["url", "Url", "URL", "link", "Link", "browseUrl", "BrowseUrl", "browseURL"];

function pickFirstString(record: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    if (field in record) {
      const candidate = extractString(record[field]);
      if (candidate) {
        return candidate;
      }
    }
  }
  return "";
}

function extractString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function ensurePositiveInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function toText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

export interface JiraTicketCacheOptions {
  cacheFilePath?: string;
  execAsync?: ExecAsyncFn;
  execFileAsync?: ExecFileAsyncFn;
  now?: () => number;
}

export class JiraTicketCache {
  private cacheFilePath: string;
  private cache: CachePayload | null;
  private inflight: Promise<JiraTicketSummary[]> | null;
  private ttlMs: number;
  private execAsync: ExecAsyncFn;
  private execFileAsync: ExecFileAsyncFn;
  private now: () => number;
  private acliStatus: "unknown" | "available" | "missing";

  constructor(options: JiraTicketCacheOptions = {}) {
    const baseDir = join(homedir(), ".wtm");
    this.cacheFilePath = options.cacheFilePath ?? join(baseDir, "jira-ticket-cache.json");
    this.cache = null;
    this.inflight = null;
    const ttlCandidate = ensurePositiveInteger(process.env.WTM_JIRA_CACHE_TTL);
    this.ttlMs = ttlCandidate > 0 ? ttlCandidate : 5 * 60 * 1000;
    this.execAsync =
      options.execAsync ??
      (async (command, execOptions) => {
        const result = await execAsyncDefault(command, execOptions);
        return { stdout: toText(result.stdout), stderr: toText(result.stderr) };
      });
    this.execFileAsync =
      options.execFileAsync ??
      (async (file, args, execOptions) => {
        const result = await execFileAsyncDefault(file, args, execOptions);
        return { stdout: toText(result.stdout), stderr: toText(result.stderr) };
      });
    this.now = options.now ?? Date.now;
    this.acliStatus = "unknown";
  }

  async listTickets(options: { forceRefresh?: boolean } = {}): Promise<JiraTicketSummary[]> {
    const { forceRefresh = false } = options;
    const now = this.now();

    if (!forceRefresh && this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.tickets;
    }

    if (!forceRefresh) {
      const fromDisk = await this.readCacheFromDisk();
      if (fromDisk.tickets.length > 0) {
        this.cache = fromDisk;
        if (now - fromDisk.fetchedAt < this.ttlMs) {
          return fromDisk.tickets;
        }
      }
    }

    return this.refreshTickets(forceRefresh);
  }

  async searchTickets(query: string, options: { limit?: number; forceRefresh?: boolean } = {}): Promise<JiraTicketSummary[]> {
    const { limit = 20, forceRefresh = false } = options;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }
    const tickets = await this.listTickets({ forceRefresh });
    if (tickets.length === 0) {
      return [];
    }
    const matches: JiraTicketSummary[] = [];
    for (const ticket of tickets) {
      if (!ticketMatchesQuery(ticket, normalizedQuery)) {
        continue;
      }
      matches.push(ticket);
      if (matches.length >= limit) {
        break;
      }
    }
    return matches;
  }

  private async refreshTickets(forceRefresh: boolean): Promise<JiraTicketSummary[]> {
    if (this.inflight) {
      return this.inflight;
    }

    const pending = (async (): Promise<JiraTicketSummary[]> => {
      const fallback = await this.readCacheFromDisk();
      const command = extractString(process.env.WTM_JIRA_TICKET_COMMAND);

      if (command) {
        try {
          const tickets = await this.fetchTicketsFromCommand(command);
          if (tickets.length > 0) {
            const fetchedAt = this.now();
            this.cache = { tickets, fetchedAt };
            await this.writeCacheToDisk(this.cache);
            return tickets;
          }
        } catch (error) {
          console.warn("Failed to refresh Jira ticket cache from custom command", error);
        }
      }

      const acliTickets = await this.fetchTicketsUsingAcli(forceRefresh);
      if (acliTickets.length > 0) {
        const fetchedAt = this.now();
        this.cache = { tickets: acliTickets, fetchedAt };
        await this.writeCacheToDisk(this.cache);
        return acliTickets;
      }

      this.cache = { tickets: fallback.tickets, fetchedAt: this.now() };
      return this.cache.tickets;
    })();

    this.inflight = pending;
    try {
      return await pending;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchTicketsFromCommand(command: string): Promise<JiraTicketSummary[]> {
    const { stdout } = await this.execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      console.warn("Failed to parse Jira ticket command output", error);
      return [];
    }
    return this.normalizeTicketList(parsed);
  }

  private async fetchTicketsUsingAcli(forceRefresh: boolean): Promise<JiraTicketSummary[]> {
    if (this.acliStatus === "missing" && !forceRefresh) {
      return [];
    }
    const args = this.buildAcliArgs();
    if (!args) {
      return [];
    }
    const binary = extractString(process.env.WTM_JIRA_ACLI_BINARY) || "acli";
    let stdout: string;
    try {
      const result = await this.execFileAsync(binary, args, { maxBuffer: 10 * 1024 * 1024 });
      stdout = result.stdout.trim();
      this.acliStatus = "available";
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === "ENOENT") {
        this.acliStatus = "missing";
      }
      console.warn("Failed to refresh Jira ticket cache via Atlassian CLI", error);
      return [];
    }
    if (!stdout) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      console.warn("Failed to parse Atlassian CLI output for Jira tickets", error);
      return [];
    }
    return this.extractTicketsFromAcliPayload(parsed);
  }

  private buildAcliArgs(): string[] | null {
    const disable = extractString(process.env.WTM_JIRA_DISABLE_ACLI ?? process.env.WTM_JIRA_ACLI_DISABLED);
    if (disable && ["1", "true", "yes"].includes(disable.toLowerCase())) {
      return null;
    }

    const args: string[] = ["--action", "getIssueList", "--outputType", "json"];

    const query =
      extractString(process.env.WTM_JIRA_ACLI_QUERY) ||
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
    if (query) {
      args.push("--query", query);
    }

    const columns = extractString(process.env.WTM_JIRA_ACLI_COLUMNS) || "issue,summary,url";
    if (columns) {
      args.push("--columns", columns);
    }

    const project = extractString(process.env.WTM_JIRA_ACLI_PROJECT);
    if (project) {
      args.push("--project", project);
    }

    const limit = ensurePositiveInteger(process.env.WTM_JIRA_ACLI_LIMIT);
    if (limit > 0) {
      args.push("--limit", String(limit));
    }

    const server = extractString(
      process.env.WTM_JIRA_ACLI_SITE ?? process.env.WTM_JIRA_ACLI_SERVER ?? process.env.ACLI_SERVER,
    );
    if (server) {
      args.push("--server", server);
    }

    const profile = extractString(process.env.WTM_JIRA_ACLI_PROFILE);
    if (profile) {
      args.push("--profile", profile);
    }

    const extraArgs = extractString(process.env.WTM_JIRA_ACLI_EXTRA_ARGS);
    if (extraArgs) {
      args.push(...this.parseCliArgs(extraArgs));
    }

    return args;
  }

  private parseCliArgs(raw: string): string[] {
    const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
    const args: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
      if (match[1]) {
        args.push(match[1].replace(/\\(["'\\])/g, "$1"));
      } else if (match[2]) {
        args.push(match[2].replace(/\\(["'\\])/g, "$1"));
      } else {
        args.push(match[0]);
      }
    }
    return args;
  }

  private extractTicketsFromAcliPayload(payload: unknown): JiraTicketSummary[] {
    if (Array.isArray(payload)) {
      return this.normalizeTicketList(payload);
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const record = payload as Record<string, unknown>;

    const candidates = [
      record.tickets,
      record.issues,
      record.data,
      record.values,
      record.items,
      record.results,
      record.rows,
      record.entries,
      record.list,
      record.records,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        const normalized = this.normalizeTicketList(candidate);
        if (normalized.length > 0) {
          return normalized;
        }
      }
    }

    const tableCandidates = [record.table, record.result, record.output];
    for (const table of tableCandidates) {
      const normalized = this.normalizeTicketTablePayload(table);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  private normalizeTicketTablePayload(table: unknown): JiraTicketSummary[] {
    if (!table || typeof table !== "object") {
      return [];
    }
    const tableRecord = table as Record<string, unknown>;
    const rowsCandidates = [tableRecord.rows, tableRecord.data, tableRecord.values, tableRecord.entries];

    const columnsRaw = Array.isArray(tableRecord.columns) ? tableRecord.columns : [];
    const columnNames: string[] = [];
    for (const column of columnsRaw) {
      if (typeof column === "string") {
        columnNames.push(column);
      } else if (column && typeof column === "object") {
        const columnRecord = column as Record<string, unknown>;
        const name = pickFirstString(columnRecord, ["name", "Name", "key", "Key", "id", "Id", "column", "Column"]);
        if (name) {
          columnNames.push(name);
        }
      }
    }

    const records: Record<string, unknown>[] = [];
    for (const candidate of rowsCandidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }
      for (const row of candidate) {
        if (Array.isArray(row)) {
          const entry: Record<string, unknown> = {};
          const bound = columnNames.length > 0 ? columnNames.length : row.length;
          for (let index = 0; index < bound; index += 1) {
            const columnName = columnNames[index] ?? `col${index}`;
            entry[columnName] = row[index];
          }
          records.push(entry);
        } else if (row && typeof row === "object") {
          records.push(row as Record<string, unknown>);
        }
      }
      if (records.length > 0) {
        break;
      }
    }

    if (records.length === 0) {
      return [];
    }

    return this.normalizeTicketList(records);
  }

  private async readCacheFromDisk(): Promise<CachePayload> {
    try {
      const body = await readFile(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(body) as unknown;
      const ticketsSource = Array.isArray(parsed)
        ? parsed
        : (parsed as { tickets?: unknown }).tickets;
      const tickets = this.normalizeTicketList(ticketsSource);
      const fetchedAtSource = Array.isArray(parsed) ? undefined : (parsed as { fetchedAt?: unknown }).fetchedAt;
      let fetchedAt = ensurePositiveInteger(fetchedAtSource);
      if (!fetchedAt) {
        const stats = await stat(this.cacheFilePath).catch(() => undefined);
        fetchedAt = stats ? Math.floor(stats.mtimeMs) : this.now();
      }
      return { tickets, fetchedAt };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code !== "ENOENT") {
        console.warn("Failed to read Jira ticket cache", error);
      }
      return { tickets: [], fetchedAt: this.now() };
    }
  }

  private async writeCacheToDisk(payload: CachePayload): Promise<void> {
    await mkdir(dirname(this.cacheFilePath), { recursive: true });
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    await writeFile(this.cacheFilePath, body, { encoding: "utf8" });
  }

  private normalizeTicketList(source: unknown): JiraTicketSummary[] {
    if (!Array.isArray(source)) {
      return [];
    }
    const normalized: JiraTicketSummary[] = [];
    for (const entry of source) {
      const ticket = this.normalizeTicket(entry);
      if (ticket) {
        normalized.push(ticket);
      }
    }
    return normalized;
  }

  private normalizeTicket(entry: unknown): JiraTicketSummary | null {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const key = pickFirstString(record, KEY_FIELDS);
    const summary = pickFirstString(record, SUMMARY_FIELDS);
    const url = pickFirstString(record, URL_FIELDS);
    if (!key || !summary) {
      return null;
    }
    const ticket: JiraTicketSummary = {
      key: key.toUpperCase(),
      summary,
    };
    if (url) {
      ticket.url = url;
    }
    return ticket;
  }
}

export const jiraTicketCache = new JiraTicketCache();
