#!/usr/bin/env python3
"""Aplica os textos do OpenCat so durante a build; o script gerar-app desfaz depois."""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent / "packages/i18n/src/messages"
for path in ROOT.rglob("*.ts"):
    text = path.read_text()
    new = re.sub(r'OpenBot(?!["\w]*":)(?![\w/-])', "OpenCat", text)
    if new != text:
        path.write_text(new)

# Textos visiveis fora do catalogo. Nome interno, pastas e cabecalhos nao entram aqui.
REPO = ROOT.parents[3]
VISIBLE = {
    "packages/ui/src/features/account/AccountLogin.tsx": ['const PRODUCT_NAME = "OpenBot"'],
    "packages/ui/src/features/account/LanguageWheel.tsx": ['const PRODUCT_NAME = "OpenBot"'],
    "src/renderer/src/features/onboarding/SetupReadError.tsx": ['const PRODUCT_NAME = "OpenBot"'],
    "src/renderer/index.html": ["<title>OpenBot</title>", "OpenBot requires JavaScript"],
    "src/renderer/helper.html": ["<title>OpenBot</title>"],
    "src/renderer/browser-pip.html": ["<title>OpenBot Browser</title>"],
    "src/main/browser-picture-in-picture.ts": ['title: "OpenBot Browser"'],
    "src/main/index.ts": ['new Notification({ title: "OpenBot"'],
    "src/main/loopback-callback-server.ts": ["<title>OpenBot</title>"],
}
for rel, snippets in VISIBLE.items():
    path = REPO / rel
    text = path.read_text()
    for snippet in snippets:
        if snippet not in text:
            print("AVISO: texto nao encontrado:", rel, snippet)
        text = text.replace(snippet, snippet.replace("OpenBot", "OpenCat"))
    path.write_text(text)
SOURCE = {
    "status/agent.ts": [
        ("Usage limit reached. Switched to {model}.", "Limite de uso atingido. Troquei para {model}."),
        ("Provider error. Switched to {model}.", "Erro do provedor. Troquei para {model}."),
    ],
    "error/agent.ts": [
        (
            "{provider} stopped responding, so OpenBot ended this turn. Send the message again, or choose another model.",
            "{provider} parou de responder e o turno foi encerrado. Envie de novo ou escolha outro modelo.",
        ),
    ],
}
for rel, pairs in SOURCE.items():
    path = ROOT / "en" / rel
    text = path.read_text()
    for old, new in pairs:
        if old not in text:
            print("AVISO: texto nao encontrado:", old)
        text = text.replace(old, new)
    path.write_text(text)
