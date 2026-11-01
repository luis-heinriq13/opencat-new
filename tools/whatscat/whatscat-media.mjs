// WhatsCat: o que o agente "entende" de áudio, imagem e PDF, tudo neste computador.
// Áudio: ffmpeg + o reconhecimento de voz local do OpenCat. PDF: pdftotext (OCR se vier vazio). Imagem: tesseract
// + cópia da imagem numa pasta do agente. O texto extraído é DADO de terceiro, nunca instrução.
import { execFile, fork } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MEDIA_CAPS = { audio: 25 * 1024 * 1024, pdf: 20 * 1024 * 1024, image: 10 * 1024 * 1024 };
export const MAX_EXTRACTED_CHARS = 12_000;
const COMMAND_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 240_000;
const MAX_AUDIO_SECONDS = 600;

/** Que tipo de arquivo é esta mensagem para o processamento: "audio", "image", "pdf" ou null. */
export function mediaKind(message) {
  const type = String(message?.mediaType ?? "").toLowerCase();
  const name = String(message?.filename ?? "").toLowerCase();
  if (["audio", "voice", "ptt"].includes(type)) return "audio";
  if (type === "image" || type === "photo") return "image";
  if (type === "pdf" || name.endsWith(".pdf")) return "pdf";
  return null;
}

/** Textos curtos e fixos que o agente lê quando algo falha. Nunca levam caminho nem mensagem de erro do sistema. */
export const FAILURE_TEXT = {
  grande_demais: "O arquivo passa do tamanho que a ponte aceita.",
  indisponivel: "O WhatsApp não entregou o arquivo.",
  sem_ffmpeg: "O conversor de áudio (ffmpeg) não está instalado neste computador.",
  transcricao_indisponivel: "O reconhecimento de voz local não está disponível neste computador.",
  transcricao_falhou: "O reconhecimento de voz não conseguiu entender o áudio.",
  sem_pdftotext: "O leitor de PDF (pdftotext) não está instalado neste computador.",
  pdf_sem_texto: "O PDF não tem texto legível, nem por OCR.",
  sem_tesseract: "O leitor de imagem (tesseract) não está instalado neste computador.",
  imagem_sem_texto: "A imagem não tem texto legível (ela pode ser só uma foto).",
  erro: "Não foi possível ler o arquivo.",
};

const cut = (text) => {
  const clean = String(text ?? "")
    .split("\0")
    .join("")
    .trim();
  return clean.length > MAX_EXTRACTED_CHARS
    ? { texto: clean.slice(0, MAX_EXTRACTED_CHARS), truncado: true }
    : { texto: clean, truncado: false };
};

/** Roda um programa sem shell, com tempo limite. Devolve o stdout (Buffer). Lança com o código de falha. */
export function runProgram(file, args, { timeoutMs = COMMAND_TIMEOUT_MS, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer, encoding: "buffer", windowsHide: true }, (error, stdout) => {
      if (error) reject(Object.assign(new Error("falha"), { code: error.code }));
      else resolve(stdout);
    });
  });
}

const FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const tool = (name, env = process.env) => {
  const folders = [...(env.PATH ?? "").split(":"), ...FOLDERS].filter(Boolean);
  return folders.map((folder) => join(folder, name)).find((candidate) => existsSync(candidate)) ?? null;
};

/**
 * O reconhecimento de voz do OpenCat roda num processo à parte (o mesmo `voice-transcription-host.js`, que só usa
 * módulos do Node e aceita ser iniciado com `fork`). O aplicativo informa os caminhos em OPENCAT_VOICE_HOST e
 * OPENCAT_VOICE_RUNTIME. Prefere o Whisper (português); cai no Parakeet. Sem eles, falha: não finge transcrever.
 */
export function createLocalTranscriber({ env = process.env, forkImpl = fork, exists = existsSync } = {}) {
  return (pcm) =>
    new Promise((resolve, reject) => {
      const fail = (code) => reject(Object.assign(new Error(code), { code }));
      const host = env.OPENCAT_VOICE_HOST;
      const runtime = env.OPENCAT_VOICE_RUNTIME;
      if (!host || !runtime || !exists(host)) return fail("transcricao_indisponivel");
      const addonPath = join(runtime, "sherpa-onnx.node");
      const models =
        env.OPENCAT_VOICE_MODELS || join(homedir(), "Library", "Application Support", "OpenBot", "runtimes");
      const whisper = join(models, "whisper-turbo-int8");
      const parakeet = join(models, "parakeet-tdt-0.6b-v3-int8");
      const useWhisper = exists(whisper);
      if (!exists(addonPath) || (!useWhisper && !exists(parakeet))) return fail("transcricao_indisponivel");
      let settled = false;
      const child = forkImpl(host, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        action();
      };
      const timer = setTimeout(() => finish(() => fail("transcricao_falhou")), TRANSCRIBE_TIMEOUT_MS);
      child.on("message", (response) => {
        if (typeof response?.text === "string") finish(() => resolve(response.text));
        else finish(() => fail("transcricao_falhou"));
      });
      child.on("error", () => finish(() => fail("transcricao_indisponivel")));
      child.on("exit", () => finish(() => fail("transcricao_falhou")));
      child.send({
        id: 1,
        addonPath,
        modelDirectory: useWhisper ? whisper : parakeet,
        engine: useWhisper ? "whisper" : "nemo-transducer",
        language: useWhisper ? "pt" : "",
        leadingSilenceSamples: 0,
        pcm: new Uint8Array(pcm),
      });
    });
}

/**
 * `file` é o arquivo já baixado e dentro de uma pasta privada do contato; `visionFolder`, se houver, é uma pasta
 * dentro do workspace do agente onde a imagem é copiada. Devolve { texto, truncado, copia } ou { falha }.
 */
export function createMediaExtractor({
  run = runProgram,
  transcribe = createLocalTranscriber(),
  env = process.env,
  find = (name) => tool(name, env),
} = {}) {
  async function audio(file) {
    const ffmpeg = find("ffmpeg");
    if (!ffmpeg) return { falha: "sem_ffmpeg" };
    let pcm;
    try {
      pcm = await run(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        file,
        "-t",
        String(MAX_AUDIO_SECONDS),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ]);
    } catch {
      return { falha: "erro" };
    }
    if (!pcm || pcm.length < 3200) return { falha: "transcricao_falhou" };
    try {
      const text = String(await transcribe(pcm)).trim();
      return text ? cut(text) : { falha: "transcricao_falhou" };
    } catch (error) {
      return { falha: error?.code === "transcricao_indisponivel" ? "transcricao_indisponivel" : "transcricao_falhou" };
    }
  }

  async function ocr(file) {
    const tesseract = find("tesseract");
    if (!tesseract) return { falha: "sem_tesseract" };
    try {
      return String(await run(tesseract, [file, "stdout", "-l", "eng"], { timeoutMs: COMMAND_TIMEOUT_MS })).trim();
    } catch {
      return { falha: "erro" };
    }
  }

  async function pdf(file, workFolder) {
    const pdftotext = find("pdftotext");
    if (!pdftotext) return { falha: "sem_pdftotext" };
    let text = "";
    try {
      text = String(await run(pdftotext, ["-l", "40", "-layout", "-enc", "UTF-8", file, "-"])).trim();
    } catch {
      return { falha: "erro" };
    }
    if (text) return cut(text);
    // PDF escaneado: rasteriza as primeiras páginas e lê com OCR.
    const pdftoppm = find("pdftoppm");
    if (!pdftoppm) return { falha: "pdf_sem_texto" };
    const prefix = join(workFolder, `ocr-${basename(file)}`);
    const pages = [];
    try {
      await run(pdftoppm, ["-r", "150", "-f", "1", "-l", "3", "-png", file, prefix]);
      for (const name of readdirSync(workFolder).filter((item) => item.startsWith(`ocr-${basename(file)}`))) {
        pages.push(join(workFolder, name));
      }
      const parts = [];
      for (const page of pages.sort()) {
        const read = await ocr(page);
        if (typeof read === "string" && read) parts.push(read);
      }
      return parts.length ? cut(parts.join("\n\n")) : { falha: "pdf_sem_texto" };
    } catch {
      return { falha: "pdf_sem_texto" };
    } finally {
      for (const page of pages) rmSync(page, { force: true });
    }
  }

  return async function extract({ kind, file, workFolder, visionFolder }) {
    if (kind === "audio") return audio(file);
    if (kind === "pdf") return pdf(file, workFolder);
    if (kind === "image") {
      let copia = null;
      if (visionFolder) {
        try {
          mkdirSync(visionFolder, { recursive: true, mode: 0o700 });
          copia = join(visionFolder, basename(file));
          copyFileSync(file, copia);
        } catch {
          copia = null;
        }
      }
      const read = await ocr(file);
      if (typeof read === "object") return { ...read, ...(copia ? { copia } : {}) };
      // Sem texto na imagem não é falha: uma foto pode ser lida por um modelo com visão, pela cópia.
      return read ? { ...cut(read), ...(copia ? { copia } : {}) } : { texto: "", truncado: false, copia };
    }
    return { falha: "erro" };
  };
}

/** Apaga arquivos com mais de `days` dias numa pasta e nas subpastas. Devolve quantos apagou. */
export function pruneOldFiles(root, days, now = Date.now()) {
  let removed = 0;
  const limit = now - days * 86_400_000;
  const walk = (folder) => {
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) walk(path);
        else if (info.mtimeMs < limit) {
          rmSync(path, { force: true });
          removed += 1;
        }
      } catch {
        // O arquivo sumiu no meio do caminho.
      }
    }
  };
  walk(root);
  return removed;
}
