# Atualizações do OpenCat

O OpenCat não usa o feed oficial do OpenBot. O `updaterEnabled` fica `false` em
`src/main/application-services.ts`, então uma versão oficial nunca se instala sozinha. Existem dois
fluxos separados.

## 1. Nossas builds (botão Atualizar na barra lateral)

Não precisa de Apple Developer ID nem de servidor. Tudo fica no seu Mac, em `~/OpenCat-updates/`
(pasta `0700`, arquivos `0600`).

1. **Preparar.** Faça commit das suas mudanças e rode:

   ```bash
   scripts/opencat-preparar-atualizacao.sh
   ```

   O script recusa rodar se houver edição não commitada nos caminhos que o `gerar-app.sh` restaura
   com `git checkout --` (por exemplo `packages/i18n` e `packages/ui/src/features/account`). Ele
   mostra esses arquivos. Depois roda o `gerar-app.sh`, confere a assinatura (`codesign`) e grava
   `pending.json` com `commit`, `version`, `builtAt`, `appPath` e a lista de mudanças (assuntos dos
   commits desde o `installed.json`, ou os últimos 20). Se o código tinha mudanças não commitadas fora
   desses caminhos, o commit recebe o sufixo `-dirty-<hash>`.
2. **Oferta.** Ao abrir e a cada 15 minutos, o app lê `pending.json` e valida tudo: formato exato,
   dono (você), sem link simbólico, `appPath` igual a
   `~/Downloads/openbot/dist/mac-arm64/OpenBot.app`, commit diferente do `installed.json` e assinatura
   válida com o mesmo Team ID do app em uso. Se algo falhar, o app fica quieto e registra o motivo no
   log. Se tudo passar, a barra lateral mostra **Atualizar**.
3. **Instalar.** Só o seu clique conta. O app abre uma janela de confirmação com a lista de mudanças,
   avisa se um agente está trabalhando, e diz que faz uma cópia dos dados e abre de novo sozinho. Ao
   aceitar, o app inicia `opencat-instalar-atualizacao.py` desacoplado (ele está em
   `Resources/opencat/` do app) e fecha.
4. **Troca segura.** O instalador lê o número de agentes do `openbot.db` (somente leitura) antes de
   fechar o app, verifica a assinatura, prepara uma cópia do app novo, clona os dados com `cp -c` e
   guarda o app anterior em `~/OpenCat-updates/copias/<data>/`. Depois abre o app novo e espera até
   15 minutos.
   - **Saudável:** a API de automação responde com pelo menos o número de agentes de antes. Grava
     `installed.json` e apaga `pending.json`.
   - **Ruim:** o app novo não roda, ou faltam agentes no banco. Volta ao app anterior (e aos dados,
     só se faltarem agentes).
   - **Indeterminado:** sem API de automação para conferir. Mantém o app novo, registra no log e não
     mexe nos dados.
   O log fica em `~/OpenCat-updates/instalacao.log`. As cópias não são apagadas sozinhas.

## 2. Versões oficiais do OpenBot

Nunca são instaladas por este caminho. Você decide o que trazer:

```bash
scripts/opencat-analisar-openbot.sh
```

O script só faz `git fetch origin --tags`. Ele acha a tag mais nova, compara com a última em
`openbot-analisado.txt` e grava `~/OpenCat-updates/openbot-<tag>.md` com as notas da versão (via `gh`,
se existir), os commits por área, os arquivos que nós também mudamos (prováveis conflitos) e uma linha
`decisão:` em branco por commit. Ele não faz merge, não compila e não instala.

Depois da sua decisão, traga os itens escolhidos com o seu fluxo de merge, faça commit e siga o
fluxo 1 para gerar e instalar a build.
