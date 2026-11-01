#!/bin/bash
# Analise somente-leitura de uma versao oficial nova do OpenBot.
# So roda `git fetch origin --tags` (nada mais muda no repositorio). Nao faz merge, build nem instalacao.
set -u
umask 077

REPO="${OPENCAT_REPO:-$HOME/Downloads/openbot}"
UPDATES="${OPENCAT_UPDATES_DIR:-$HOME/OpenCat-updates}"
UPSTREAM_REPO="${OPENCAT_UPSTREAM_REPO:-nightly-labs/openbot}"
ANALISADO="$UPDATES/openbot-analisado.txt"

cd "$REPO" || { echo "repositorio nao encontrado: $REPO" >&2; exit 2; }
mkdir -p "$UPDATES" && chmod 700 "$UPDATES" || exit 2

if ! git fetch origin --tags --quiet; then
  echo "git fetch falhou (sem rede?). Nada foi analisado." >&2
  exit 3
fi

tag="$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"
if [ -z "$tag" ]; then
  echo "Nenhuma tag oficial encontrada." >&2
  exit 3
fi
ultimo=""
[ -f "$ANALISADO" ] && ultimo="$(tail -n 1 "$ANALISADO" | tr -d '[:space:]')"
if [ "$ultimo" = "$tag" ]; then
  echo "Nada novo: $tag ja foi analisada."
  exit 0
fi

notes=""
if command -v gh >/dev/null 2>&1; then
  notes="$(gh release view "$tag" --repo "$UPSTREAM_REPO" --json name,publishedAt,body \
    --jq '"**" + .name + "** (" + .publishedAt + ")\n\n" + .body' 2>/dev/null || true)"
fi

OPENCAT_TAG="$tag" OPENCAT_LAST="$ultimo" OPENCAT_NOTES="$notes" OPENCAT_REPO="$REPO" \
OPENCAT_UPDATES_DIR="$UPDATES" exec python3 -I - <<'PY'
import collections, os, subprocess, tempfile, time

repo, updates, tag = os.environ["OPENCAT_REPO"], os.environ["OPENCAT_UPDATES_DIR"], os.environ["OPENCAT_TAG"]
last, notes = os.environ["OPENCAT_LAST"], os.environ["OPENCAT_NOTES"].strip()

def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True).stdout

merge_base = git("merge-base", "HEAD", tag).strip()
has_last = bool(last) and bool(git("rev-parse", "--verify", "--quiet", last + "^{commit}").strip())
range_start = last if has_last else merge_base
rng = f"{range_start}..{tag}" if range_start else tag

def area(path):
    parts = path.split("/")
    if parts[0] in ("packages", "apps", "remote") and len(parts) > 1:
        return "/".join(parts[:2])
    if parts[0] == "src" and len(parts) > 1:
        return "/".join(parts[:2])
    return parts[0]

commits = []
current = None
for line in git("log", "--no-merges", "--name-only", "--format=@@%h%x09%s", rng).splitlines():
    if line.startswith("@@"):
        sha, subject = line[2:].split("\t", 1)
        current = {"sha": sha, "subject": subject, "areas": collections.Counter()}
        commits.append(current)
    elif line.strip() and current is not None:
        current["areas"][area(line.strip())] += 1

groups = collections.defaultdict(list)
for commit in commits:
    main_area = commit["areas"].most_common(1)[0][0] if commit["areas"] else "(sem arquivos)"
    groups[main_area].append(commit)

fork_files = set(git("diff", "--name-only", f"{merge_base}..HEAD").splitlines())
for line in git("status", "--porcelain").splitlines():
    fork_files.add(line[3:].split(" -> ")[-1].strip())
upstream_files = set(git("diff", "--name-only", f"{merge_base}..{tag}").splitlines())
overlap = sorted(fork_files & upstream_files)

out = [f"# Analise do OpenBot {tag}", ""]
out.append(f"Gerado em {time.strftime('%Y-%m-%d %H:%M')}. Somente leitura: nada foi mesclado, compilado ou instalado.")
out.append(f"Comparacao: `{range_start[:12] if range_start else '(inicio)'}..{tag}` ({len(commits)} commits sem merges).")
if not commits:
    out.append("Nenhum commit novo neste intervalo: o nosso fork ja contem esta versao.")
out += ["", "## Notas da versao", "", notes or "Indisponiveis (sem `gh` ou sem acesso). Veja a pagina de releases.", ""]
out += ["## Arquivos que tambem mudamos (provaveis conflitos)", ""]
out += [f"- `{path}`" for path in overlap] or ["Nenhum."]
out += ["", "## Commits por area", "", "Para cada item, escreva `trazer` ou `ignorar` depois de `decisao:`.", ""]
for name in sorted(groups, key=lambda key: (-len(groups[key]), key)):
    out += [f"### {name} ({len(groups[name])})", ""]
    for commit in groups[name]:
        out.append(f"- `{commit['sha']}` {commit['subject']} — decisão: ")
    out.append("")
text = "\n".join(out)

target = os.path.join(updates, f"openbot-{tag}.md")
fd, tmp = tempfile.mkstemp(prefix=".analise-", dir=updates)
with os.fdopen(fd, "w") as f:
    f.write(text)
os.chmod(tmp, 0o600)
os.replace(tmp, target)
with open(os.path.join(updates, "openbot-analisado.txt"), "a") as f:
    f.write(tag + "\n")
os.chmod(os.path.join(updates, "openbot-analisado.txt"), 0o600)
print(f"Analise escrita em {target}")
print(f"{len(commits)} commits, {len(overlap)} arquivos em comum com o nosso fork.")
PY
