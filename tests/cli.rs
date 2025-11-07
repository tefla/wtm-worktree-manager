use assert_cmd::prelude::*;
use predicates::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

#[test]
fn init_creates_expected_structure() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path()).arg("init");
    cmd.assert().success().stdout(predicate::str::contains(
        "Initialised .wtm workspace scaffold",
    ));

    let wtm_dir = temp.path().join(".wtm");
    assert!(wtm_dir.is_dir());
    assert!(wtm_dir.join("workspaces").is_dir());

    let config: Value = read_json(&wtm_dir.join("config.json"))?;
    assert_eq!(config["version"], 1);
    assert!(config["quickAccess"].as_array().unwrap().is_empty());

    let terminals: Value = read_json(&wtm_dir.join("terminals.json"))?;
    assert!(terminals["workspaces"].as_object().unwrap().is_empty());

    Ok(())
}

#[test]
fn init_fails_when_directory_exists() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    let mut first = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    first
        .current_dir(temp.path())
        .arg("init")
        .assert()
        .success();

    let mut second = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    second.current_dir(temp.path()).arg("init");
    second
        .assert()
        .failure()
        .stderr(predicate::str::contains("already exists"));

    Ok(())
}

#[test]
fn running_without_wtm_directory_errors() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path());
    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("No .wtm directory found"));
    Ok(())
}

#[test]
fn running_with_empty_workspaces_errors() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    let wtm_dir = temp.path().join(".wtm/workspaces");
    fs::create_dir_all(&wtm_dir)?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path());
    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("git command failed"));
    Ok(())
}

#[test]
fn workspace_list_outputs_primary() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path()).args(["workspace", "list"]);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains(temp.path().to_string_lossy()));
    Ok(())
}

#[test]
fn workspace_create_and_delete_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let branch_name = "feature/test";
    let expected_dir = temp
        .path()
        .join(".wtm/workspaces")
        .join(branch_dir_name(branch_name));

    let mut add = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    add.current_dir(temp.path())
        .args(["workspace", "create", branch_name]);
    add.assert().success();

    assert!(expected_dir.exists());

    let mut remove = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    remove.current_dir(temp.path()).args([
        "workspace",
        "delete",
        "--path",
        expected_dir.file_name().unwrap().to_str().unwrap(),
        "--force",
    ]);
    remove.assert().success();
    assert!(!expected_dir.exists());
    Ok(())
}

#[test]
fn workspace_create_sanitizes_branch_name() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let original_branch = "feature branch";
    let sanitized_branch = "feature-branch";
    let expected_dir = temp
        .path()
        .join(".wtm/workspaces")
        .join(branch_dir_name(sanitized_branch));

    let mut add = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    add.current_dir(temp.path())
        .args(["workspace", "create", original_branch]);
    add.assert().success();

    assert!(expected_dir.exists());
    run_git(
        temp.path(),
        &[
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/feature-branch",
        ],
    )?;

    Ok(())
}

#[test]
fn workspace_telemetry_reports_status() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let branch_name = "feature/telemetry";
    let workspace_name = branch_dir_name(branch_name);
    let workspace_dir = temp.path().join(".wtm/workspaces").join(&workspace_name);

    let mut create = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    create
        .current_dir(temp.path())
        .args(["workspace", "create", branch_name]);
    create.assert().success();

    assert!(workspace_dir.exists());
    fs::write(workspace_dir.join("new_file.txt"), "hello telemetry")?;

    let mut telemetry = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    telemetry.current_dir(temp.path()).args([
        "workspace",
        "telemetry",
        "--path",
        workspace_name.as_str(),
        "--json",
    ]);
    let assertion = telemetry.assert().success();
    let stdout = String::from_utf8(assertion.get_output().stdout.clone())?;
    let payload: Value = serde_json::from_str(&stdout)?;
    let entries = payload
        .as_array()
        .ok_or_else(|| "expected telemetry array")?;
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];

    assert_eq!(entry["summary"]["branch"].as_str().unwrap(), branch_name);
    assert_eq!(
        entry["summary"]["path"].as_str().unwrap(),
        workspace_dir.to_string_lossy().as_ref()
    );
    assert!(entry["status_error"].is_null());
    assert!(entry["disk_usage_error"].is_null());
    assert_eq!(entry["status"]["untracked"].as_u64().unwrap(), 1);
    assert!(entry["disk_usage_bytes"].as_u64().unwrap() > 0);

    Ok(())
}

#[test]
fn completions_generate_outputs_bash_script() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path())
        .args(["completions", "generate", "bash"]);

    cmd.assert()
        .success()
        .stdout(predicate::str::contains("__wtm_branch_suggestions"));

    Ok(())
}

#[test]
fn completions_suggest_branches_includes_local_and_ticket() -> Result<(), Box<dyn std::error::Error>>
{
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    run_git(temp.path(), ["checkout", "-b", "feature/example"].as_ref())?;

    let wtm_dir = temp.path().join(".wtm");
    fs::create_dir_all(&wtm_dir)?;
    let cache = serde_json::json!({
        "tickets": [{
            "key": "PROJ-7",
            "summary": "Dynamic branch",
        }]
    });
    fs::write(
        wtm_dir.join("jira_cache.json"),
        serde_json::to_string(&cache)?,
    )?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path())
        .args(["completions", "suggest", "branches", "--json"]);

    let assertion = cmd.assert().success();
    let stdout = String::from_utf8(assertion.get_output().stdout.clone())?;
    let suggestions: Vec<CompletionSuggestionOutput> = serde_json::from_str(&stdout)?;

    let has_local = suggestions.iter().any(|suggestion| {
        suggestion.source.as_deref() == Some("local") && suggestion.value == "feature/example"
    });
    assert!(has_local, "expected local branch suggestion");

    let has_ticket = suggestions.iter().any(|suggestion| {
        suggestion.source.as_deref() == Some("ticket")
            && suggestion
                .description
                .as_deref()
                .unwrap_or_default()
                .contains("PROJ-7")
    });
    assert!(has_ticket, "expected ticket suggestion");

    let mut shell_cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    shell_cmd.current_dir(temp.path()).args([
        "completions",
        "suggest",
        "branches",
        "--shell",
        "bash",
    ]);
    shell_cmd
        .assert()
        .success()
        .stdout(predicate::str::contains("feature/example"))
        .stdout(predicate::str::contains("PROJ-7"));

    Ok(())
}

#[derive(Debug, Deserialize)]
struct CompletionSuggestionOutput {
    value: String,
    description: Option<String>,
    source: Option<String>,
}

fn read_json(path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let data = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&data)?)
}

fn init_git_repo(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    run_git(path, ["init"].as_ref())?;
    fs::write(path.join("README.md"), "hello")?;
    run_git(path, ["add", "."].as_ref())?;
    run_git_with_env(
        path,
        ["commit", "-m", "init"].as_ref(),
        [
            ("GIT_AUTHOR_NAME", "Test"),
            ("GIT_AUTHOR_EMAIL", "test@example.com"),
            ("GIT_COMMITTER_NAME", "Test"),
            ("GIT_COMMITTER_EMAIL", "test@example.com"),
        ],
    )?;
    Ok(())
}

fn branch_dir_name(branch: &str) -> String {
    let mut slug: String = branch
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => c,
            _ => '-',
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "worktree".to_string()
    } else {
        slug
    }
}

fn run_git(path: &Path, args: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
    run_git_with_env(path, args, [])
}

fn run_git_with_env(
    path: &Path,
    args: &[&str],
    envs: impl IntoIterator<Item = (&'static str, &'static str)>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut cmd = Command::new("git");
    cmd.current_dir(path).args(args);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {:?} failed with status {:?}", args, status).into())
    }
}
