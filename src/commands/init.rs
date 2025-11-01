use anyhow::{bail, Context, Result};
use serde_json::json;
use std::{fs, path::Path};

/// Create a `.wtm` scaffold within the provided root directory.
pub fn init_command(root: &Path) -> Result<()> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let wtm_dir = root.join(".wtm");
    if wtm_dir.exists() {
        bail!("A .wtm directory already exists at {}", wtm_dir.display());
    }

    fs::create_dir_all(wtm_dir.join("workspaces"))
        .with_context(|| format!("failed to create {}", wtm_dir.display()))?;

    let config = json!({
        "version": 1,
        "icon": "🤖",
        "quickAccess": [],
    });
    write_json_file(&wtm_dir.join("config.json"), &config)?;

    let terminals = json!({
        "workspaces": {}
    });
    write_json_file(&wtm_dir.join("terminals.json"), &terminals)?;

    let default_ws = root.join(".wtm/workspaces/default");
    fs::create_dir_all(&default_ws)
        .with_context(|| format!("failed to create {}", default_ws.display()))?;

    println!("Initialised .wtm workspace scaffold at {}", root.display());
    Ok(())
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<()> {
    let data = serde_json::to_string_pretty(value)?;
    fs::write(path, data).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}
