#!/bin/bash
# Gera o OpenCat (nossa build) e publica ~/OpenCat-updates/pending.json.
# Nao instala nada. A instalacao so acontece quando o usuario clica em "Atualizar" no app.
set -u
umask 077

REPO="${OPENCAT_REPO:-$HOME/Downloads/openbot}"
UPDATES="${OPENCAT_UPDATES_DIR:-$HOME/OpenCat-updates}"
GERAR="${OPENCAT_GERAR_APP:-$HOME/OpenBot/Agents/agent-420b547f-14a8-4c2f-a0b9-022a70e61755/scripts/gerar-app.sh}"
APP="$REPO/dist/mac-arm64/OpenBot.app"

# Caminhos que o gerar-app.sh restaura com `git checkout --` depois da build.
# Edicoes nao commitadas aqui seriam descartadas.
RESET_PATHS=(
  packages/i18n
  packages/ui/src/features/account
  src/renderer/src/features/onboarding/SetupReadError.tsx
  src/renderer/index.html
  src/renderer/helper.html
  src/renderer/browser-pip.html
  src/main/browser-picture-in-picture.ts
  src/main/index.ts
  src/main/loopback-callback-server.ts
  packages/ui/src/features/settings/stores/updates-store.ts
  src/renderer/src/platform.tsx
)

cd "$REPO" || { echo "repositorio nao encontrado: $REPO" >&2; exit 2; }

dirty="$(git status --porcelain --untracked-files=no -- "${RESET_PATHS[@]}")"
if [ -n "$dirty" ]; then
  echo "RECUSADO: ha edicoes nao commitadas em caminhos que o gerar-app.sh restaura (elas seriam perdidas):" >&2
  echo "$dirty" >&2
  echo "Faca commit ou guarde essas edicoes e rode de novo." >&2
  exit 3
fi
if [ ! -f "$GERAR" ]; then
  echo "gerar-app.sh nao encontrado: $GERAR" >&2
  exit 2
fi

mkdir -p "$UPDATES" && chmod 700 "$UPDATES" || exit 2

# Estado do codigo antes da build: o gerar-app.sh nao muda o HEAD.
commit="$(git rev-parse HEAD)"
diff_hash=""
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  diff_hash="$( (git diff HEAD) | shasum -a 256 | cut -c1-8)"
fi

if ! zsh "$GERAR"; then
  echo "A build falhou. Nada foi publicado." >&2
  exit 4
fi

if [ ! -d "$APP" ] || ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "A assinatura do app gerado e invalida. Nada foi publicado." >&2
  exit 5
fi

OPENCAT_COMMIT="$commit" OPENCAT_DIFF_HASH="$diff_hash" OPENCAT_APP="$APP" \
OPENCAT_UPDATES_DIR="$UPDATES" OPENCAT_REPO="$REPO" exec python3 -I - <<'PY'
import json, os, plistlib, subprocess, sys, tempfile, time

repo, updates, app = os.environ["OPENCAT_REPO"], os.environ["OPENCAT_UPDATES_DIR"], os.environ["OPENCAT_APP"]
commit, diff_hash = os.environ["OPENCAT_COMMIT"], os.environ["OPENCAT_DIFF_HASH"]

def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)

installed = None
try:
    with open(os.path.join(updates, "installed.json")) as f:
        installed = json.load(f).get("commit")
except (OSError, ValueError, AttributeError):
    pass
base = installed.split("-dirty-")[0] if isinstance(installed, str) else None
if base and git("cat-file", "-e", base + "^{commit}").returncode == 0:
    log = git("log", "--format=%s", f"{base}..{commit}")
else:
    log = git("log", "-n", "20", "--format=%s", commit)
changes = [line.strip()[:200] for line in log.stdout.splitlines() if line.strip()][:50]
if diff_hash:
    changes.insert(0, "Alteracoes ainda nao commitadas no codigo")
if not changes:
    changes = ["Sem commits novos desde a ultima instalacao"]

with open(os.path.join(app, "Contents/Info.plist"), "rb") as f:
    version = plistlib.load(f)["CFBundleShortVersionString"]

manifest = {
    "schema": 1,
    "commit": commit + (f"-dirty-{diff_hash}" if diff_hash else ""),
    "version": version,
    "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "appPath": app,
    "changes": changes,
}
fd, tmp = tempfile.mkstemp(prefix=".pending-", suffix=".tmp", dir=updates)
try:
    with os.fdopen(fd, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, os.path.join(updates, "pending.json"))
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
print("Atualizacao pronta em", os.path.join(updates, "pending.json"))
print("O OpenCat vai mostrar o botao Atualizar em ate 15 minutos.")
PY
