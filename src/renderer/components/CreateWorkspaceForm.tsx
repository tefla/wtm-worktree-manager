import React, { FormEvent } from "react";

export interface CreateWorkspaceFormProps {
  branchInput: string;
  baseInput: string;
  createInFlight: boolean;
  disabled?: boolean;
  onBranchChange: (value: string) => void;
  onBaseChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  variant?: "panel" | "inline";
}

export const CreateWorkspaceForm: React.FC<CreateWorkspaceFormProps> = ({
  branchInput,
  baseInput,
  createInFlight,
  disabled = false,
  onBranchChange,
  onBaseChange,
  onSubmit,
  variant = "panel",
}) => {
  const inputsDisabled = createInFlight || disabled;
  const inline = variant === "inline";
  const formClassName = `create-form${inline ? " create-form--inline" : ""}`;
  const fieldClassName = `field${inline ? " field--inline" : ""}`;
  const optionalFieldClassName = `field optional${inline ? " field--inline" : ""}`;
  const labelClassName = inline ? "field-label sr-only" : "field-label";

  const form = (
    <form id="create-form" className={formClassName} autoComplete="off" onSubmit={onSubmit}>
      <label className={fieldClassName}>
        <span className={labelClassName}>Branch or ticket name</span>
        <input
          id="branch-input"
          name="branch"
          type="text"
          placeholder="PROJ-1234-awesome-feature"
          value={branchInput}
          onChange={(event) => onBranchChange(event.target.value)}
          required
          disabled={inputsDisabled}
          aria-label={inline ? "Branch or ticket name" : undefined}
        />
      </label>
      <label className={optionalFieldClassName}>
        <span className={labelClassName}>Base ref (optional)</span>
        <input
          id="base-input"
          name="base"
          type="text"
          placeholder="current repo branch"
          value={baseInput}
          onChange={(event) => onBaseChange(event.target.value)}
          disabled={inputsDisabled}
          aria-label={inline ? "Base ref" : undefined}
        />
      </label>
      <button id="create-button" className="primary-button" type="submit" disabled={inputsDisabled}>
        {createInFlight ? "Creating…" : "Create Workspace"}
      </button>
    </form>
  );

  if (inline) {
    return form;
  }

  return (
    <section className="create-section">
      {form}
      <p className="hint">
        New worktrees are created alongside your configured workspace root. Branch names are converted to folder friendly
        paths automatically.
      </p>
    </section>
  );
};
