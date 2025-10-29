export interface JiraTicketSummary {
  key: string;
  summary: string;
  url?: string;
}

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normaliseTicketSummary(summary: string): string {
  if (!summary) {
    return "";
  }
  const cleaned = stripDiacritics(summary)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.toUpperCase();
}

export function buildWorkspaceBranchName(ticket: JiraTicketSummary): string {
  const key = ticket.key?.toUpperCase?.() ?? "";
  const normalisedSummary = normaliseTicketSummary(ticket.summary ?? "");
  if (!key) {
    return normalisedSummary;
  }
  if (!normalisedSummary) {
    return key;
  }
  return `${key}_${normalisedSummary}`;
}

export function ticketMatchesQuery(ticket: JiraTicketSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return false;
  }
  const key = ticket.key.toLowerCase();
  if (key.startsWith(query)) {
    return true;
  }
  const branchName = buildWorkspaceBranchName(ticket).toLowerCase();
  if (branchName.startsWith(query)) {
    return true;
  }
  const summary = ticket.summary?.toLowerCase?.() ?? "";
  return summary.includes(query);
}
