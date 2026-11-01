import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import http.server

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conhecimento as c  # noqa: E402


def pdf_simples(texto):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>"]
    fluxo = ("BT /F1 14 Tf 20 100 Td (%s) Tj ET" % texto).encode()
    objs.append(b"<< /Length %d >>\nstream\n" % len(fluxo) + fluxo + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.p = os.path.realpath(self._t.name)
        self.addCleanup(self._t.cleanup)

    def w(self, nome, txt, modo="w"):
        caminho = os.path.join(self.p, nome)
        os.makedirs(os.path.dirname(caminho), exist_ok=True)
        with open(caminho, modo) as f:
            f.write(txt)
        return caminho

    def b(self, q, **k):
        return c.buscar(self.p, q, **k)


class Testes(Base):
    def test_txt_md_e_fonte(self):
        self.w("a.txt", "A garantia dura doze meses.")
        self.w("sub/b.md", "# Entrega\nO prazo de entrega e cinco dias.")
        r = c.indexar(self.p)
        self.assertEqual(r["novos"], 2)
        res = self.b("prazo entrega")["resultados"]
        self.assertEqual(res[0]["fonte"], os.path.join("sub", "b.md"))
        self.assertIn("DADO", self.b("garantia")["aviso"])

    def test_db_modo_0600(self):
        self.w("a.txt", "x y z")
        c.indexar(self.p)
        modo = os.stat(os.path.join(self.p, ".indice", "index.db")).st_mode & 0o777
        self.assertEqual(modo, 0o600)

    def test_acentos(self):
        self.w("p.txt", "O preço mensal é R$ 50.")
        c.indexar(self.p)
        self.assertTrue(self.b("preco")["resultados"])
        self.assertTrue(self.b("PREÇO")["resultados"])

    def test_consultas_estranhas(self):
        self.w("p.txt", "plano basico custa pouco")
        c.indexar(self.p)
        for q in ['"', "AND OR NOT", "a*", "(((", "col:valor", "-x", "NEAR(a b)", "'; DROP TABLE x;--", "", "   ", "💥"]:
            r = self.b(q)
            self.assertIn("resultados", r, q)
        self.assertTrue(self.b("plano AND NOT")["resultados"])

    def test_fallback_ou(self):
        self.w("p.txt", "plano basico custa pouco")
        c.indexar(self.p)
        self.assertTrue(self.b("plano inexistente")["resultados"])

    def test_sinonimos(self):
        self.w("p.txt", "A mensalidade e de 50 reais.")
        self.w("sinonimos.txt", "preço=valor,custo,mensalidade\n")
        c.indexar(self.p)
        self.assertTrue(self.b("preco")["resultados"])
        self.assertFalse(self.b("garantia")["resultados"])

    def test_cap_saida(self):
        for i in range(12):
            self.w("d%d.txt" % i, ("tema comum palavra%d " % i) * 200)
        c.indexar(self.p)
        r = self.b("tema comum", limite=10)
        self.assertLessEqual(len(json.dumps(r, ensure_ascii=False)), 4000)
        for it in r["resultados"]:
            self.assertLessEqual(len(it["trecho"]), 700)
        self.assertTrue(r["resultados"])

    def test_incremental_e_remocao(self):
        a = self.w("a.txt", "alfa unico")
        self.w("b.txt", "beta unico")
        c.indexar(self.p)
        r = c.indexar(self.p)
        self.assertEqual((r["novos"], r["atualizados"], r["iguais"]), (0, 0, 2))
        with open(a, "w") as f:
            f.write("gama novo")
        r = c.indexar(self.p)
        self.assertEqual((r["atualizados"], r["iguais"]), (1, 1))
        self.assertFalse(self.b("alfa")["resultados"])
        self.assertTrue(self.b("gama")["resultados"])
        os.remove(a)
        r = c.indexar(self.p)
        self.assertEqual(r["removidos"], 1)
        self.assertFalse(self.b("gama")["resultados"])
        e = c.estado(self.p)
        self.assertEqual(e["arquivos"], 1)
        self.assertTrue(e["ultima_atualizacao"])

    def test_symlink_fora(self):
        with tempfile.TemporaryDirectory() as fora:
            segredo = os.path.join(fora, "segredo.txt")
            with open(segredo, "w") as f:
                f.write("senha ultrasecreta")
            os.symlink(segredo, os.path.join(self.p, "s.txt"))
            os.symlink(fora, os.path.join(self.p, "pastafora"))
            self.w("ok.txt", "conteudo normal")
            r = c.indexar(self.p)
            self.assertFalse(self.b("ultrasecreta")["resultados"])
            motivos = " ".join(i["motivo"] for i in r["ignorados"])
            self.assertIn("fora da pasta", motivos)

    def test_symlink_dentro_ok(self):
        self.w("real.txt", "dentro da pasta")
        os.symlink(os.path.join(self.p, "real.txt"), os.path.join(self.p, "l.txt"))
        c.indexar(self.p)
        self.assertTrue(self.b("dentro")["resultados"])

    def test_links_fetch_injetado(self):
        self.w("links.txt", "# c\nhttps://exemplo.test/preco\n")
        chamadas = []

        def falso(url):
            chamadas.append(url)
            return "Pagina da loja: frete gratis acima de 100 reais"
        c.indexar(self.p, fetcher=falso)
        r = self.b("frete")["resultados"]
        self.assertEqual(r[0]["fonte"], "https://exemplo.test/preco")
        c.indexar(self.p, fetcher=falso)
        self.assertEqual(len(chamadas), 1)
        c.indexar(self.p, atualizar_links=True, fetcher=lambda u: "novo texto sobre devolucao")
        self.assertTrue(self.b("devolucao")["resultados"])
        self.assertFalse(self.b("frete")["resultados"])
        txts = os.listdir(os.path.join(self.p, ".indice", "links"))
        with open(os.path.join(self.p, ".indice", "links", txts[0])) as f:
            self.assertIn("baixado em:", f.read())
        self.w("links.txt", "")
        self.assertEqual(c.indexar(self.p)["removidos"], 1)
        self.assertEqual(os.listdir(os.path.join(self.p, ".indice", "links")), [])

    def test_link_falha_reportada(self):
        self.w("links.txt", "https://exemplo.test/x\n")

        def ruim(url):
            raise ValueError("HTTP 500")
        r = c.indexar(self.p, fetcher=ruim)
        self.assertTrue(any("link nao baixado" in i["motivo"] for i in r["ignorados"]))

    def test_hosts_privados(self):
        for u in ["http://127.0.0.1/", "http://localhost/", "http://10.0.0.5/", "http://192.168.1.1/",
                  "http://169.254.169.254/", "http://[::1]/", "http://0.0.0.0/", "file:///etc/passwd",
                  "ftp://exemplo.com/", "http://x.localhost/"]:
            with self.assertRaises(ValueError, msg=u):
                c.checar_url(u)

    def test_fetch_real_bloqueia_servidor_local(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"oi")

            def log_message(self, *a):
                pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        with self.assertRaises(ValueError):
            c.buscar_url("http://127.0.0.1:%d/" % srv.server_port)

    def test_html_para_texto(self):
        t = c.html_para_texto("<html><head><title>T</title></head><body><script>evil()</script>"
                              "<p>Ola &amp; bem-vindo</p><style>x{}</style></body></html>")
        self.assertIn("Ola & bem-vindo", t)
        self.assertNotIn("evil", t)

    def test_html_e_rtf_textutil(self):
        if not c.achar("textutil"):
            self.skipTest("textutil indisponivel")
        self.w("a.html", "<p>Horario: nove as <b>dezoito</b></p>")
        self.w("b.rtf", r"{\rtf1\ansi Politica de troca simples}")
        c.indexar(self.p)
        self.assertTrue(self.b("dezoito")["resultados"])
        self.assertTrue(self.b("troca")["resultados"])

    def test_pdf(self):
        if not c.achar("pdftotext"):
            self.skipTest("pdftotext indisponivel: teste de PDF pulado")
        self.w("doc.pdf", pdf_simples("Garantia estendida de dois anos"), "wb")
        c.indexar(self.p)
        r = self.b("garantia estendida")["resultados"]
        self.assertTrue(r, c.estado(self.p))
        self.assertEqual(r[0]["pagina"], 1)

    def test_imagem_sem_texto_e_descricao(self):
        # PNG 1x1 valido
        import zlib, struct

        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(b"\x00\xff")) + chunk(b"IEND", b""))
        self.w("foto.png", png, "wb")
        r = c.indexar(self.p)
        if c.achar("tesseract") and c.lang_ocr()[1]:
            self.assertTrue(any(i["arquivo"] == "foto.png" and i["motivo"] == "sem texto" for i in r["ignorados"]), r)
        self.w("foto.png.descricao.txt", "Imagem mostra a tabela de precos do plano ouro")
        r = c.indexar(self.p)
        res = self.b("plano ouro")["resultados"]
        self.assertTrue(res)
        self.assertEqual(res[0]["fonte"], "foto.png")
        self.assertFalse(any(i["arquivo"] == "foto.png" for i in r["ignorados"]))

    def test_cli(self):
        self.w("a.txt", "texto da cli")
        cmd = [sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "conhecimento.py")]
        subprocess.run(cmd + ["indexar", self.p], check=True, capture_output=True)
        o = subprocess.run(cmd + ["buscar", self.p, "cli", "--limite", "2"], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(o.stdout)["resultados"][0]["fonte"], "a.txt")
        o = subprocess.run(cmd + ["estado", self.p], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(o.stdout)["arquivos"], 1)

    def test_buscar_sem_indice(self):
        self.assertIn("erro", self.b("x"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
