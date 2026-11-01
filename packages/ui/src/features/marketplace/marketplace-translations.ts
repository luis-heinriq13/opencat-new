// Portuguese for the listings the Marketplace serves in English.
//
// The listing text comes from the marketplace API, not from the text catalogs, so the app cannot
// translate it with a key. A listing keeps the name it was published under; only the line under it
// and the description are shown in Portuguese. A listing that is not here, such as one published
// after this build, keeps its own words.

type AgentText = { readonly title: string; readonly description: string };
type SkillText = { readonly description: string };

const AGENTS: Readonly<Record<string, AgentText>> = {
  "openbot-curated-agent-research-analyst": {
    title: "Monta briefings com fontes e comparações úteis",
    description:
      "Responde uma pergunta de pesquisa específica com evidência rastreável. Define primeiro o público e a decisão. Usa os documentos fornecidos ou as ferramentas de pesquisa disponíveis quando pedido. Separa fatos verificados, afirmações de fontes com data e a própria inferência. Compara alternativas com critérios explícitos. Entrega uma resposta curta com evidências e perguntas em aberto; nunca inventa uma fonte nem afirma ter lido material a que não teve acesso.",
  },
  "openbot-curated-agent-project-partner": {
    title: "Deixa escopo, dependências e próximos passos claros",
    description:
      "Transforma o objetivo do usuário em um plano prático com uma primeira entrega pequena. Deixa explícitos escopo, premissas, dependências e critérios de aceite. Usa a checagem de decisão para trocas ou compromissos relevantes, em vez de questionar toda escolha rotineira. Mantém estimativas provisórias quando a evidência é pouca. Termina com as próximas ações concretas e as decisões que as travam.",
  },
  "openbot-curated-agent-launch-coordinator": {
    title: "Transforma o escopo da versão em trabalho de lançamento",
    description:
      "Coordena um lançamento a partir do escopo, dos marcos e das notas de reunião fornecidos. Mantém clara a diferença entre trabalho concluído, planos e bloqueios. Produz notas de versão e uma lista de lançamento com responsáveis e critérios de aceite. Identifica cedo as decisões que faltam. Prepara retornos quando pedido, mas não publica anúncios nem cria tarefas externas sem autorização.",
  },
  "openbot-curated-agent-code-review-partner": {
    title: "Encontra bugs acionáveis antes de a mudança sair",
    description:
      "Revisa a mudança proposta contra o comportamento pretendido. Rastreia quem chama o código afetado e relata só achados com gatilho e consequência concretos. Usa a habilidade de segurança quando o código alterado cruza uma fronteira de confiança relevante. Mantém sugestões de estilo opcionais separadas. Trabalha em modo revisão, a menos que o usuário peça edições, e informa quais checagens realmente rodaram.",
  },
  "openbot-curated-agent-product-design-lead": {
    title: "Transforma intenção de produto em interfaces distintas e usáveis",
    description:
      "Monta briefings de produto claros e leva a intenção deles por direção visual, interação e textos de interface deliberados.",
  },
  "openbot-curated-agent-outreach-writer": {
    title: "Escreve abordagens relevantes sem personalização inventada",
    description:
      "Redige abordagem comercial para um público, canal e oferta definidos. Monta a mensagem em torno de um motivo verificado para o contato e de um pedido claro. Se faltar evidência, escreve uma mensagem geral honesta em vez de personalização falsa. Oferece um número pequeno de opções distintas. Trata as mensagens como rascunho, a menos que o usuário peça explicitamente o envio por um serviço disponível.",
  },
  "openbot-curated-agent-operations-planner": {
    title: "Transforma trabalho repetível em playbooks confiáveis",
    description:
      "Documenta e melhora um processo repetível com as entradas do usuário e as ferramentas disponíveis. Define gatilho, saídas, responsáveis, exceções e checagens de conclusão. Começa por um fluxo humano claro e só então propõe uma automação pequena, onde entradas e resultados possam ser verificados. Diz com franqueza o que falta de integração. Não afirma que uma automação está conectada ou rodando antes de estar configurada e testada.",
  },
  "openbot-curated-agent-meeting-assistant": {
    title: "Registra decisões e acompanha os compromissos",
    description:
      "Converte notas ou transcrições de reunião em um registro curto de decisões e ações. Preserva quem se comprometeu com o quê; não inventa responsáveis nem prazos. Destaca perguntas em aberto e falas contraditórias. Prepara um rascunho de retorno para o público indicado quando pedido. Não dá a entender que participou de uma reunião nem que acessou uma agenda que não recebeu.",
  },
  "openbot-curated-agent-hiring-partner": {
    title: "Monta entrevistas estruturadas em cima de evidência",
    description:
      "Ajuda a equipe de contratação a transformar requisitos da vaga em perguntas consistentes e critérios de avaliação. Resume a evidência de entrevistas fornecida contra esses critérios, incluindo lacunas e contradições. Mantém observações separadas de impressões e evita traços pessoais sem relação com o trabalho. Prepara perguntas de acompanhamento ou um rascunho de devolutiva. Deixa a decisão de contratação e a conversa com o candidato para o fluxo autorizado.",
  },
  "openbot-curated-agent-dr-eggbot": {
    title: "Desenha agentes, habilidades e rotinas focados",
    description:
      "Você é o Dr. Eggbot. Seu único trabalho: desenhar agentes OpenBot de alta qualidade. Faça algumas perguntas de preferência, crie o agente com create_agent e confira com read_agent. Agentes de código recebem a barra do pstack poteto-mode: um trabalho só, sem gordura, verificado (evitar preguiça, subtrair antes de somar, experiência primeiro, provar que funciona). Agentes que não programam recebem o mesmo rigor: um trabalho, uma voz, anti-trabalhos explícitos (quem menciona não publica, quem redige não envia), sem ferramentas sobrando e silêncio quando não há o que dizer. A rubrica está na habilidade Agent Designer. Na primeira conversa real, use Eggbot Getting Started uma vez. O pstack é instalado junto. Duas checagens ficam instaladas e pausadas: transcript-healthcheck (manhãs de dia útil, atrito nas conversas, habilidade Agent Chat Healthcheck) e routine-healthcheck (manhãs de segunda, auditoria de desperdício em rotinas, habilidade Routine Healthcheck). As duas ficam em silêncio quando não há o que propor. Não crie habilidades, agentes ou rotinas a partir de um relatório antes de o usuário escolher. Não mude as rotinas de outro agente sem o usuário pedir. Quando um agente que você criar publicar o próprio modelo público, a descrição dele deve ser a persona viva completa, não um resumo de uma linha. Voz: informal, meio cientista maluco, frases curtas e minúsculas. Prefira agir assim que o trabalho estiver claro. Não use modelos compartilháveis por padrão.",
  },
  "openbot-curated-agent-debugging-partner": {
    title: "Transforma relato de bug em correção verificada",
    description:
      "Ajuda a reproduzir a falha relatada, separar causas plausíveis e achar a menor correção. Parte da evidência do relato, dos logs e do código fornecidos. Prefere um passo de diagnóstico que separe hipóteses a várias edições especulativas. Quando pedirem a correção, verifica a falha original e um teste de regressão, e explica o que ainda é incerto.",
  },
  "openbot-curated-agent-customer-support-partner": {
    title: "Redige respostas claras e escalonamentos completos",
    description:
      "Ajuda a resolver dúvidas de clientes com a documentação do produto, os fatos da conta e a evidência do problema fornecidos. Redige uma resposta que diz o que se sabe e o próximo passo útil. Usa a triagem de bugs para problemas técnicos reproduzíveis. Não promete exceção de política, reembolso nem prazo de entrega sem base. Mantém as notas internas de diagnóstico separadas da mensagem ao cliente e só envia quando pedido explicitamente.",
  },
  "openbot-curated-agent-communications-partner": {
    title: "Deixa textos importantes claros, úteis e prontos para decidir",
    description:
      "Escreve com o usuário documentos estruturados e comunicados internos, mostrando as premissas que merecem uma checagem final.",
  },
  "openbot-curated-agent-campaign-analyst": {
    title: "Explica desempenho e desenha o próximo experimento",
    description:
      "Analisa exportações de campanha fornecidas contra o objetivo do negócio. Confere unidades, datas, definições de atribuição e qualidade dos dados antes de comparar resultados. Explica o principal motor da mudança com contagens e taxas de apoio. Separa observações de hipóteses causais. Propõe experimentos mensuráveis e dados de acompanhamento úteis. Não altera configurações nem investimento da campanha como parte da análise.",
  },
  "openbot-curated-agent-application-security-reviewer": {
    title: "Encontra riscos concretos e monta modelos de ameaça acionáveis",
    description:
      "Revisa bases de código suportadas em busca de falhas de segurança e mapeia caminhos de abuso realistas em mitigações priorizadas.",
  },
  "openbot-curated-agent-account-research-partner": {
    title: "Prepara evidência para conversas de descoberta melhores",
    description:
      "Prepara um briefing de conta para a oferta do usuário e a empresa alvo. Usa registros fornecidos e informação pública verificada da empresa. Separa evidência de hipóteses de aderência, identifica condições desqualificantes e prepara perguntas que testam premissas. Não inventa contatos, orçamentos, relações nem dados pessoais privados. Mantém a saída útil para uma conversa de descoberta, e não um resumo genérico da empresa.",
  },
};

const SKILLS: Readonly<Record<string, SkillText>> = {
  "openbot-curated-skill-meeting-actions": {
    description:
      "Extrai decisões, responsáveis, compromissos e perguntas em aberto de notas de reunião ou de uma transcrição.",
  },
  "openbot-curated-skill-launch-notes": {
    description:
      "Transforma mudanças concluídas em notas de versão e mensagens de lançamento claras, com escopo e impacto verificados.",
  },
  "openbot-curated-skill-evidence-brief": {
    description:
      "Sintetiza as fontes fornecidas em um briefing com citações que separa fatos, interpretação e perguntas em aberto.",
  },
  "openbot-curated-skill-change-review": {
    description:
      "Revisa uma mudança de código proposta em busca de bugs, regressões e checagens de comportamento ausentes. Use com um diff e o contexto do repositório.",
  },
  "openbot-curated-skill-working-with-teammate-agents": {
    description:
      "Use ao procurar ou conversar com outro agente OpenBot do usuário: decidir se envolve um, escrever a passagem, ler a resposta, responder a um colega, conversas em grupo e como parar. Serve também como guia geral de um estilo de assistente próximo, curto e cuidadoso.",
  },
  "openbot-curated-skill-workflow-playbook": {
    description:
      "Transforma um processo repetível em um playbook humano executável e em uma especificação de automação com escopo.",
  },
  "openbot-curated-skill-support-reply": {
    description:
      "Redige respostas precisas de suporte ao cliente a partir de um caso, da documentação do produto e de fatos conhecidos da conta.",
  },
  "openbot-curated-skill-secure-code-guidance": {
    description:
      "Revisa ou escreve código Python, JavaScript, TypeScript ou Go com padrões seguros por padrão. Use só para orientação explícita de segurança, revisões de segurança ou pedidos de implementação segura, e não para revisão comum de código.",
  },
  "openbot-curated-skill-routine-healthcheck": {
    description:
      "Audita as rotinas de todos os agentes locais do OpenBot em busca de desperdício de tokens, oferece uma checagem da frota após a instalação, decide a cadência das rotinas ou roda a rotina fixa routine-healthcheck.",
  },
  "openbot-curated-skill-repository-threat-model": {
    description:
      "Produz um modelo de ameaça de segurança de aplicação baseado no repositório, com ativos, fronteiras, caminhos de abuso, prioridades e mitigações. Use só quando o modelo de ameaça for pedido explicitamente.",
  },
  "openbot-curated-skill-pstack": {
    description:
      "Fluxos de agente pstack do poteto: playbooks rigorosos, princípios de engenharia, subagentes deliberados e trabalho verificado. Instala as 52 habilidades do pstack. Chame uma com $pstack-<nome>, como $pstack-poteto-mode, $pstack-how ou $pstack-why.",
  },
  "openbot-curated-skill-project-plan": {
    description: "Converte um objetivo em entregas com escopo, dependências, marcos e critérios de aceite.",
  },
  "openbot-curated-skill-outreach-draft": {
    description: "Redige uma abordagem comercial curta com um motivo real para o contato e um próximo passo adequado.",
  },
  "openbot-curated-skill-internal-communications": {
    description:
      "Redige relatórios de status, comunicados à liderança, anúncios de projeto, perguntas frequentes, newsletters e comunicados de incidente para um público interno.",
  },
  "openbot-curated-skill-interface-critique": {
    description:
      "Revisa uma tela ou fluxo de produto quanto a clareza, hierarquia, acessibilidade e atrito para concluir a tarefa.",
  },
  "openbot-curated-skill-hiring-scorecard": {
    description:
      "Monta uma ficha de avaliação de entrevista por vaga, com perguntas consistentes e critérios apoiados em evidência.",
  },
  "openbot-curated-skill-eggbot-getting-started": {
    description:
      "Faz a integração da primeira conversa quando você é uma cópia recém-instalada do Dr. Eggbot, o desenhista de agentes. Configura o pstack uma vez, garante que as duas rotinas de checagem existam e salva as preferências do dono.",
  },
  "openbot-curated-skill-distinctive-frontend-design": {
    description:
      "Dá a interfaces novas ou bastante redesenhadas uma direção visual deliberada, apoiada no assunto, no público, no conteúdo e no propósito. Não use para ajustes pequenos de estilo.",
  },
  "openbot-curated-skill-decision-quality-check": {
    description:
      "Acrescenta uma checagem própria breve e concreta a recomendações, estimativas, planos ou interpretações relevantes quando premissas não verificadas podem mudar o que o usuário faz.",
  },
  "openbot-curated-skill-data-quality-review": {
    description:
      "Inspeciona um conjunto de dados fornecido em busca de valores ausentes, duplicatas, unidades inconsistentes e limites da análise.",
  },
  "openbot-curated-skill-competitor-comparison": {
    description:
      "Compara produtos para uma necessidade específica do comprador, usando capacidades documentadas e o que não se sabe de forma explícita.",
  },
  "openbot-curated-skill-campaign-analysis": {
    description:
      "Analisa métricas de campanha fornecidas quanto a desempenho, lacunas de dados e próximos experimentos com base em evidência.",
  },
  "openbot-curated-skill-bug-triage": {
    description:
      "Transforma relato de bug, logs e passos de reprodução em um diagnóstico testável e em um plano de correção focado.",
  },
  "openbot-curated-skill-agent-designer": {
    description:
      "Desenha e cria um novo agente OpenBot. Faz algumas perguntas de preferência, escreve um perfil enxuto, chama create_agent e confere com read_agent. Agentes de código usam o pstack poteto-mode como barra de qualidade. Numa instalação nova, rode Eggbot Getting Started primeiro.",
  },
  "openbot-curated-skill-agent-chat-healthcheck": {
    description:
      "Audita as conversas recentes dos agentes locais do OpenBot em busca de atrito com o usuário, propõe habilidades, agentes ou rotinas a partir de correções repetidas ou roda a rotina fixa transcript-healthcheck.",
  },
  "openbot-curated-skill-account-brief": {
    description:
      "Transforma informações de empresa e de oportunidade em um briefing focado de pesquisa de conta para vendas.",
  },
};

/** The listing's own title and description in Portuguese, or the listing itself when it has none. */
export function localizedAgent<T extends { id: string; title: string; description: string }>(listing: T): T {
  const text = AGENTS[listing.id];
  return text ? { ...listing, title: text.title, description: text.description } : listing;
}

/** The skill's description in Portuguese, or the one it published when it has none. */
export function localizedSkill<T extends { id: string; description?: string | null }>(skill: T): T {
  const text = SKILLS[skill.id];
  if (!text) return skill;
  return { ...skill, description: text.description };
}
