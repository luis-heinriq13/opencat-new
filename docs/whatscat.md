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
{ "enabled": true, "agentId": "ID-DO-AGENTE", "mode": "selected", "chats": ["5511999999999@s.whatsapp.net"] }
```

`reply` vale `"auto"` (padrão, com a ponte ligada) ou `"pause"`. Com `"pause"` a ponte para tudo na rodada seguinte, sem ler nem responder, e as mensagens recebidas nesse tempo não são respondidas depois. O painel tem o interruptor Ligado/Pausado para isso.

#### O painel

O painel abre como janela modal do OpenCat e usa as cores e medidas do tema escuro dele. Seções: **Conexão** (estado e número conectado mascarado), **Atendimento** (agente, Ligado/Pausado, pausados com "Retomar"), **Quem o agente atende** (modo, busca, lista com iniciais, exclusões e equipe interna), **Grupos** (modo e instruções de cada um), **Atividade** (só contagens das últimas 24 horas) e, recolhida, a escolha das conversas visíveis ao motor.

O aviso "Entendi o risco" só aparece ao conectar ou reconectar um número, nunca com o número já ligado. Para fechar: botão **X**, tecla **Esc** ou a rota interna `/fechar`. O OpenCat trata `/fechar` e o Esc na própria janela, então ela fecha mesmo se a página travar. Fechar clicando fora não é possível: a janela é modal nativa e o clique fora vai para a janela bloqueada.

#### Ritmo: latência e respostas em partes

Medido antes: 43 s no total (15 s de leitura, 20 s de agrupamento, 5 s do agente, 3 s de envio). Agora:

- **Leitura**: a cada 3 s (`pollSeconds`, 1 a 300). Depois de mais de 5 minutos sem mensagem nem trabalho na fila (`idleMinutes`), a leitura passa a cada 15 s (`pollIdleSeconds`) e volta a 3 s quando algo chega. Para ler com pouco custo, a ponte guarda por até 15 s a lista de conversas e o estado do motor, em vez de abrir um processo a cada leitura.
- **`get_updates`**: se a lista de ferramentas do motor (`tools/list`) tem `get_updates` com um parâmetro de ponto de controle (`cursor`, `checkpoint` e parecidos) e nenhum outro obrigatório, a ponte lê todas as conversas numa chamada só e guarda o ponto de controle no estado (ele só avança depois de as mensagens serem recebidas). A primeira resposta precisa ter a lista de mensagens e um novo ponto de controle; se não tiver, a ponte registra `get_updates_indisponivel` e volta a `read_messages`. Sem ponto de controle, só valem mensagens com data posterior à da ligação da ponte. O formato real do motor não foi confirmado com uma conta de verdade.
- **Agrupamento adaptativo**: uma rajada fecha depois de `groupSeconds` (padrão 6 s) de silêncio, e o teto é `groupMaxSeconds` (padrão 15 s) desde a primeira mensagem. A janela cai pela metade quando a última mensagem termina em ponto, `?`, `!` ou emoji, ou é mídia, e cresce 40% quando a pessoa digita em pedaços muito seguidos (menos de 2 s entre eles). `groupSeconds: 0` entrega na hora.
- **Respostas em partes**: depois do filtro de saída, que olha a resposta inteira, ela vira até `maxPartes` (padrão 4) mensagens de cerca de `parteChars` (padrão 300) caracteres. A divisão é nas linhas em branco, depois nas frases; links e itens de lista nunca são cortados, e nada é resumido ou perdido (se não cabe em `maxPartes`, as partes crescem). Entre as partes há uma pausa proporcional ao tamanho da próxima, de `pausaMinSegundos` (1,5) a `pausaMaxSegundos` (5), pelo limitador: os tetos de 30 por hora e 150 por dia continuam valendo para cada parte, então uma resposta em 4 partes gasta 4 envios. Só a primeira parte segue a pausa de 20 a 40 s e o limite de respostas por hora; as outras usam a pausa curta. Cada parte tem um `request_id` estável (`wc-…`, `wc-…-p2`, …), então uma nova tentativa não duplica; se uma parte falha, as seguintes esperam por ela. Uma mensagem nova do contato durante o envio não interrompe: as partes terminam e ela é processada na rodada seguinte. Se o dono assumir a conversa no meio, as partes que faltam são descartadas.
- **Digitando…**: só se a lista de ferramentas do motor tiver uma ferramenta de digitação (`send_typing`, `set_typing`, `send_presence`, `chat_presence` e parecidas) que peça apenas `chat_id`. O motor atual não a mostra no código deste repositório, então a ponte não inventa esse chamado.

#### Uma tarefa por contato

Cada contato e cada grupo tem uma **tarefa** própria do agente (a mesma coisa das tarefas da aba Tarefas), criada pela rota local `POST /v1/agents/:id/tasks` (veja `docs/automation.md`). Assim as conversas dos clientes não caem no chat principal do dono e os contatos não dividem o contexto da conversa. A tarefa se chama `WhatsApp #<hash do contato>`: sem número nem nome.

- A ponte guarda contato -> `taskId` no estado e manda a mensagem a essa tarefa. Se o estado se perdeu, a rota acha a tarefa aberta pelo título.
- Tarefas de contatos parados há mais de 24 h são encerradas, para nunca chegar ao limite de 50 tarefas abertas. Perto de `maxThreadsAbertas` (padrão 40), a ponte também encerra a mais antiga que está parada há 10 minutos antes de abrir outra. Se o contato volta, abre uma tarefa nova; o contexto vem das últimas 10 mensagens que a ponte guarda.
- Se o OpenBot não tem a rota (versão antiga, resposta 404 ou 405), a ponte cai no chat do agente, como antes, e registra `fio_por_contato_indisponivel` uma vez. Outras recusas (limite de tarefas, "Local scripts" desligado) são falhas de entrega com nova tentativa, nunca um desvio para o chat principal. `"threadsPorContato": false` mantém o chat único.
- Os avisos ao dono (pausa, limite por hora, resposta barrada) continuam no chat principal do agente, sem conteúdo de cliente.
- **O dono pode pedir resumos**: as ferramentas MCP de leitura do WhatsCat (`read_messages` e as outras que não enviam) continuam disponíveis ao agente em qualquer tarefa ou no chat principal, e o `whatscat_status` mostra o estado. Peça no chat do agente, por exemplo "resuma as conversas de hoje".
- **O que continua compartilhado**: arquivos, memórias, instruções e a pasta de trabalho são do agente, não da tarefa. Um contato não vê a tarefa de outro, mas o agente pode ler os mesmos arquivos e lembrar as mesmas memórias nas duas. Não guarde dados de um cliente em memória ou arquivo do agente.
- Falha de uma tarefa aparece só nela (aba Tarefas), não no chat principal. Com o nível de notificação "Todas", o fim de cada turno de tarefa ainda gera uma notificação; use "Só o que precisa de mim" no agente para silenciá-las.

#### Segurança, no código

Estas regras valem mesmo que o modelo ignore o prompt:

- **Filtro de saída**, antes de qualquer envio. Barra respostas com marcas do invólucro da ponte, número de telefone ou ID de conversa que não sejam deste contato (em grupo, qualquer número), formato de chave (`sk-`, `ghp_`, `AIza`, `xox`, `Bearer`, cabeçalho de chave privada), caminho local (`/Users/`, `~/.`) ou trecho longo (12 palavras seguidas) igual ao arquivo de instruções (`instructionsFile`) ou às instruções do grupo. Barrada: nada é enviado, a auditoria registra o motivo, o contato pausa e o dono é avisado no chat do agente.
- **Passar para uma pessoa**: a resposta do agente `[[HUMANO]]` pausa o contato (padrão 24 h, `handoffMinutes`) e avisa o dono no chat do agente com só um rótulo mascarado e o motivo, e os `internalContacts` por WhatsApp (nome ou número mascarado e o motivo, nunca o conteúdo). O agente fica pausado para o contato até alguém tocar em Retomar no painel ou a pausa acabar. Quem está em `internalContacts` nunca é tratado como cliente.
- **Palavras de parada** (`stopWords`; padrão: pare, parar, sair, não quero, stop), só em conversa individual: a ponte confirma uma vez, põe o contato em `excludes` e nunca mais responde. O agente nem recebe a mensagem. A palavra solta só vale em mensagem de até 8 palavras. Frases de saída explícitas em português ("não quero mais receber mensagens", "me tire da lista", "remover meu número", "descadastrar") valem em mensagem de até 40 palavras, com qualquer `stopWords`; "remover" e "não tenho interesse" valem quando são a mensagem inteira, com ou sem cortesia.
- **Dono assumiu**: uma mensagem que sai do seu número e que a ponte não enviou pausa aquele contato por 60 minutos (`takeoverMinutes`). A ponte nunca responde a mensagens suas.
- **Robôs em laço**: no máximo 10 respostas por hora por contato (`maxRepliesPerHour`) e 20 s entre elas (`minGapSeconds`). Passou do máximo: pausa e aviso ao dono.
- **Horário de silêncio** (`quietHours`: `enabled`, `start`, `end`; desligado por padrão): fora do expediente sai uma única mensagem "Retorno em breve" por janela, e o agente atende quando a janela acaba.
- **Grupos**: `groupConfigs` é uma lista de `{ "id", "mode", "instructions" }` com `mode` igual a `mention` (padrão), `readonly` ou `all`. Só os listados entram. O motor não manda dado de menção nas mensagens (os campos são `message_id`, `chat_id`, `sender_id`, `from_me`, `media_type`, `filename` e o texto), então a menção é reconhecida pelo texto: `@` mais o número da conta conectada, ou um dos `names`. Campos de menção, se o motor passar a mandá-los, também valem. Quem escreve num grupo chega ao agente só como um código (hash). `selfId` informa o ID da conta se o motor não o der.
- **Texto de terceiros é dado**: entra no JSON dentro do bloco `whatscat_mensagem_nao_confiavel`, com `<` escapado, de modo que nada fecha o bloco. O mesmo vale para o texto extraído de áudio, imagem e PDF.

#### Fila de follow-up (desligada por padrão)

O agente propõe, o dono aprova no painel (ou escolhe o modo automático) e só a ponte envia. A fila fica em `opencat-ponte-followup.json` (0600, gravada com trava, porque o agente, o painel e a ponte são processos separados). A configuração é `followUp` em `opencat-ponte.json`: `ativo` (`false`), `autonomia` (`aprovar`), `limiteDia` (5, até 20), `inicio` e `fim` (09:00 a 18:00, de segunda a sexta, no relógio local) e `naoContatarArquivo` (só neste arquivo; padrão `~/OpenBot/Shared/ChatNeed-Prospeccao/nao-contatar.csv`).

- **Ferramentas do agente**: `propor_follow_up` só acrescenta uma `proposta`. `listar_follow_up` diz em palavras simples o que o agente pode fazer agora (`situacao`: `desligado`, `precisa_aprovacao` ou `automatico`, `mensagem` e `restamHoje`) e mostra contagens e estados, sem nome, texto, número inteiro ou histórico, então o dono pode perguntar no chat do agente. Valem com as ferramentas de envio desligadas. Não existe ferramenta de aprovação nem de mudança de modo. Ressalva: um agente com escrita fora do workspace (acesso total) pode editar o arquivo da fila, como qualquer outro arquivo desta pasta.
- **Modo automático** (`followUp.autonomia`: `aprovar` por padrão, ou `auto`): só a rota `/follow-up/autonomia` do painel muda o modo, e ligar `auto` exige a confirmação do risco de banimento. Com `followUp.ativo` ligado, a ponte aprova a proposta mais antiga só no momento em que ela pode sair, com os mesmos filtros, o mesmo selo e as mesmas conferências; limite do dia, horário, intervalo, silêncio e `nao-contatar` continuam valendo. Proposta barrada vira `recusada`, com o motivo no painel. Número sem o nono dígito espera o dono. O card mostra as últimas enviadas.
- **Selo da aprovação**: ao aprovar, grava-se um HMAC de `id`, `numero`, `chatId` e `texto`, com a chave em `opencat-ponte-aprovacao.key` (0600), e a ponte confere o selo e passa o texto de novo pelo filtro antes do envio, dentro da trava da fila. Sem selo válido o item vira `recusada` (`aprovacao_invalida`). Limite: isto pega uma edição do arquivo da fila, não um agente decidido, porque um agente com acesso total aos arquivos pode ler essa chave. O isolamento real vem de rodar o atendente em outro usuário ou outra máquina.
- **Lista `nao-contatar.csv`**: aceita `,` e `;` (Excel em pt-BR), acha a coluna do telefone pelo cabeçalho (`telefone`, `celular`, `whatsapp`, `número` e parecidos) e acrescenta no mesmo formato. Arquivo sem coluna de telefone ou com uma linha sem número lido conta como ilegível: nada é proposto, aprovado nem enviado.
- **Recusas**: número em `nao-contatar.csv`, contato parado, excluído ou interno, qualquer item anterior do mesmo número (com ou sem o nono dígito), exceto `falhou` sem dúvida, que dá lugar à nova proposta com outro `request_id`, grupo, número inválido ou fora do Brasil, texto vazio, com mais de 600 caracteres, com `@@HUMANO@@` ou barrado por `filterOutbound`. Sem a lista legível, nada é proposto, aprovado nem enviado.
- **Envio**: no máximo um por rodada, de 4 a 8 minutos entre eles, com o intervalo gravado no mesmo arquivo. Antes de enviar, a ponte confere de novo a pausa geral, o interruptor, a lista e o estado do contato. A marca `enviada` é gravada antes do envio, com `request_id` `wc-fu-<hash>` derivado só do número e da tentativa. Um envio interrompido ou com resultado `uncertain` nunca se repete, nem por nova proposta: fica `incerto` e o painel pede para conferir no celular. `failed`, com ou sem `isError`, vira `falhou`, e a resposta comum nesse caso tenta de novo em vez de contar como enviada. O limitador e `maxRepliesPerHour` continuam valendo.
- **Escopo do motor**: o motor recusa `send_text` fora do escopo (`allowed` em `send`, e `CheckContentScope` no wacli, que lê `content-policy.json`). Por isso a conversa entra por `PUT /scope` logo antes do primeiro envio, depois de todas as conferências, mantendo as que já estão e sem nunca usar o modo `all`. Essa troca reinicia a sessão do motor, então o envio espera a rodada seguinte e pelo menos 30 s. A marca é gravada antes do `PUT`. Se a mensagem não sai, se o item fica em espera (fora do horário, limite, pausa), ou se passam 5 minutos sem envio, a conversa é retirada, a cada rodada, inclusive depois de uma queda. Se o painel tira a conversa do escopo, o item confere o escopo de novo. Depois de `accepted` ou de um envio incerto ela fica no escopo, entra em `chats` da ponte e o agente recebe o texto no histórico (`de: voce`): um "pare" depois de um envio incerto precisa ser lido.
- **Respostas**: a primeira mensagem marca `respondeu` e segue o atendimento normal. Palavra de parada usa `stopContact` e também acrescenta o número a `nao-contatar.csv`, só com o follow-up ligado ou se o contato veio da fila.
- **Nono dígito**: a ponte nunca o inventa. O wacli consulta `IsOnWhatsApp` antes de enviar e troca o destino pela forma registrada, mas o escopo é conferido nessa forma trocada. Se ela difere do número proposto, o motor recusa com `content excluded by chat scope`, nada sai e o item fica `falhou`. Proponha a forma registrada: ela substitui o item.
- **Não confirmado com conta real**: a entrega a quem nunca falou com o número (`accepted` não é entrega, e o próprio wacli avisa que um primeiro contato pode ser descartado em silêncio), e a resposta quando o contato chega como `@lid`. A ponte liga a conversa `@lid` ao item só se a mensagem trouxer o número (`sender_pn`, `sender_alt`, `chat_pn`, `chat_phone`, `phone` ou `sender_id` com número), e esses nomes não foram confirmados. Sem o número, a resposta não é lida.

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
- `opencat-ponte-metricas.jsonl` (0600, gira em 1 MB para `.1`): uma linha por evento, sem conteúdo nem número, com `at`, `conversa` (hash), `tipo` (`contact` ou `group`), `evento` (`recebida`, `respondida`, `falhou`, `bloqueada`, `humano`, `pausada`, `midia_processada`, `midia_falhou`, `follow_up_enviado`, `follow_up_respondeu`, `follow_up_falhou`, `follow_up_incerto`, `follow_up_barrado`), `esperaMs` (da chegada à entrega ao agente), `agenteMs`, `envioMs`, `processoMs` (mídia), `partes` (em `respondida`, só quando a resposta saiu em mais de uma mensagem) e `erro` (categoria). Os campos só crescem: o `respondida` é gravado uma vez por resposta, quando sai a primeira parte, e `esperaMs` continua sendo o tempo da chegada à entrega ao agente.
- Modos (`mode`): `selected` (padrão), só `chats`; `all`, toda conversa de pessoa menos as de `excludes`, e só com acesso restrito. Grupos nunca entram por `all`.
- Só chegam mensagens posteriores ao momento em que a ponte liga, e o ID da mensagem do WhatsApp vira o `clientMessageId` contra duplicidade.
- Isolamento por contato: cada contato (e cada grupo) tem a sua própria tarefa no agente, com conversa e sessão separadas (veja "Uma tarefa por contato"). Além disso, cada mensagem leva um bloco só do contato, com as últimas 10 dele, e a instrução de não usar dados de outro. Isso reduz o risco, mas não o elimina.
- A ponte roda em segundo plano enquanto o OpenCat está aberto, mesmo com o painel fechado, e só com `"enabled": true`. O aplicativo inicia `whatscat-mcp.mjs --bridge`, reinicia com espera crescente e o encerra ao sair. Para desligar, `"enabled": false`: o processo para em até 30 segundos.
- Limitação conhecida: o formato exato das respostas de `read_messages`, `get_attachment` e do estado do motor (número conectado) ainda não foi confirmado com uma conta real. Teste primeiro com uma conta de teste e use `ataques-reais.md`, na pasta `tools/whatscat`, para ensaiar contra o modelo de verdade.

### Em produção

Não recomendamos o WhatsApp (não oficial) em servidor: o IP de datacenter e o uso contínuo aumentam o risco de banimento. Se for usar:

1. Compile `backend/cmd/localwhatsappmcp` e `vendor/wacli` do repositório [local_whatsapp_mcp](https://github.com/luis-heinriq13/local_whatsapp_mcp) para o sistema do servidor, com CGO ligado e a tag `sqlite_fts5`.
2. Copie `resources/whatscat` para `~/.opencat/whatscat` e os binários para `bin/`.
3. Defina `WHATSCAT_DATA_DIR` para uma pasta privada.
4. Abra o painel por um túnel SSH, nunca por um endereço público.
