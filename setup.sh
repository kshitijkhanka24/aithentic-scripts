#!/usr/bin/env bash
# setup.sh - Reordered and idempotent setup script for Aithentic
set -euo pipefail

### Configuration (override with env vars) ###
REPO_URL="${REPO_URL:-https://github.com/kshitijkhanka24/aithentic-scripts.git}"                # optional: git URL to clone if repo not present
PROJECT_DIR="${PROJECT_DIR:-/home/ec2-user/aithentic-scripts}"  # target project path on the instance
SCRIPTS_DIR="${SCRIPTS_DIR:-${PROJECT_DIR}/script}"
NODE_VERSION="${NODE_VERSION:-lts/*}"
AWS_REGION="${AWS_REGION:-us-east-1}"
LOGFILE="${LOGFILE:-/var/log/aithentic-startup.log}"

echo "=== Aithentic Assignment Processor - Setup Script ==="
echo "Project dir: ${PROJECT_DIR}"
echo "Scripts dir: ${SCRIPTS_DIR}"
echo "AWS region: ${AWS_REGION}"

command_exists() { command -v "$1" >/dev/null 2>&1; }

detect_package_manager() {
  if command_exists apt-get; then
    echo apt
  elif command_exists yum; then
    echo yum
  elif command_exists apk; then
    echo apk
  else
    echo unknown
  fi
}

PKG_MANAGER=$(detect_package_manager)
echo "Detected package manager: ${PKG_MANAGER}"

### 1) Update system packages (best-effort) ###
echo "[STEP 1] Updating system packages (best-effort)"
case "$PKG_MANAGER" in
  apt)
    sudo apt-get update -y || true
    ;;
  yum)
    sudo yum update -y || true
    ;;
  apk)
    sudo apk update || true
    ;;
  *)
    echo "[WARN] Unknown package manager; skipping automatic update."
    ;;
esac

### 2) Install nvm and Node (if needed) ###
echo "[STEP 2] Ensuring Node.js (via nvm)"
export NVM_DIR="${HOME}/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # already installed
  . "$NVM_DIR/nvm.sh"
else
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.4/install.sh | bash
  . "$NVM_DIR/nvm.sh"
fi

echo "Installing Node (${NODE_VERSION})"
nvm install --lts >/dev/null 2>&1 || nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION" >/dev/null 2>&1 || true

NODE_CMD="$(command -v node || true)"
if [ -z "$NODE_CMD" ]; then
  echo "[ERROR] node not available after nvm install. Aborting."
  exit 1
fi
echo "Node found: $NODE_CMD"

### 3) Ensure package manager (pnpm preferred) ###
echo "[STEP 3] Ensuring pnpm or npm is available"
if command_exists pnpm; then
  PNPM_CMD=pnpm
elif command_exists npm; then
  PNPM_CMD=npm
  echo "pnpm not found; will use npm"
else
  echo "npm not found; this should not happen after nvm install. Aborting."
  exit 1
fi

echo "Using package manager: ${PNPM_CMD}"

### 4) Install poppler-utils (pdftotext) for PDF conversion ###
echo "[STEP 4] Ensuring pdftotext (poppler-utils) is installed"
if ! command_exists pdftotext; then
  case "$PKG_MANAGER" in
    apt)
      sudo apt-get install -y poppler-utils || echo "[WARN] Failed to install poppler-utils via apt"
      ;;
    yum)
      sudo yum install -y poppler-utils || echo "[WARN] Failed to install poppler-utils via yum"
      ;;
    apk)
      sudo apk add --no-cache poppler-utils || echo "[WARN] Failed to install poppler-utils via apk"
      ;;
    *)
      echo "[WARN] Could not auto-install poppler-utils on this OS. Please install 'pdftotext' manually."
      ;;
  esac
else
  echo "pdftotext already installed"
fi

### 5) Clone repository if missing (optional) ###
if [ ! -d "$PROJECT_DIR" ]; then
  if [ -n "$REPO_URL" ]; then
    echo "[STEP 5] Cloning repository from ${REPO_URL} into ${PROJECT_DIR}"
    git clone "$REPO_URL" "$PROJECT_DIR"
  else
    echo "[WARN] Project directory ${PROJECT_DIR} not found and REPO_URL not provided. Please clone your repo to ${PROJECT_DIR} or set REPO_URL and re-run."
    exit 1
  fi
else
  echo "[STEP 5] Project directory exists: ${PROJECT_DIR}"
fi

### 6) Install project-level and per-package dependencies ###
echo "[STEP 6] Installing project dependencies"
cd "$PROJECT_DIR"
git pull || echo "[INFO] Could not pull latest changes; proceeding with existing code."

# Install at project root if package.json exists
if [ -f package.json ]; then
  echo "Installing root dependencies"
  if [ "$PNPM_CMD" = "pnpm" ]; then
    pnpm install --shamefully-hoist || npm install
  else
    npm install
  fi
fi

# Also install inside script/, backend/, frontend/ if they have package.json
for sub in script backend frontend; do
  if [ -f "$sub/package.json" ]; then
    echo "Installing dependencies in ${sub}"
    cd "$sub"
    if [ "$PNPM_CMD" = "pnpm" ]; then
      pnpm install --shamefully-hoist || npm install
    else
      npm install
    fi
    cd "$PROJECT_DIR"
  fi
done


# 4) Move to scripts folder and install Node dependencies
if [ ! -d "$SCRIPTS_DIR" ]; then
  echo "[ERROR] Scripts directory not found: $SCRIPTS_DIR"
  exit 1
fi

cd "$SCRIPTS_DIR"

echo "[INFO] Installing Node dependencies in ${SCRIPTS_DIR}..."
if [ "$PNPM_CMD" = "pnpm" ]; then
  # prefer pnpm if lockfile present
  if [ -f "pnpm-lock.yaml" ] || [ -f "../pnpm-lock.yaml" ]; then
    pnpm install --shamefully-hoist || { echo "[ERROR] pnpm install failed"; exit 1; }
  else
    # fallback to npm
    if command_exists npm; then
      npm install || { echo "[ERROR] npm install failed"; exit 1; }
      PNPM_CMD=npm
    fi
  fi
else
  # PNPM_CMD may be npm
  $PNPM_CMD install || { echo "[ERROR] $PNPM_CMD install failed"; exit 1; }
fi

# 5) Export AWS region if provided (useful inside systemd env)
export AWS_REGION="${AWS_REGION}"
echo "[INFO] AWS_REGION set to ${AWS_REGION}"

# 6) Run parts sequentially. Each step logs output and returns non-zero on failure.
TIMESTAMP() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

run_node_script() {
  local script_file="$1"
  echo "[$(TIMESTAMP)] Running ${script_file} ..."
  # Use node to run script; ensure working dir is project root so relative paths resolve
  cd "$PROJECT_DIR"
  if ! $NODE_CMD "$SCRIPTS_DIR/$script_file" ; then
    echo "[$(TIMESTAMP)] ERROR: ${script_file} failed."
    return 1
  fi
  echo "[$(TIMESTAMP)] Finished ${script_file}."
  return 0
}

# Recommended order: part1 -> part2 -> part3 -> part4 (terminate last)
if ! run_node_script "part1_S3PdfToText.js"; then
  echo "[ERROR] part1 failed. Aborting subsequent steps."
  exit 1
fi

if ! run_node_script "part2_Sagemaker.js"; then
  echo "[ERROR] part2 failed. Aborting subsequent steps."
  exit 1
fi

if ! run_node_script "part3_DynamoDb.js"; then
  echo "[ERROR] part3 failed. Aborting subsequent steps."
  exit 1
fi

# part4 may terminate the instance; only run if explicitly enabled
TERMINATE_ON_COMPLETE="${TERMINATE_ON_COMPLETE:-true}"
if [ "$TERMINATE_ON_COMPLETE" = "true" ] || [ "$TERMINATE_ON_COMPLETE" = "1" ]; then
  echo "[INFO] TERMINATE_ON_COMPLETE is true; running part4_Terminate.js (may stop instance)."
  run_node_script "part4_Terminate.js" || echo "[WARN] part4 returned non-zero (see logs)."
else
  echo "[INFO] TERMINATE_ON_COMPLETE is disabled; skipping part4."
fi

echo "=== Aithentic startup script completed: $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
exit 0