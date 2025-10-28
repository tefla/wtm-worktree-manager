import React, { FormEvent } from "react";

interface CreateWorkspaceFormProps {
  branchInput: string;
  baseInput: string;
  createInFlight: boolean;
  onBranchChange: (value: string) => void;
  onBaseChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export const CreateWorkspaceForm: React.FC<CreateWorkspaceFormProps> = ({
  branchInput,
  baseInput,
  createInFlight,
  onBranchChange,
  onBaseChange,
  onSubmit,
}) => {
  return (
    <section className="create-section">
      <form id="create-form" autoComplete="off" onSubmit={onSubmit}>
        <label className="field">
          <span>Branch or ticket name</span>
          <input
            id="branch-input"
            name="branch"
            type="text"
            placeholder="PROJ-1234-awesome-feature"
            value={branchInput}
            onChange={(event) => onBranchChange(event.target.value)}
            required
            disabled={createInFlight}
          />
        </label>
        <label className="field optional">
          <span>Base ref (optional)</span>
          <input
            id="base-input"
            name="base"
            type="text"
            placeholder="origin/develop"
            value={baseInput}
            onChange={(event) => onBaseChange(event.target.value)}
            disabled={createInFlight}
          />
        </label>
        <button id="create-button" className="primary-button" type="submit" disabled={createInFlight}>
          {createInFlight ? "Creating…" : "Create Workspace"}
        </button>
      </form>
      <p className="hint">
        New worktrees are created alongside your configured workspace root. Branch names are converted to folder friendly
        paths automatically.
      </p>
    </section>
  );
};
