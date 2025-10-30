export interface NormalizeBranchNameOptions {
  /**
   * Value to use when the input cannot be converted into a branch name.
   * Defaults to "workspace".
   */
  fallback?: string;
}

/**
 * Convert arbitrary user input into a git-safe branch/folder name.
 * The result is lowercase ASCII with non-alphanumeric characters collapsed to hyphens.
 */
export function normalizeBranchName(input: string, options: NormalizeBranchNameOptions = {}): string {
  const fallback = options.fallback?.trim() || "workspace";
  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  // Strip accents and diacritics, then drop any remaining non-ASCII characters.
  const asciiOnly = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");

  // Replace any sequence of invalid characters with a single hyphen.
  const hyphenated = asciiOnly
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (!hyphenated) {
    return fallback;
  }

  // Git branch names have a hard limit of 255 bytes; keep some headroom.
  const truncated = hyphenated.slice(0, 240).replace(/-+$/, "");
  if (!truncated) {
    return fallback;
  }

  // Branches cannot begin with a dot or contain consecutive dots; already prevented by regex.
  if (/^(?:-|\.|@{|\/)/.test(truncated)) {
    return `${fallback}-${truncated.replace(/^(?:-|\.|@{|\/)+/, "")}`.replace(/-+/g, "-");
  }

  return truncated;
}
