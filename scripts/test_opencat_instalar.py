"""Testes do instalador. Rodam so em pastas temporarias: nada toca ~/OpenCat-updates nem o app real.

    python3 -m unittest scripts/test_opencat_instalar.py
"""
import importlib.util
import json
import pathlib
import shutil
import tempfile
import types
import unittest

SCRIPT = pathlib.Path(__file__).with_name("opencat-instalar-atualizacao.py")
COMMIT = "a" * 40
ANTIGO = "b" * 40


def carregar():
    spec = importlib.util.spec_from_file_location("instalador", SCRIPT)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


class Base(unittest.TestCase):
    def setUp(self):
        self.raiz = pathlib.Path(tempfile.mkdtemp(prefix="opencat-instalar-"))
        self.addCleanup(shutil.rmtree, self.raiz, True)
        self.m = m = carregar()
        m.UPDATES = self.raiz / "updates"
        m.DATA = self.raiz / "dados"
        m.FONTE = self.raiz / "dist" / "OpenBot.app"
        m.AUTO = m.DATA / "automation"
        m.LOG = m.UPDATES / "instalacao.log"
        m.LOCK = m.UPDATES / "instalacao.lock"
        m.PENDING = m.UPDATES / "pending.json"
        m.EM_ANDAMENTO = m.UPDATES / "pending.instalando.json"
        m.INSTALLED = m.UPDATES / "installed.json"
        m.ATUAL = self.raiz / "apps" / "OpenCat.app"
        for pasta in (m.UPDATES, m.DATA, m.FONTE, m.ATUAL):
            pasta.mkdir(parents=True)
        (m.FONTE / "novo.txt").write_text("novo")
        (m.ATUAL / "antigo.txt").write_text("antigo")
        self.pending = {
            "schema": 1,
            "commit": COMMIT,
            "version": "0.57.0",
            "builtAt": "2026-11-01T10:00:00Z",
            "appPath": str(m.FONTE),
            "changes": ["Algo novo"],
            "build": {"number": 2841, "commit": "aaaaaaa"},
        }
        m.PENDING.write_text(json.dumps(self.pending))
        self.abriu = []
        self.estado_na_abertura = []
        self.aberto = False
        m.assinatura_ok = lambda app: True
        m.team_id = lambda app: "TEAM"
        m.time.sleep = lambda _s: None
        m.pid_vivo = lambda pid: False
        m.rodando = lambda: self.aberto
        m.run = self.falso_run

    def falso_run(self, *cmd):
        m = self.m
        if cmd[0] == "ditto":
            shutil.copytree(cmd[1], cmd[2])
        elif cmd[0] == "open":
            self.abriu.append(cmd[1])
            self.estado_na_abertura.append(
                {
                    "pending": m.PENDING.exists(),
                    "andamento": m.EM_ANDAMENTO.exists(),
                    "installed": json.loads(m.INSTALLED.read_text()) if m.INSTALLED.exists() else None,
                }
            )
            self.aberto = self.abrir_funciona
        elif cmd[0] == "cp":
            pathlib.Path(cmd[-1]).mkdir(parents=True, exist_ok=True)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    abrir_funciona = True

    def rodar(self, commit=COMMIT, wait_pid=0):
        args = types.SimpleNamespace(commit=commit, atual=str(self.m.ATUAL), wait_pid=wait_pid)
        self.m.argparse.ArgumentParser.parse_args = lambda _self: args
        return self.m.main()


class InstalarTest(Base):
    def test_marca_antes_de_abrir_e_conclui(self):
        self.aberto = False
        self.assertEqual(self.rodar(), 0)
        antes_de_abrir = self.estado_na_abertura[0]
        self.assertFalse(antes_de_abrir["pending"])
        self.assertTrue(antes_de_abrir["andamento"])
        self.assertEqual(antes_de_abrir["installed"]["commit"], COMMIT)
        final = json.loads(self.m.INSTALLED.read_text())
        self.assertEqual(final["build"], {"number": 2841, "commit": "aaaaaaa"})
        self.assertNotIn("installing", final)
        self.assertFalse(self.m.EM_ANDAMENTO.exists())
        self.assertFalse(self.m.PENDING.exists())
        self.assertFalse(self.m.LOCK.exists())
        self.assertTrue((self.m.ATUAL / "novo.txt").exists())

    def test_rollback_devolve_pending_e_installed(self):
        anterior = json.dumps({"commit": ANTIGO, "version": "0.57.0"})
        self.m.INSTALLED.write_text(anterior)
        type(self).abrir_funciona = False
        self.addCleanup(setattr, type(self), "abrir_funciona", True)
        self.assertEqual(self.rodar(), 1)
        self.assertEqual(json.loads(self.m.PENDING.read_text())["commit"], COMMIT)
        self.assertEqual(self.m.INSTALLED.read_text(), anterior)
        self.assertFalse(self.m.EM_ANDAMENTO.exists())
        self.assertTrue((self.m.ATUAL / "antigo.txt").exists())

    def test_rollback_sem_installed_anterior_remove_o_novo(self):
        type(self).abrir_funciona = False
        self.addCleanup(setattr, type(self), "abrir_funciona", True)
        self.assertEqual(self.rodar(), 1)
        self.assertFalse(self.m.INSTALLED.exists())
        self.assertTrue(self.m.PENDING.exists())


class RecusaTest(Base):
    def test_recusa_com_pending_ilegivel_reabre_o_app(self):
        self.m.PENDING.unlink()
        self.aberto = False
        self.assertEqual(self.rodar(wait_pid=4242), 1)
        self.assertEqual(self.abriu, [str(self.m.ATUAL)])

    def test_recusa_nao_reabre_app_que_ja_roda(self):
        self.m.PENDING.unlink()
        self.aberto = True
        self.assertEqual(self.rodar(), 1)
        self.assertEqual(self.abriu, [])

    def test_commit_invalido_reabre(self):
        self.aberto = False
        self.assertEqual(self.rodar(commit="xyz"), 1)
        self.assertEqual(self.abriu, [str(self.m.ATUAL)])

    def test_outra_instalacao_em_andamento_nao_reabre(self):
        self.m.LOCK.write_text("1")
        self.m.pid_vivo = lambda pid: True
        self.aberto = False
        self.assertEqual(self.rodar(), 1)
        self.assertEqual(self.abriu, [])


if __name__ == "__main__":
    unittest.main()
