# WhatsApp no OpenCat

A loja tem duas opções. Elas são independentes.

| | WhatsApp Business (API oficial) | WhatsCat (não oficial) |
|---|---|---|
| Como conecta | Token e ID do número da Meta | QR code, como o WhatsApp Web |
| Risco de banimento pela integração | Não, se seguir as regras da Meta | Sim. Viola os termos do WhatsApp |
| Custo | A Meta cobra por modelo enviado | Grátis |
| Número | Precisa de um número registrado na API | Seu número atual |
| Recebe mensagens | Por webhook (abaixo) | Sim, sincroniza as conversas liberadas |
| Em servidor | Sim, com Node.js | Exige compilar o motor para o servidor |

Recomendação: use a API oficial para empresa e produção. Use o WhatsCat só em conta pessoal ou de teste.

## API oficial

1. Em [Meta for Developers](https://developers.facebook.com/), crie um app do tipo Business e adicione o WhatsApp.
2. Crie um usuário do sistema e um token permanente com a permissão `whatsapp_business_messaging`.
3. Copie o ID do número em WhatsApp > Configuração da API.
4. Na loja do OpenCat, abra "WhatsApp Business (API oficial)", clique em conectar e cole os dois valores.

Para receber mensagens, crie uma rotina de webhook no OpenCat e aponte para ela o webhook do WhatsApp na Meta. A Meta exige um endereço https público.

Fora da janela de 24 horas após a última mensagem do cliente, só um modelo aprovado pode ser enviado.

Para listar modelos, defina também `WHATSAPP_BUSINESS_ACCOUNT_ID` no ambiente do servidor MCP.

## WhatsCat

1. Na loja, abra "WhatsCat (não oficial)", clique em conectar e depois em "Abrir painel (QR code)".
2. Marque que entendeu o risco, clique em conectar e leia o QR code no celular, em Aparelhos conectados.
3. Escolha as conversas. Os agentes só veem o que você liberar. "Liberar todas as conversas" não inclui grupos. Grupos ficam numa seção própria, sem nenhum marcado: marque só os que quiser. A escolha continua visível no painel depois de liberada, para você mudar quando quiser.
4. O envio começa desligado. Ligue no painel só se quiser.

Limites fixos: pausa de 20 a 40 segundos entre envios, 30 por hora e 150 por dia. Eles reduzem o risco, mas não o eliminam.

Se o painel for de uma versão antiga, atualize o OpenCat: a cópia em `~/.opencat/whatscat` é trocada quando a revisão do pacote muda.

Os dados ficam em `~/Library/Application Support/OpenCat-WhatsCat`. O painel abre só neste computador, em um endereço com segredo.

### Ponte para um agente (piloto, desligada por padrão)

A ponte entrega ao agente as mensagens novas de conversas que você listar e transforma a resposta dele em um rascunho. Nada é enviado sozinho: você aprova cada rascunho no painel e só então o envio passa pelos limites acima. Não existe modo de envio automático. O risco de banimento e a violação dos termos do WhatsApp continuam os mesmos, e uma resposta aprovada ainda conta como envio pela conta pessoal.

Para ligar:

1. No OpenBot, ligue "Local scripts" no agente que vai responder (veja `docs/automation.md`).
2. Conecte o WhatsCat e libere as conversas no painel. Uma conversa fora do escopo do motor não chega à ponte.
3. Crie `opencat-ponte.json` na pasta de dados do WhatsCat:

```json
{ "enabled": true, "agentId": "ID-DO-AGENTE", "chats": ["5511999999999@s.whatsapp.net"], "groups": [], "pollSeconds": 15 }
```

4. Abra o painel. Os rascunhos aparecem em "Rascunhos de resposta", com Aprovar e enviar ou Descartar.

Regras:

- Sem `"enabled": true`, agente e ao menos uma conversa, a ponte não liga.
- Só entram conversas listadas em `chats`. Grupos só entram se o ID (`...@g.us`) estiver em `groups`; um grupo em `chats` é ignorado. Mensagens suas e listas de transmissão ou canais são ignoradas.
- Só chegam mensagens posteriores ao momento em que a ponte liga. O ID da mensagem do WhatsApp vira o `clientMessageId` (o OpenBot guarda o recibo por 24 horas) e fica numa lista local contra duplicidade.
- O texto chega ao agente dentro de um bloco `whatscat_mensagem_nao_confiavel`, em JSON, marcado como dado de terceiro e não como instrução. Isso reduz o risco de injeção de prompt, mas não o elimina: revise cada rascunho.
- Rascunhos e estado ficam em `opencat-rascunhos.json` e `opencat-ponte-estado.json` (modo 0600). A auditoria, `opencat-ponte-auditoria.log`, guarda eventos, resultado e um hash curto da conversa, sem texto e sem número.
- Se o envio falhar, o rascunho vira "falhou" e não é reenviado sozinho: o resultado pode ter saído, confira a conversa.
- Mídia: a ponte repassa só o tipo, o nome do arquivo e o caminho local, se o motor os informar. Não há transcrição de áudio nem leitura de imagem hoje, e o agente é avisado disso. A API local de scripts não aceita anexos.
- Limitação conhecida: a leitura usa a ferramenta `read_messages` do motor e o envio usa `send_message` (ajustável em `sendTool`). O formato exato das respostas do motor ainda não foi confirmado com uma conta real, então teste primeiro com uma conta de teste.

### Em produção

Não recomendamos o WhatsCat em servidor: o IP de datacenter e o uso contínuo aumentam o risco de banimento. Se for usar:

1. Compile `backend/cmd/localwhatsappmcp` e `vendor/wacli` do repositório [local_whatsapp_mcp](https://github.com/luis-heinriq13/local_whatsapp_mcp) para o sistema do servidor, com CGO ligado e a tag `sqlite_fts5`.
2. Copie `resources/whatscat` para `~/.opencat/whatscat` e os binários para `bin/`.
3. Defina `WHATSCAT_DATA_DIR` para uma pasta privada.
4. Abra o painel por um túnel SSH, nunca por um endereço público.
