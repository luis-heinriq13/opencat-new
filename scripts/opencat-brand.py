#!/usr/bin/env python3
"""Aplica os textos do OpenCat so durante a build; o script gerar-app desfaz depois."""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent / "packages/i18n/src/messages"
for path in (ROOT / "pt").rglob("*.ts"):
    text = path.read_text()
    new = re.sub(r'OpenBot(?!["\w]*":)(?![\w/-])', "OpenCat", text)
    if new != text:
        path.write_text(new)
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
