# Base de conhecimento dos agentes

Uma base local e gratuita. Nada sai do seu Mac, exceto o download dos links que voce listar.

## Onde colocar os arquivos
Pasta: `~/OpenBot/Shared/Conhecimento/ChatNeed/`

Aceita: `.pdf`, `.png`, `.jpg`, `.txt`, `.md`, `.docx`, `.rtf`, `.html`.
- `links.txt`: um endereco `http://` ou `https://` por linha.
- `sinonimos.txt`: uma linha por grupo, por exemplo `preço=valor,custo,mensalidade`.
- Imagem sem texto legivel: crie `foto.png.descricao.txt` com a descricao. Um agente com visao pode escrever isso uma vez.

## Como atualizar
```bash
python3 -I tools/conhecimento/conhecimento.py indexar ~/OpenBot/Shared/Conhecimento/ChatNeed/
python3 -I tools/conhecimento/conhecimento.py indexar ~/OpenBot/Shared/Conhecimento/ChatNeed/ --atualizar-links
python3 -I tools/conhecimento/conhecimento.py estado ~/OpenBot/Shared/Conhecimento/ChatNeed/
```
So arquivos novos ou alterados sao lidos de novo. Arquivos apagados saem do indice. Links so sao baixados de novo com `--atualizar-links`. O comando `estado` mostra o que foi ignorado e por que.

## Limites
- A busca e por palavras, nao por significado. "Quanto custa?" so acha textos com "custa"; use `sinonimos.txt`.
- PDF escaneado e imagem dependem do OCR. Neste Mac so ha OCR em ingles; acentos em portugues podem sair errados. Para melhorar, instale o idioma `por` do tesseract.
- Paginas dinamicas (carregadas por JavaScript) podem vir vazias. Nesse caso, use o navegador interno e salve o texto em um `.txt`.
- Links para rede local, `localhost` e enderecos privados sao recusados. Limite de 2 MB por pagina.
- O conteudo e tratado como dado, nunca como ordem.

## Cuidado com o conteudo
Em agentes que falam com clientes, coloque na base so material que o cliente pode ver (precos publicos, FAQ, politicas). Nao ponha contratos, dados de clientes, senhas ou notas internas.
