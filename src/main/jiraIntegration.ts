import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { URL, URLSearchParams } from "node:url";
import { defaultJiraProjectConfig, JiraProjectConfig } from "./projectConfig";
import type { JiraTicketSummary } from "../shared/jira";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_CAP = 500;

export interface JiraLoginResult {
  success: boolean;
  stdout: string;
  stderr: string;
  message?: string;
}

export class JiraIntegration {
  private config: JiraProjectConfig;

  constructor() {
    this.config = defaultJiraProjectConfig();
  }

  configure(nextConfig: JiraProjectConfig | null | undefined): void {
    if (!nextConfig) {
      this.config = defaultJiraProjectConfig();
      return;
    }
    this.config = { ...defaultJiraProjectConfig(), ...nextConfig };
  }

  getConfig(): JiraProjectConfig {
    return this.config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.site);
  }

  isEnabled(): boolean {
    return this.config.enabled && this.isConfigured();
  }

  async login(): Promise<JiraLoginResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        message: "Jira integration is not configured",
      };
    }
    const cli = this.resolveCliBinary();
    const args = [...this.buildBaseArgs(), "--action", "login"];
    try {
      const { stdout, stderr } = await execFileAsync(cli, args, { maxBuffer: 1024 * 1024 });
      return {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    } catch (error) {
      const execError = error as ExecFileException & { stdout?: string; stderr?: string };
      return {
        success: false,
        stdout: (execError.stdout ?? "").toString().trim(),
        stderr: (execError.stderr ?? "").toString().trim(),
        message: execError.message,
      };
    }
  }

  async fetchTickets(): Promise<JiraTicketSummary[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const cli = this.resolveCliBinary();
    const args = this.buildTicketFetchArgs();

    try {
      const { stdout } = await execFileAsync(cli, args, { maxBuffer: 10 * 1024 * 1024 });
      return this.parseTickets(stdout);
    } catch (error) {
      const execError = error as ExecFileException & { stdout?: string };
      const raw = execError.stdout ?? "";
      if (raw) {
        try {
          return this.parseTickets(raw);
        } catch (_) {
          // ignore parse fallback
        }
      }
      throw error;
    }
  }

  private resolveCliBinary(): string {
    return this.config.cliPath?.trim() || process.env.WTM_ACLI_PATH?.trim() || "acli";
  }

  private buildBaseArgs(): string[] {
    const args = ["--site", this.config.site];
    if (this.config.profile) {
      args.push("--profile", this.config.profile);
    }
    args.push("--quiet");
    return args;
  }

  private buildTicketFetchArgs(): string[] {
    const params = new URLSearchParams();
    const jql = this.config.jql || defaultJiraProjectConfig().jql;
    params.set("jql", jql);
    params.set("maxResults", String(this.clampMaxResults(this.config.maxResults)));
    params.set("fields", "key,summary");
    const url = `/rest/api/3/search?${params.toString()}`;
    // Atlassian CLI exposes Jira's REST API via the `callRestAPI` action. We
    // request JSON and let the cache layer normalise whatever structure we
    // receive in `parseTickets`.
    return [...this.buildBaseArgs(), "--action", "callRestAPI", "--method", "GET", "--url", url, "--outputFormat", "json"];
  }

  private clampMaxResults(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_MAX_RESULTS;
    }
    return Math.min(Math.floor(value), MAX_RESULTS_CAP);
  }

  private parseTickets(output: string): JiraTicketSummary[] {
    const jsonBody = this.extractJsonPayload(output);
    if (!jsonBody) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBody);
    } catch (error) {
      console.warn("Failed to parse Jira search response", error);
      return [];
    }
    const issues = Array.isArray((parsed as { issues?: unknown }).issues)
      ? ((parsed as { issues: unknown[] }).issues)
      : [];
    const tickets: JiraTicketSummary[] = [];
    for (const issue of issues) {
      if (!issue || typeof issue !== "object") {
        continue;
      }
      const record = issue as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key.trim() : "";
      const fields = record.fields && typeof record.fields === "object" ? (record.fields as Record<string, unknown>) : {};
      const summary = typeof fields.summary === "string" ? fields.summary.trim() : "";
      if (!key || !summary) {
        continue;
      }
      const ticket: JiraTicketSummary = { key: key.toUpperCase(), summary };
      const url = this.buildIssueUrl(key);
      if (url) {
        ticket.url = url;
      }
      tickets.push(ticket);
    }
    return tickets;
  }

  private extractJsonPayload(output: string): string | null {
    const trimmed = output.trim();
    if (!trimmed) {
      return null;
    }
    // Some ACLI builds prepend status lines before the JSON payload. We strip
    // everything prior to the first JSON delimiter so that `JSON.parse` can
    // succeed without additional heuristics.
    const firstBrace = trimmed.indexOf("{");
    const firstBracket = trimmed.indexOf("[");
    const candidates = [firstBrace, firstBracket].filter((index) => index >= 0);
    if (candidates.length === 0) {
      return null;
    }
    const start = Math.min(...candidates);
    return trimmed.slice(start);
  }

  private buildIssueUrl(issueKey: string): string | null {
    const base = this.config.browseUrl?.trim();
    if (!base) {
      return null;
    }
    try {
      const url = new URL(base);
      url.pathname = url.pathname.replace(/\/$/, "");
      url.pathname += `/browse/${encodeURIComponent(issueKey)}`;
      return url.toString();
    } catch (error) {
      console.warn("Failed to construct Jira issue URL", error);
      return null;
    }
  }
}
