#!/usr/bin/env node
// WhatsApp Business oficial (Cloud API da Meta) para os agentes do OpenCat.
import { homedir } from "node:os";
import { join } from "node:path";
import { createSendLimiter, serveMcp, toolText } from "./mcp-stdio.mjs";

const token = process.env.WHATSAPP_TOKEN?.trim();
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
const accountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim();
const apiBase = (process.env.WHATSAPP_API_BASE?.trim() || "https://graph.facebook.com/v23.0").replace(/\/$/, "");

const limiter = createSendLimiter({
  file: join(homedir(), ".opencat", "whatsapp-oficial", "limites.json"),
  minGapMs: 1_000,
  perHour: 1_000,
  perDay: 5_000,
});

async function graph(path, init = {}) {
  if (!token || !phoneNumberId) throw new Error("Faltam o token e o ID do número. Conecte o app na loja do OpenCat.");
  const response = await fetch(`${apiBase}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = body?.error;
    throw new Error(
      `A Meta recusou (${response.status}): ${failure?.message ?? "sem detalhe"} [código ${failure?.code ?? "?"}]`,
    );
  }
  return body;
}

function phone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15)
    throw new Error("Número inválido. Use o formato internacional, como 5511999998888.");
  return digits;
}

async function sendMessage(payload) {
  const wait = limiter.check();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const result = await graph(`${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  limiter.record();
  return toolText(JSON.stringify({ enviado: true, id: result.messages?.[0]?.id ?? null }));
}

const TOOLS = [
  {
    name: "whatsapp_status",
    description: "Mostra o número conectado, o nome verificado e a qualidade da conta. Não envia nada.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whatsapp_enviar_texto",
    description:
      "Envia texto a quem falou com o número nas últimas 24 horas. Fora dessa janela, a Meta exige um modelo aprovado: use whatsapp_enviar_modelo.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string", description: "Número no formato internacional, só dígitos" },
        texto: { type: "string", description: "Texto da mensagem, até 4096 caracteres" },
      },
      required: ["para", "texto"],
    },
  },
  {
    name: "whatsapp_enviar_modelo",
    description: "Envia um modelo aprovado pela Meta. Use para iniciar conversa. A Meta cobra por modelo enviado.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string" },
        modelo: { type: "string", description: "Nome do modelo aprovado" },
        idioma: { type: "string", description: "Código do idioma, como pt_BR" },
        parametros: {
          type: "array",
          items: { type: "string" },
          description: "Valores das variáveis do corpo, em ordem",
        },
      },
      required: ["para", "modelo", "idioma"],
    },
  },
  {
    name: "whatsapp_listar_modelos",
    description: "Lista os modelos da conta com nome, idioma e situação. Pede o ID da conta comercial na conexão.",
    inputSchema: { type: "object", properties: {} },
  },
];

serveMcp({
  name: "whatsapp-oficial",
  version: "1.0.0",
  listTools: () => TOOLS,
  callTool: async (name, args) => {
    if (name === "whatsapp_status") {
      const data = await graph(`${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating`);
      return toolText(JSON.stringify({ ...data, limites: limiter.usage() }));
    }
    if (name === "whatsapp_enviar_texto") {
      const text = String(args.texto ?? "");
      if (!text.trim() || text.length > 4096) throw new Error("O texto precisa ter de 1 a 4096 caracteres.");
      return sendMessage({ to: phone(args.para), type: "text", text: { body: text } });
    }
    if (name === "whatsapp_enviar_modelo") {
      const parameters = Array.isArray(args.parametros) ? args.parametros : [];
      return sendMessage({
        to: phone(args.para),
        type: "template",
        template: {
          name: String(args.modelo ?? ""),
          language: { code: String(args.idioma ?? "") },
          ...(parameters.length
            ? {
                components: [
                  { type: "body", parameters: parameters.map((text) => ({ type: "text", text: String(text) })) },
                ],
              }
            : {}),
        },
      });
    }
    if (name === "whatsapp_listar_modelos") {
      if (!accountId) throw new Error("Falta o ID da conta comercial. Conecte o app de novo e preencha esse campo.");
      const data = await graph(`${accountId}/message_templates?fields=name,language,status,category&limit=100`);
      return toolText(JSON.stringify(data.data ?? []));
    }
    throw new Error(`Ferramenta desconhecida: ${name}`);
  },
});
