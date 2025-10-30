import type {
  EnsureSessionParams,
  EnsureSessionResult,
} from "../terminalManager";
import { TerminalManager } from "../terminalManager";

export type EnsureSessionTransform = (result: EnsureSessionResult) => EnsureSessionResult;

export class TerminalService {
  private readonly ensureTransforms: EnsureSessionTransform[] = [];

  constructor(private readonly manager: TerminalManager) {}

  registerEnsureTransform(transform: EnsureSessionTransform): void {
    this.ensureTransforms.push(transform);
  }

  private applyEnsureTransforms(result: EnsureSessionResult): EnsureSessionResult {
    return this.ensureTransforms.reduce((acc, transform) => transform(acc), result);
  }

  async ensureSession(params: EnsureSessionParams, webContentsId: number): Promise<EnsureSessionResult> {
    const result = await this.manager.ensureSession(params, webContentsId);
    return this.applyEnsureTransforms(result);
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.manager.write(sessionId, data);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.manager.resize(sessionId, cols, rows);
  }

  async dispose(sessionId: string, options?: { skipPersist?: boolean; preserve?: boolean }): Promise<void> {
    await this.manager.dispose(sessionId, options);
  }

  async release(sessionId: string, webContentsId: number): Promise<void> {
    await this.manager.release(sessionId, webContentsId);
  }

  async listSessionsForWorkspace(workspacePath: string): Promise<unknown> {
    return this.manager.listSessionsForWorkspace(workspacePath);
  }

  async getWorkspaceState(workspacePath: string): Promise<unknown> {
    return this.manager.getWorkspaceState(workspacePath);
  }

  async listSavedWorkspaces(): Promise<unknown> {
    return this.manager.listSavedWorkspaces();
  }

  async markQuickCommandExecuted(workspacePath: string, slot: string): Promise<void> {
    await this.manager.markQuickCommandExecuted(workspacePath, slot);
  }

  async setActiveTerminal(workspacePath: string, slot: string | null): Promise<void> {
    await this.manager.setActiveTerminal(workspacePath, slot);
  }

  async clearWorkspaceState(workspacePath: string): Promise<void> {
    await this.manager.clearWorkspaceState(workspacePath);
  }
}
