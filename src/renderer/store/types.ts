export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface RecentProject {
  path: string;
  name: string;
}

export interface BranchCatalog {
  local: string[];
  remote: string[];
}
