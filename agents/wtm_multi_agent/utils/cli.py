"""Helper utilities for calling external CLIs."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Iterable, Mapping, Optional


class CLIError(RuntimeError):
    """Exception raised when a subprocess exits with a non-zero code."""

    def __init__(self, command: Iterable[str], exit_code: int, stdout: str, stderr: str) -> None:
        self.command = list(command)
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        message = "Command failed" if exit_code else "Command succeeded"
        super().__init__(
            f"{message}: {' '.join(self.command)} (exit code {exit_code})\n"
            f"stdout:\n{stdout}\n"
            f"stderr:\n{stderr}"
        )


def run(command: Iterable[str], cwd: Optional[Path] = None, env: Optional[Mapping[str, str]] = None) -> str:
    """Execute a command and return stdout, raising on failure."""

    result = subprocess.run(
        list(command),
        cwd=str(cwd) if cwd else None,
        env=env,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise CLIError(command, result.returncode, result.stdout, result.stderr)
    return result.stdout.strip()


def run_json(command: Iterable[str], cwd: Optional[Path] = None, env: Optional[Mapping[str, str]] = None):
    """Execute a command and parse JSON from stdout."""

    output = run(command, cwd=cwd, env=env)
    return json.loads(output) if output else None
