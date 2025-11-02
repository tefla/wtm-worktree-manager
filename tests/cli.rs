use assert_cmd::prelude::*;
use predicates::prelude::*;
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
fn worktree_list_outputs_primary() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    cmd.current_dir(temp.path()).args(["worktree", "list"]);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains(temp.path().to_string_lossy()));
    Ok(())
}

#[test]
fn worktree_add_and_remove_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    init_git_repo(temp.path())?;

    let branch_name = "feature/test";
    let expected_dir = temp
        .path()
        .join(".wtm/workspaces")
        .join(branch_dir_name(branch_name));

    let mut add = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    add.current_dir(temp.path())
        .args(["worktree", "add", branch_name]);
    add.assert().success();

    assert!(expected_dir.exists());

    let mut remove = Command::new(assert_cmd::cargo::cargo_bin!("wtm"));
    remove.current_dir(temp.path()).args([
        "worktree",
        "remove",
        expected_dir.file_name().unwrap().to_str().unwrap(),
        "--force",
    ]);
    remove.assert().success();
    assert!(!expected_dir.exists());
    Ok(())
}

#[test]
fn worktree_add_sanitizes_branch_name() -> Result<(), Box<dyn std::error::Error>> {
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
        .args(["worktree", "add", original_branch]);
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
