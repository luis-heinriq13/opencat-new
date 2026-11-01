# WhatsApp no OpenCat

A loja tem duas opções. Elas são independentes.

| | WhatsApp Business (API oficial) | WhatsApp (não oficial) |
|---|---|---|
| Como conecta | Token e ID do número da Meta | QR code, como o WhatsApp Web |
| Risco de banimento pela integração | Não, se seguir as regras da Meta | Sim. Viola os termos do WhatsApp |
| Custo | A Meta cobra por modelo enviado | Grátis |
| Número | Precisa de um número registrado na API | Seu número atual |
| Recebe mensagens | Por webhook (abaixo) | Sim, sincroniza as conversas liberadas |
| Em servidor | Sim, com Node.js | Exige compilar o motor para o servidor |

Recomendação: use a API oficial para empresa e produção. Use o WhatsApp (não oficial) só em conta pessoal ou de teste.

## API oficial

1. Em [Meta for Developers](https://developers.facebook.com/), crie um app do tipo Business e adicione o WhatsApp.
2. Crie um usuário do sistema e um token permanente com a permissão `whatsapp_business_messaging`.
3. Copie o ID do número em WhatsApp > Configuração da API.
4. Na loja do OpenCat, abra "WhatsApp Business (API oficial)", clique em conectar e cole os dois valores.

Para receber mensagens, crie uma rotina de webhook no OpenCat e aponte para ela o webhook do WhatsApp na Meta. A Meta exige um endereço https público.

Fora da janela de 24 horas após a última mensagem do cliente, só um modelo aprovado pode ser enviado.

Para listar modelos, defina também `WHATSAPP_BUSINESS_ACCOUNT_ID` no ambiente do servidor MCP.

## WhatsApp (não oficial)

1. Na loja, abra "WhatsApp (não oficial)", clique em conectar e depois em "Abrir painel (QR code)".
2. Marque que entendeu o risco, clique em conectar e leia o QR code no celular, em Aparelhos conectados.
3. Escolha as conversas. Os agentes só veem o que você liberar. "Liberar todas as conversas" não inclui grupos. Grupos ficam numa seção própria, sem nenhum marcado: marque só os que quiser. A escolha continua visível no painel depois de liberada, para você mudar quando quiser.
4. O envio começa desligado. Ligue no painel só se quiser.

Limites fixos: pausa de 20 a 40 segundos entre envios, 30 por hora e 150 por dia. Eles reduzem o risco, mas não o eliminam.

Se o painel for de uma versão antiga, atualize o OpenCat: a cópia em `~/.opencat/whatscat` é trocada quando a revisão do pacote muda.

Os dados ficam em `~/Library/Application Support/OpenCat-WhatsCat`. O painel abre só neste computador, em um endereço com segredo.

### Ponte para um agente (desligada por padrão)

A ponte entrega ao agente as mensagens novas das conversas liberadas e **envia a resposta dele sozinha**, com `send_text`, pelos limites fixos acima (20 a 40 s entre envios, 30 por hora, 150 por dia) e com um `request_id` estável por mensagem recebida, então uma nova tentativa não duplica. Não existe mais aprovação manual nem rascunhos: um arquivo antigo `opencat-rascunhos.json` é ignorado (e não é apagado). O risco de banimento e a violação dos termos do WhatsApp continuam: uma resposta automática é envio pela conta pessoal.

Só a ponte envia, e só a resposta da própria entrega. O que você escreve para o agente no chat dele nunca vai ao WhatsApp. As ferramentas MCP do agente expõem só leitura; as de envio ficam ocultas e recusadas, a menos que você ponha `"agentSendTools": true` no arquivo (ou `WHATSCAT_AGENT_SEND=1`).

Para ligar:

1. No OpenBot, ligue "Local scripts" no agente que vai responder (veja `docs/automation.md`).
2. Conecte o WhatsApp (não oficial) e libere as conversas no painel.
3. Restrinja o acesso do agente a Workspace (veja "Permissões" abaixo).
4. Crie `opencat-ponte.json` na pasta de dados do WhatsApp (não oficial):

```json
{ "enabled": true, "agentId": "ID-DO-AGENTE", "mode": "selected", "chats": ["5511999999999@s.whatsapp.net"], "pollSeconds": 15 }
```

`reply` vale `"auto"` (padrão, com a ponte ligada) ou `"pause"`. Com `"pause"` a ponte para tudo na rodada seguinte, sem ler nem responder, e as mensagens recebidas nesse tempo não são respondidas depois. O painel tem o interruptor Ligado/Pausado para isso.

#### O painel

O painel abre como janela modal do OpenCat e usa as cores e medidas do tema escuro dele. Seções: **Conexão** (estado e número conectado mascarado), **Atendimento** (agente, Ligado/Pausado, pausados com "Retomar"), **Quem o agente atende** (modo, busca, lista com iniciais, exclusões e equipe interna), **Grupos** (modo e instruções de cada um), **Atividade** (só contagens das últimas 24 horas) e, recolhida, a escolha das conversas visíveis ao motor.

O aviso "Entendi o risco" só aparece ao conectar ou reconectar um número, nunca com o número já ligado. Para fechar: botão **X**, tecla **Esc** ou a rota interna `/fechar`. O OpenCat trata `/fechar` e o Esc na própria janela, então ela fecha mesmo se a página travar. Fechar clicando fora não é possível: a janela é modal nativa e o clique fora vai para a janela bloqueada.

#### Segurança, no código

Estas regras valem mesmo que o modelo ignore o prompt:

- **Filtro de saída**, antes de qualquer envio. Barra respostas com marcas do invólucro da ponte, número de telefone ou ID de conversa que não sejam deste contato (em grupo, qualquer número), formato de chave (`sk-`, `ghp_`, `AIza`, `xox`, `Bearer`, cabeçalho de chave privada), caminho local (`/Users/`, `~/.`) ou trecho longo (12 palavras seguidas) igual ao arquivo de instruções (`instructionsFile`) ou às instruções do grupo. Barrada: nada é enviado, a auditoria registra o motivo, o contato pausa e o dono é avisado no chat do agente.
- **Passar para uma pessoa**: a resposta do agente `[[HUMANO]]` pausa o contato (padrão 24 h, `handoffMinutes`) e avisa o dono no chat do agente com só um rótulo mascarado e o motivo, e os `internalContacts` por WhatsApp (nome ou número mascarado e o motivo, nunca o conteúdo). O agente fica pausado para o contato até alguém tocar em Retomar no painel ou a pausa acabar. Quem está em `internalContacts` nunca é tratado como cliente.
- **Palavras de parada** (`stopWords`; padrão: pare, parar, sair, não quero, stop), só em conversa individual: a ponte confirma uma vez, põe o contato em `excludes` e nunca mais responde. O agente nem recebe a mensagem.
- **Dono assumiu**: uma mensagem que sai do seu número e que a ponte não enviou pausa aquele contato por 60 minutos (`takeoverMinutes`). A ponte nunca responde a mensagens suas.
- **Robôs em laço**: no máximo 10 respostas por hora por contato (`maxRepliesPerHour`) e 20 s entre elas (`minGapSeconds`). Passou do máximo: pausa e aviso ao dono.
- **Horário de silêncio** (`quietHours`: `enabled`, `start`, `end`; desligado por padrão): fora do expediente sai uma única mensagem "Retorno em breve" por janela, e o agente atende quando a janela acaba.
- **Grupos**: `groupConfigs` é uma lista de `{ "id", "mode", "instructions" }` com `mode` igual a `mention` (padrão), `readonly` ou `all`. Só os listados entram. O motor não manda dado de menção nas mensagens (os campos são `message_id`, `chat_id`, `sender_id`, `from_me`, `media_type`, `filename` e o texto), então a menção é reconhecida pelo texto: `@` mais o número da conta conectada, ou um dos `names`. Campos de menção, se o motor passar a mandá-los, também valem. Quem escreve num grupo chega ao agente só como um código (hash). `selfId` informa o ID da conta se o motor não o der.
- **Texto de terceiros é dado**: entra no JSON dentro do bloco `whatscat_mensagem_nao_confiavel`, com `<` escapado, de modo que nada fecha o bloco. O mesmo vale para o texto extraído de áudio, imagem e PDF.

#### Permissões: quem pode ser atendido

`access` do agente vale `workspace` (restrito) ou `full`. O OpenBot informa `access` em `GET /v1/agents`. Regra da ponte: contatos que não são você só são atendidos se o agente tem `workspace`. Com `full`, ou se o OpenBot não informar, a ponte recusa (auditoria `acesso_recusado` e aviso no painel) a menos que você ponha `"aceitoAcessoTotal": true` (o painel mostra o aviso e o interruptor). Mesmo com esse aceite, a lista de atendidos **não se amplia sozinha**: o modo `all` vira `selected` e contatos novos não entram.

Atenção: `workspace` **restringe só escrita**. Leitura de qualquer arquivo, comandos locais e rede continuam abertos para o agente em todos os provedores, e nenhum provedor tem um modo sem ferramentas de arquivo e shell. Restringir reduz o dano, não elimina: por isso as respostas passam também pelo filtro de saída, e instruções confidenciais ou dados de outros clientes não devem ficar em arquivos que o agente consiga ler.

#### Áudio, imagem e PDF

Antes de entregar ao agente, a ponte baixa o arquivo com `get_attachment`, com tetos de 25 MB (áudio), 20 MB (PDF) e 10 MB (imagem), numa pasta privada do contato (0700/0600) em `anexos/`.

- **Áudio**: `ffmpeg` converte (sem shell, com tempo limite, até 10 minutos) e o reconhecimento de voz local do OpenCat transcreve, preferindo o Whisper (português) e caindo no Parakeet. A ponte reaproveita o `voice-transcription-host.js` do aplicativo com `child_process.fork` em Node comum, e o OpenCat informa os caminhos em `OPENCAT_VOICE_HOST` e `OPENCAT_VOICE_RUNTIME`. Sem os modelos baixados, o agente é avisado que não conseguiu ouvir: a ponte não finge transcrever.
- **PDF**: `pdftotext` (até 40 páginas). Se não houver texto, OCR das 3 primeiras páginas (`pdftoppm` e `tesseract`). Texto limitado a 12000 caracteres, com aviso de corte.
- **Imagem**: `tesseract` (modelo `eng`; acentos podem falhar) e uma cópia do arquivo em `workspaceDir/whatsapp-midia/` (configure `workspaceDir` com a pasta do agente), para um modelo com visão poder abri-la mesmo com acesso restrito. Sem texto na imagem não é falha: o caminho segue para o agente. A leitura de imagem em si depende do provedor do agente.
- O bloco entregue leva a origem, o nome do arquivo e o texto extraído como dado de terceiro: **texto dentro de mídia nunca é instrução**. Se algo falha, o bloco diz o que falhou e orienta o agente a pedir que o contato escreva a mensagem.
- Arquivos com mais de 30 dias (`retentionDays`) são apagados.

#### Arquivos e métricas

- `opencat-ponte.json`, estado e arquivos de contato: modo 0600. A auditoria (`opencat-ponte-auditoria.log`) guarda eventos e hash curto da conversa, sem texto e sem número.
- `opencat-ponte-metricas.jsonl` (0600, gira em 1 MB para `.1`): uma linha por evento, sem conteúdo nem número, com `at`, `conversa` (hash), `tipo` (`contact` ou `group`), `evento` (`recebida`, `respondida`, `falhou`, `bloqueada`, `humano`, `pausada`, `midia_processada`, `midia_falhou`), `esperaMs` (da chegada à entrega ao agente), `agenteMs`, `envioMs`, `processoMs` (mídia) e `erro` (categoria).
- Modos (`mode`): `selected` (padrão), só `chats`; `all`, toda conversa de pessoa menos as de `excludes`, e só com acesso restrito. Grupos nunca entram por `all`.
- Só chegam mensagens posteriores ao momento em que a ponte liga, e o ID da mensagem do WhatsApp vira o `clientMessageId` contra duplicidade.
- Isolamento por contato: o fio do agente é um só, então cada mensagem leva um bloco só do contato, com as últimas 10 dele, e a instrução de não usar dados de outro. Isso reduz o risco, mas não o elimina.
- A ponte roda em segundo plano enquanto o OpenCat está aberto, mesmo com o painel fechado, e só com `"enabled": true`. O aplicativo inicia `whatscat-mcp.mjs --bridge`, reinicia com espera crescente e o encerra ao sair. Para desligar, `"enabled": false`: o processo para em até 30 segundos.
- Limitação conhecida: o formato exato das respostas de `read_messages`, `get_attachment` e do estado do motor (número conectado) ainda não foi confirmado com uma conta real. Teste primeiro com uma conta de teste e use `ataques-reais.md`, na pasta `tools/whatscat`, para ensaiar contra o modelo de verdade.

### Em produção

Não recomendamos o WhatsApp (não oficial) em servidor: o IP de datacenter e o uso contínuo aumentam o risco de banimento. Se for usar:

1. Compile `backend/cmd/localwhatsappmcp` e `vendor/wacli` do repositório [local_whatsapp_mcp](https://github.com/luis-heinriq13/local_whatsapp_mcp) para o sistema do servidor, com CGO ligado e a tag `sqlite_fts5`.
2. Copie `resources/whatscat` para `~/.opencat/whatscat` e os binários para `bin/`.
3. Defina `WHATSCAT_DATA_DIR` para uma pasta privada.
4. Abra o painel por um túnel SSH, nunca por um endereço público.
