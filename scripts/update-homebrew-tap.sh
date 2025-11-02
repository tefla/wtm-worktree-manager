#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN must be set with a token that can push to the tap repository." >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#v}"
TAP_REPO="${TAP_REPO:-tefla/homebrew-wtm}"
TMP_ROOT="$(mktemp -d)"
DOWNLOAD_DIR="${TMP_ROOT}/downloads"
TAP_DIR="${TMP_ROOT}/tap"
mkdir -p "$DOWNLOAD_DIR"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

platforms=(
  "linux-x86_64"
  "macos-x86_64"
  "macos-arm64"
)

declare -A SHAS

for platform in "${platforms[@]}"; do
  asset="wtm-${VERSION}-${platform}.tar.gz.sha256"
  echo "Downloading checksum for $platform"
  gh release download "$TAG" \
    --repo tefla/wtm-worktree-manager \
    --pattern "$asset" \
    --dir "$DOWNLOAD_DIR" \
    --clobber >/dev/null

  asset_path="${DOWNLOAD_DIR}/${asset}"
  if [[ ! -f "$asset_path" ]]; then
    echo "Failed to download expected asset: $asset" >&2
    exit 1
  fi

  sha_value="$(awk '{print $1}' "$asset_path")"
  if [[ -z "$sha_value" ]]; then
    echo "Unable to parse SHA from $asset" >&2
    exit 1
  fi
  SHAS["$platform"]="$sha_value"
done

echo "Cloning tap repository ${TAP_REPO}"
git clone "https://x-access-token:${GH_TOKEN}@github.com/${TAP_REPO}.git" "$TAP_DIR"

cd "$TAP_DIR"

git fetch origin
if git show-ref --verify --quiet refs/remotes/origin/development; then
  git checkout -B development origin/development
else
  git checkout -b development origin/main
fi

mkdir -p Formula

cat <<EOF >Formula/wtm.rb
class Wtm < Formula
  desc "CLI and TUI tooling for managing Git worktrees from a unified workspace"
  homepage "https://github.com/tefla/wtm-worktree-manager"
  version "${VERSION}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/tefla/wtm-worktree-manager/releases/download/${TAG}/wtm-${VERSION}-macos-arm64.tar.gz"
      sha256 "${SHAS[macos-arm64]}"
    else
      url "https://github.com/tefla/wtm-worktree-manager/releases/download/${TAG}/wtm-${VERSION}-macos-x86_64.tar.gz"
      sha256 "${SHAS[macos-x86_64]}"
    end
  end

  on_linux do
    url "https://github.com/tefla/wtm-worktree-manager/releases/download/${TAG}/wtm-${VERSION}-linux-x86_64.tar.gz"
    sha256 "${SHAS[linux-x86_64]}"
  end

  def install
    bin.install "wtm"
  end

  test do
    output = shell_output("\#{bin}/wtm --version")
    assert_match version.to_s, output
  end
end
EOF

if git diff --quiet -- Formula/wtm.rb; then
  echo "Formula already up to date. No changes to push."
  exit 0
fi

git config user.name "${GIT_AUTHOR_NAME:-wtm-bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-wtm-bot@users.noreply.github.com}"

git add Formula/wtm.rb
git commit -m "Update wtm to ${VERSION}"
git push origin development

existing_pr="$(gh pr list --head development --base main --state open --json number --jq '.[0].number' 2>/dev/null || true)"
if [[ -z "${existing_pr}" ]]; then
  gh pr create \
    --head development \
    --base main \
    --title "Release ${VERSION}" \
    --body "Automated update for wtm ${VERSION}."
else
  echo "Open PR #${existing_pr} already exists."
fi
