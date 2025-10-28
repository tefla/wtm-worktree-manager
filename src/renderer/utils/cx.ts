export function cx(...values: Array<string | null | undefined | false | Record<string, boolean>>): string {
  const classes: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (typeof value === "string") {
      classes.push(value);
      continue;
    }
    for (const [key, active] of Object.entries(value)) {
      if (active) {
        classes.push(key);
      }
    }
  }
  return classes.join(" ").trim();
}
