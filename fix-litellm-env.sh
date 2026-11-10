#!/usr/bin/env bash
# fix-litellm-env.sh — build a clean, isolated environment for LiteLLM on Apple Silicon.
#
# Root cause being fixed:
#   pydantic-core / orjson / tiktoken / fastuuid are Rust extensions built with PyO3.
#   When pip can't find a prebuilt wheel for your exact Python version + arm64 (common
#   on very new or unusual Python builds), it falls back to compiling from source, and
#   the PyO3 version pinned by the package release may not yet support your Python's
#   C API -> the build fails. The fix is to (a) use a Python version that definitely
#   has prebuilt wheels for these packages, and (b) prefer wheels over source builds.
#
# Usage: bash fix-litellm-env.sh

set -euo pipefail

echo "=== NEXORA / LiteLLM environment fix ==="
echo "Architecture: $(uname -m)"
echo ""

# 1. Ensure Python 3.11 is available (broad wheel coverage for these packages)
if ! command -v python3.11 >/dev/null 2>&1; then
  echo "Python 3.11 not found."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing via Homebrew..."
    brew install python@3.11
  else
    echo "Homebrew is not installed. Install it first from https://brew.sh, then re-run this script."
    exit 1
  fi
fi

PY311="$(command -v python3.11)"
echo "Using Python: $PY311"
"$PY311" --version
echo ""

# 2. Create a dedicated, disposable venv for LiteLLM
VENV_DIR="$HOME/.nexora/venvs/litellm"
mkdir -p "$(dirname "$VENV_DIR")"
if [ -d "$VENV_DIR" ]; then
  echo "Removing existing venv at $VENV_DIR"
  rm -rf "$VENV_DIR"
fi
"$PY311" -m venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
echo "Venv created and activated: $VENV_DIR"
echo ""

# 3. Upgrade packaging tools — outdated pip/setuptools is a common reason wheels get skipped
pip install --upgrade pip setuptools wheel

# 4. Try wheel-only install first (never touches Rust/compilers)
echo ""
echo "Installing litellm[proxy] using prebuilt wheels only..."
if pip install --only-binary=:all: "litellm[proxy]"; then
  echo "litellm[proxy] installed successfully from prebuilt wheels."
else
  echo ""
  echo "No prebuilt wheel for one of the dependencies on this Python/arch."
  echo "Falling back to a normal install (will compile Rust extensions if needed)..."
  if ! command -v rustc >/dev/null 2>&1; then
    echo "Installing the Rust toolchain via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  pip install "litellm[proxy]"
fi

# 5. Verify
echo ""
echo "=== Verification ==="
python -c "import litellm; print('litellm version:', litellm.__version__)"
litellm --version || true

echo ""
echo "Done. Dedicated venv: $VENV_DIR"
echo "Activate it in any new shell with:"
echo "    source $VENV_DIR/bin/activate"
echo "Launch the proxy with:"
echo "    litellm --config /path/to/your/litellm_config.yaml --port 4000 &"
