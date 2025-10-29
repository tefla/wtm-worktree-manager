import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { JiraTicketSummary } from "../shared/jira";
import { ticketMatchesQuery } from "../shared/jira";

const execAsync = promisify(exec);

interface CachePayload {
  tickets: JiraTicketSummary[];
  fetchedAt: number;
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

export class JiraTicketCache {
  private cacheFilePath: string;
  private cache: CachePayload | null;
  private inflight: Promise<JiraTicketSummary[]> | null;
  private ttlMs: number;

  constructor() {
    const baseDir = join(homedir(), ".wtm");
    this.cacheFilePath = join(baseDir, "jira-ticket-cache.json");
    this.cache = null;
    this.inflight = null;
    const ttlCandidate = ensurePositiveInteger(process.env.WTM_JIRA_CACHE_TTL);
    this.ttlMs = ttlCandidate > 0 ? ttlCandidate : 5 * 60 * 1000;
  }

  async listTickets(options: { forceRefresh?: boolean } = {}): Promise<JiraTicketSummary[]> {
    const { forceRefresh = false } = options;
    const now = Date.now();

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

    return this.refreshTickets();
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

  private async refreshTickets(): Promise<JiraTicketSummary[]> {
    if (this.inflight) {
      return this.inflight;
    }

    const pending = (async (): Promise<JiraTicketSummary[]> => {
      const command = extractString(process.env.WTM_JIRA_TICKET_COMMAND);
      const fallback = await this.readCacheFromDisk();

      if (!command) {
        this.cache = { tickets: fallback.tickets, fetchedAt: Date.now() };
        return this.cache.tickets;
      }

      try {
        const tickets = await this.fetchTicketsFromCommand(command);
        if (tickets.length > 0) {
          const fetchedAt = Date.now();
          this.cache = { tickets, fetchedAt };
          await this.writeCacheToDisk(this.cache);
          return tickets;
        }
      } catch (error) {
        console.warn("Failed to refresh Jira ticket cache", error);
      }

      this.cache = { tickets: fallback.tickets, fetchedAt: Date.now() };
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
    const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
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
        fetchedAt = stats ? Math.floor(stats.mtimeMs) : Date.now();
      }
      return { tickets, fetchedAt };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code !== "ENOENT") {
        console.warn("Failed to read Jira ticket cache", error);
      }
      return { tickets: [], fetchedAt: Date.now() };
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
    const key = extractString(record.key ?? record.id ?? record.ticket ?? "");
    const summary = extractString(record.summary ?? record.title ?? record.name ?? "");
    const url = extractString(record.url ?? record.link ?? "");
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
