# Convite direto (sem o serviço de conta)

Em Configurações do servidor > Membros, "Link direto, sem o serviço de conta" gera um link `openbot://join?...`.
Sem conta, o convite é sempre direto. A pessoa cola o link em "Adicionar servidor remoto", escolhe um nome e entra.

- **Como conecta:** um gateway local libera só as rotas de membro da Team API (nunca tela remota, área de trabalho nem navegador). Um túnel do Cloudflare (`cloudflared`, baixado com checksum fixo em `~/.opencat/bin`) chega a esse gateway.
- **Quando liga:** só depois do primeiro convite direto. Desliga sozinho quando não há mais membro direto nem convite aberto.
- **Limite do túnel gratuito:** o endereço sobrevive a reiniciar o OpenCat, mas muda quando o computador reinicia ou o túnel cai. Aí os membros precisam de um novo convite.
- **Endereço fixo:** crie `~/.opencat/direct-access.json` com `{"publicUrl":"https://seu.dominio","gatewayPort":47823}` e aponte seu túnel ou proxy para `127.0.0.1:47823`. O túnel automático não é usado nesse caso.
- **Sessão:** vale 365 dias. Remover o membro encerra o acesso na hora.
