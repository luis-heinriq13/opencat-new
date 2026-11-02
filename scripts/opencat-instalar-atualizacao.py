#!/usr/bin/env python3
"""Instala a build local do OpenCat preparada por scripts/opencat-preparar-atualizacao.sh.

Roda desacoplado do app (o app fecha logo depois de iniciar este script). Faz copia dos dados,
troca o app, reabre e confere a saude. Se o app novo nao abrir ou se faltarem agentes, volta ao app
anterior. Se a saude nao puder ser determinada, mantem o app novo e so registra no log.

Marcadores: durante a instalacao o app novo NAO pode oferecer a mesma atualizacao de novo. Por isso,
antes de abrir o app novo, o instalador grava installed.json e move pending.json para
pending.instalando.json (alem da trava instalacao.lock). Num rollback os dois voltam ao que eram.
Toda recusa depois que o app pode ter fechado reabre o app.

Uso: python3 -I opencat-instalar-atualizacao.py --commit <commit> [--atual /Applications/OpenCat.app] [--wait-pid N]
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

HOME = pathlib.Path.home()
UPDATES = HOME / "OpenCat-updates"
DATA = HOME / "Library/Application Support/OpenBot"
FONTE = HOME / "Downloads/openbot/dist/mac-arm64/OpenBot.app"
BUNDLE_ID = "app.openbot.desktop"
AUTO = DATA / "automation"
LOG = UPDATES / "instalacao.log"
LOCK = UPDATES / "instalacao.lock"
PENDING = UPDATES / "pending.json"
EM_ANDAMENTO = UPDATES / "pending.instalando.json"
INSTALLED = UPDATES / "installed.json"
COMMIT_RE = re.compile(r"^[0-9a-f]{40}(-dirty-[0-9a-f]{8})?$")
HEALTH_ROUNDS = 90  # 90 x 10 s = 15 min: o Mac pode estar esperando a senha do usuario.

ATUAL = pathlib.Path("/Applications/OpenCat.app")
ANTERIOR = None
COPIA = None
PREPARADO = None
TROCADO = False
MARCADO = False
INSTALADO_ANTERIOR = None
OUTRA_INSTALACAO = False


def log(text):
    try:
        fd = os.open(LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except OSError:
        pass


def run(*cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        log(f"comando falhou ({result.returncode}): {' '.join(cmd)} {detail[-500:]}")
    return result


def escrever_json(path, data):
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def team_id(app):
    out = run("codesign", "-dv", "--verbose=2", str(app))
    match = re.search(r"TeamIdentifier=(\S+)", out.stderr + out.stdout)
    return match.group(1) if match and match.group(1) != "not" else None


def assinatura_ok(app):
    return run("codesign", "--verify", "--deep", "--strict", str(app)).returncode == 0


def rodando():
    return bool(run("lsof", "-nP", str(DATA / "openbot.db")).stdout.strip())


def app_rodando(app):
    """Confirma o processo principal do bundle exato, não só qualquer processo que abra o banco."""
    executavel = app / "Contents" / "MacOS" / "OpenBot"
    return subprocess.run(("pgrep", "-f", str(executavel)), capture_output=True, text=True).returncode == 0


def copiar_app(origem, destino):
    """Copia um bundle assinado sem transformar o destino em app registrado pelo LaunchServices."""
    return run("ditto", str(origem), str(destino)).returncode == 0


def limpar_conteudo_app(app):
    """Preserva o inode de /Applications/OpenCat.app, que é o alvo do ícone fixado no Dock."""
    try:
        for entrada in app.iterdir():
            if entrada.is_dir() and not entrada.is_symlink():
                shutil.rmtree(entrada)
            else:
                entrada.unlink()
    except OSError as error:
        log(f"nao consegui limpar o conteudo do app: {error}")
        return False
    return True


def instalar_no_mesmo_bundle(origem, destino):
    """Atualiza o conteúdo no bundle canônico sem mover sua pasta raiz para uma cópia."""
    if not limpar_conteudo_app(destino):
        return False
    return copiar_app(origem, destino) and assinatura_ok(destino)


def pid_vivo(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def fechar(wait_pid):
    if wait_pid:
        for _ in range(90):
            if not pid_vivo(wait_pid):
                break
            time.sleep(2)
    if rodando():
        run("osascript", "-e", f'quit app id "{BUNDLE_ID}"')
    for _ in range(90):
        if not rodando():
            return True
        time.sleep(2)
    return False


def contar_agentes_db():
    """Leitura somente-leitura. Retorna None se nao der para ler."""
    try:
        con = sqlite3.connect(f"file:{DATA / 'openbot.db'}?mode=ro", uri=True, timeout=5)
        try:
            return con.execute("select count(*) from projection_agents").fetchone()[0]
        finally:
            con.close()
    except Exception as error:
        log(f"nao consegui contar agentes no banco: {error}")
        return None


def contar_agentes_api():
    """So se a API de automacao existir. Retorna None se nao der para ler."""
    try:
        url = (AUTO / "url").read_text().strip() + "/v1/agents"
        req = urllib.request.Request(url)
        for line in (AUTO / "headers").read_text().splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                req.add_header(k.strip(), v.strip())
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
        return len(data if isinstance(data, list) else data.get("agents", []))
    except Exception:
        return None


def escrever_bytes(path, data):
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def dados_instalado(manifest, confirmado, em_andamento):
    dados = {
        "commit": manifest["commit"],
        "version": manifest.get("version"),
        "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "backup": str(COPIA),
        "healthConfirmed": confirmado,
    }
    if isinstance(manifest.get("build"), dict):
        dados["build"] = manifest["build"]
    if em_andamento:
        dados["installing"] = True
    return dados


def marcar_em_andamento(manifest):
    """Antes de abrir o app novo: installed.json ja diz que este commit esta instalado e pending.json sai do caminho."""
    global MARCADO, INSTALADO_ANTERIOR
    try:
        INSTALADO_ANTERIOR = INSTALLED.read_bytes()
    except OSError:
        INSTALADO_ANTERIOR = None
    MARCADO = True
    escrever_json(INSTALLED, dados_instalado(manifest, False, True))
    os.replace(PENDING, EM_ANDAMENTO)


def desmarcar_em_andamento():
    """Rollback: pending.json e installed.json voltam ao que eram antes da instalacao."""
    global MARCADO
    if not MARCADO:
        return
    MARCADO = False
    try:
        if EM_ANDAMENTO.exists():
            os.replace(EM_ANDAMENTO, PENDING)
    except OSError as error:
        log(f"nao consegui devolver pending.json: {error}")
    try:
        if INSTALADO_ANTERIOR is None:
            INSTALLED.unlink(missing_ok=True)
        else:
            escrever_bytes(INSTALLED, INSTALADO_ANTERIOR)
    except OSError as error:
        log(f"nao consegui restaurar installed.json: {error}")


def reabrir_se_fechado(args):
    """Recusa depois que o app pode ter fechado: espera o app sair e, se nada o reabriu, abre de novo."""
    alvo = pathlib.Path(args.atual)
    try:
        if alvo.suffix != ".app" or not alvo.is_dir() or alvo.is_symlink() or alvo.resolve() == FONTE.resolve():
            return
    except OSError:
        return
    if args.wait_pid:
        for _ in range(90):
            if not pid_vivo(args.wait_pid):
                break
            time.sleep(2)
    if not rodando():
        log("o app esta fechado depois da recusa; reabrindo")
        run("open", str(alvo))


def reabrir_apos_interrupcao():
    if ATUAL.is_dir() and not rodando():
        run("open", str(ATUAL))


def interromper(signum, _frame):
    log("interrompido; reabrindo o app")
    if not TROCADO:
        reabrir_apos_interrupcao()
    else:
        try:
            EM_ANDAMENTO.unlink(missing_ok=True)
        except OSError:
            pass
    raise SystemExit(128 + signum)


def tomar_trava():
    for _ in range(2):
        try:
            fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                if pid_vivo(int(LOCK.read_text().strip())):
                    return False
            except (OSError, ValueError):
                pass
            try:
                LOCK.unlink()
            except OSError:
                pass
    return False


def voltar(dados_ruins, wait_pid):
    desmarcar_em_andamento()
    log("voltando ao app anterior" + (" e aos dados anteriores" if dados_ruins else ""))
    fechar(None)
    if ATUAL.exists() and COPIA is not None:
        copiar_app(ATUAL, COPIA / "OpenCat-falhou.bundle")
    if dados_ruins:
        shutil.move(str(DATA), str(COPIA / "dados-apos-falha"))
        run("cp", "-c", "-R", str(COPIA / "dados-OpenBot"), str(DATA))
    if ANTERIOR is None or not instalar_no_mesmo_bundle(ANTERIOR, ATUAL):
        log("nao consegui restaurar o app anterior no bundle canonico")
        return
    run("open", str(ATUAL))


def main():
    global ATUAL, ANTERIOR, COPIA, PREPARADO, TROCADO
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True)
    parser.add_argument("--atual", default=str(ATUAL))
    parser.add_argument("--wait-pid", type=int, default=0)
    args = parser.parse_args()

    try:
        codigo = executar(args)
    except Exception:
        codigo = 1  # ja registrado em executar()
    if codigo != 0 and not OUTRA_INSTALACAO:
        try:
            reabrir_se_fechado(args)
        except Exception as error:
            log(f"nao consegui reabrir o app: {error}")
    return codigo


def executar(args):
    global ATUAL, OUTRA_INSTALACAO
    UPDATES.mkdir(mode=0o700, exist_ok=True)
    os.chmod(UPDATES, 0o700)
    if not COMMIT_RE.match(args.commit):
        log("commit invalido; nada foi alterado")
        return 1
    ATUAL = pathlib.Path(args.atual)
    if ATUAL.suffix != ".app" or not ATUAL.is_dir() or ATUAL.is_symlink() or ATUAL.resolve() == FONTE.resolve():
        log(f"app atual invalido: {ATUAL}; nada foi alterado")
        return 1
    if not tomar_trava():
        # A outra instalacao e dona do app: reabrir aqui atrapalharia a troca dela.
        OUTRA_INSTALACAO = True
        log("ja existe uma instalacao em andamento; nada foi alterado")
        return 1
    signal.signal(signal.SIGINT, interromper)
    signal.signal(signal.SIGTERM, interromper)
    try:
        return instalar(args)
    except BaseException as error:
        log(f"erro inesperado: {error!r}")
        if TROCADO and ANTERIOR is not None and ANTERIOR.is_dir():
            voltar(False, None)
        raise
    finally:
        try:
            LOCK.unlink()
        except OSError:
            pass


def instalar(args):
    global ANTERIOR, COPIA, PREPARADO, TROCADO
    log(f"inicio: commit {args.commit}")
    pending = PENDING
    try:
        manifest = json.loads(pending.read_text())
    except (OSError, ValueError):
        log("pending.json ilegivel; nada foi alterado")
        return 1
    if manifest.get("commit") != args.commit or manifest.get("appPath") != str(FONTE):
        log("pending.json nao confere com o pedido; nada foi alterado")
        return 1
    if FONTE.is_symlink() or not FONTE.is_dir() or not assinatura_ok(FONTE):
        log("build preparada invalida; nada foi alterado")
        return 1
    novo_time, atual_time = team_id(FONTE), team_id(ATUAL)
    if novo_time != atual_time:
        log(f"Team ID diferente (novo={novo_time}, atual={atual_time}); nada foi alterado")
        return 1

    # Linha de base lida ANTES de fechar o app.
    base_db = contar_agentes_db()
    base_api = contar_agentes_api()
    log(f"agentes antes: banco={base_db} api={base_api}")

    PREPARADO = ATUAL.parent / ".OpenCat-preparado.app"
    shutil.rmtree(PREPARADO, ignore_errors=True)
    if run("ditto", str(FONTE), str(PREPARADO)).returncode or not assinatura_ok(PREPARADO):
        log("preparo da instalacao falhou; nada foi alterado")
        shutil.rmtree(PREPARADO, ignore_errors=True)
        return 1

    if not fechar(args.wait_pid):
        log("o app nao fechou; nada foi alterado")
        shutil.rmtree(PREPARADO, ignore_errors=True)
        return 1

    COPIA = UPDATES / "copias" / time.strftime("%Y%m%d-%H%M%S")
    COPIA.mkdir(parents=True, mode=0o700)
    # Uma cópia com sufixo .app é registrada pelo macOS. Quando o instalador movia o
    # bundle de /Applications para ela, o ícone já fixado no Dock continuava apontando
    # para essa cópia antiga. .bundle mantém a recuperação sem virar outro OpenCat.
    ANTERIOR = COPIA / "OpenCat-anterior.bundle"
    if run("cp", "-c", "-R", str(DATA), str(COPIA / "dados-OpenBot")).returncode:
        log("copia dos dados falhou; nada foi alterado")
        shutil.rmtree(PREPARADO, ignore_errors=True)
        run("open", str(ATUAL))
        return 1
    log(f"copia dos dados pronta: {COPIA}")

    if not copiar_app(ATUAL, ANTERIOR):
        log("copia do app anterior falhou; nada foi alterado")
        shutil.rmtree(PREPARADO, ignore_errors=True)
        run("open", str(ATUAL))
        return 1
    if not instalar_no_mesmo_bundle(PREPARADO, ATUAL):
        log("troca no bundle canonico falhou; restaurando o app anterior")
        instalar_no_mesmo_bundle(ANTERIOR, ATUAL)
        shutil.rmtree(PREPARADO, ignore_errors=True)
        run("open", str(ATUAL))
        return 1
    shutil.rmtree(PREPARADO, ignore_errors=True)
    TROCADO = True
    try:
        marcar_em_andamento(manifest)
    except OSError as error:
        log(f"nao consegui marcar a instalacao em andamento: {error}")
        voltar(False, None)
        return 1
    run("open", str(ATUAL))

    veredito = "indeterminado"
    dados_ruins = False
    for _ in range(HEALTH_ROUNDS):
        time.sleep(10)
        api = contar_agentes_api()
        if api is None:
            continue
        banco = contar_agentes_db()
        novo_app = app_rodando(ATUAL)
        if novo_app and base_api is not None and api >= base_api:
            veredito = "ok"
        elif novo_app and base_api is None and (base_db is None or (banco is not None and banco >= base_db)):
            veredito = "ok"
        if veredito == "ok":
            break
    if veredito != "ok":
        banco = contar_agentes_db()
        if base_db is not None and banco is not None and banco < base_db:
            veredito, dados_ruins = "ruim", True
            log(f"faltam agentes no banco: antes={base_db} agora={banco}")
        elif not app_rodando(ATUAL):
            veredito = "ruim"
            log("o app novo nao esta rodando no bundle canonico")
    if veredito == "ruim":
        voltar(dados_ruins, None)
        log(f"FALHOU: voltei ao app anterior. Copia em {COPIA}")
        return 1
    if veredito == "indeterminado":
        log("saude nao pode ser confirmada (sem API de automacao); mantendo o app novo")
    else:
        log("OK: app novo abriu com os agentes")

    escrever_json(INSTALLED, dados_instalado(manifest, veredito == "ok", False))
    try:
        EM_ANDAMENTO.unlink(missing_ok=True)
    except OSError:
        pass
    log(f"concluido. Copia de seguranca em {COPIA}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
