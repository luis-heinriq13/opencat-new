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
3. Escolha as conversas. Os agentes só veem o que você liberar.
4. O envio começa desligado. Ligue no painel só se quiser.

Limites fixos: pausa de 20 a 40 segundos entre envios, 30 por hora e 150 por dia. Eles reduzem o risco, mas não o eliminam.

Os dados ficam em `~/Library/Application Support/OpenCat-WhatsCat`. O painel abre só neste computador, em um endereço com segredo.

### Em produção

Não recomendamos o WhatsCat em servidor: o IP de datacenter e o uso contínuo aumentam o risco de banimento. Se for usar:

1. Compile `backend/cmd/localwhatsappmcp` e `vendor/wacli` do repositório [local_whatsapp_mcp](https://github.com/luis-heinriq13/local_whatsapp_mcp) para o sistema do servidor, com CGO ligado e a tag `sqlite_fts5`.
2. Copie `resources/whatscat` para `~/.opencat/whatscat` e os binários para `bin/`.
3. Defina `WHATSCAT_DATA_DIR` para uma pasta privada.
4. Abra o painel por um túnel SSH, nunca por um endereço público.
