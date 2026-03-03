import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadLocalEnv();

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  authToken: process.env.BACKEND_AUTH_TOKEN || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  openaiVisionModel: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
  openaiTextModel: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
  ocrServiceUrl: String(process.env.OCR_PIPELINE_URL || 'http://127.0.0.1:8788').trim().replace(/\/+$/, ''),
  ocrServiceTimeoutMs: Number(process.env.OCR_PIPELINE_TIMEOUT_MS || 90000),
  translationCacheTtlMs: Number(process.env.TRANSLATION_CACHE_TTL_MS || 86400000),
  enablePublicTranslationFallback: String(process.env.ENABLE_PUBLIC_TRANSLATION_FALLBACK || 'true') !== 'false'
};

const LIBRE_TRANSLATE_ENDPOINTS = [
  'https://libretranslate.de/translate',
  'https://translate.argosopentech.com/translate',
  'https://libretranslate.pussthecat.org/translate',
  'https://lt.vern.cc/translate'
];

const LOCAL_OCR_ENGINES = new Set(['auto', 'manga-stack', 'paddle', 'mangaocr', 'doctr']);
const SUPPORTED_OCR_ENGINES = [
  { id: 'auto', label: 'Stack manga auto' },
  { id: 'manga-stack', label: 'Stack manga auto' },
  { id: 'paddle', label: 'PaddleOCR' },
  { id: 'mangaocr', label: 'MangaOCR refine' },
  { id: 'doctr', label: 'docTR' },
  { id: 'gemini', label: 'Gemini Vision' },
  { id: 'openai', label: 'OpenAI Vision' }
];
const SUPPORTED_OCR_ENGINE_IDS = new Set(SUPPORTED_OCR_ENGINES.map(engine => engine.id));

const translationCache = new Map();

const OCR_PROMPT = `Tu es un expert en traduction de manga/manhwa.
Analyse cette image de bande dessinee coreenne ou japonaise.
Extrais TOUT le texte visible (bulles de dialogue, SFX, narration, onomatopees).
Traduis chaque texte de l'anglais vers le francais.

Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, avec cette structure :
{
  "blocks": [
    {
      "original": "texte original en anglais",
      "translated": "traduction en francais",
      "type": "dialogue|thought|sfx|narration|caption",
      "bbox": {
        "x": 0.12,
        "y": 0.18,
        "width": 0.34,
        "height": 0.11
      },
      "tone": "calm|tense|urgent|angry|sad|dramatic|playful|whisper|neutral",
      "style": {
        "align": "center|left|right",
        "lettering": "dialogue|narration|caption|sfx|handwritten|thought",
        "emphasis": "soft|normal|strong|extreme",
        "casing": "mixed|upper|lower",
        "italic": false,
        "weight": 700
      }
    }
  ]
}

Le champ bbox est obligatoire.
Les coordonnees sont normalisees entre 0 et 1 par rapport a l'image entiere.
x et y indiquent le coin haut-gauche du bloc.
Un bloc correspond a une bulle, une narration, ou un groupe de texte visuellement coherent.
Le bbox doit representer la zone disponible pour re-composer le texte francais a l'interieur de la bulle ou du cartouche.
Le bbox ne doit pas couvrir toute l'image, ni chevaucher inutilement une autre bulle.
La traduction doit respecter le ton, le sous-texte, l'intention dramatique, la relation entre les personnages et le rythme de lecture.
Cherche a rester fidele a la voix de l'auteur plutot qu'a faire une traduction mot a mot.

Si aucun texte n'est detecte, reponds : {"blocks": []}
Sois precis et naturel dans les traductions. Adapte les onomatopees au francais.`;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s([?.!,;:])/g, '$1')
    .trim();
}

function buildOcrPrompt(context) {
  if (!context) {
    return OCR_PROMPT;
  }

  const lines = [];

  if (context.pageTitle) {
    lines.push(`Titre de page: ${context.pageTitle}`);
  }

  if (Number.isFinite(context.currentImageIndex) && Number.isFinite(context.totalImages)) {
    lines.push(`Image courante: ${context.currentImageIndex + 1}/${context.totalImages}`);
  }

  if (Array.isArray(context.recentBlocks) && context.recentBlocks.length > 0) {
    lines.push('Contexte recent de la page:');
    context.recentBlocks.forEach((block, index) => {
      lines.push(
        `${index + 1}. [${block.type || 'dialogue'} | ${block.tone || 'neutral'}] ` +
        `EN="${block.original || ''}" | FR="${block.translated || ''}"`
      );
    });
  }

  if (Array.isArray(context.glossary) && context.glossary.length > 0) {
    lines.push('Glossaire deja stabilise:');
    context.glossary.forEach((entry, index) => {
      lines.push(`${index + 1}. EN="${entry.original}" => FR="${entry.translated}"`);
    });
  }

  if (context.chapterSummary?.dominantTones?.length) {
    lines.push(`Voix dominante du chapitre: ${context.chapterSummary.dominantTones.join(', ')}`);
  }

  return lines.length > 0
    ? `${OCR_PROMPT}\n\nContexte supplementaire:\n${lines.join('\n')}`
    : OCR_PROMPT;
}

function buildTranslationPrompt(text, context) {
  const lines = [
    'Traduis le texte anglais suivant en francais naturel pour un manga ou un manhwa.',
    'Reste fidele au ton, au registre, a la situation et a la voix de l auteur.',
    'Reponds uniquement avec la traduction finale, sans guillemets.',
    `Texte: ${text}`
  ];

  if (Array.isArray(context?.recentBlocks) && context.recentBlocks.length > 0) {
    lines.push('Contexte recent:');
    context.recentBlocks.slice(-6).forEach((block, index) => {
      lines.push(`${index + 1}. EN="${block.original}" | FR="${block.translated}"`);
    });
  }

  if (Array.isArray(context?.glossary) && context.glossary.length > 0) {
    lines.push('Glossaire a respecter:');
    context.glossary.slice(0, 8).forEach(entry => {
      lines.push(`- ${entry.original} => ${entry.translated}`);
    });
  }

  return lines.join('\n');
}

function normalizeBBox(rawBBox) {
  if (!rawBBox || typeof rawBBox !== 'object') return null;

  const x = Number(rawBBox.x);
  const y = Number(rawBBox.y);
  const width = Number(rawBBox.width);
  const height = Number(rawBBox.height);

  if (![x, y, width, height].every(Number.isFinite)) {
    return null;
  }

  const safe = {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0, Math.min(1, width)),
    height: Math.max(0, Math.min(1, height))
  };

  if (safe.width <= 0 || safe.height <= 0) {
    return null;
  }

  return safe;
}

function normalizeStyle(rawStyle) {
  if (!rawStyle || typeof rawStyle !== 'object') return null;

  const style = {};
  if (typeof rawStyle.align === 'string') style.align = rawStyle.align;
  if (typeof rawStyle.lettering === 'string') style.lettering = rawStyle.lettering;
  if (typeof rawStyle.emphasis === 'string') style.emphasis = rawStyle.emphasis;
  if (typeof rawStyle.casing === 'string') style.casing = rawStyle.casing;
  if (typeof rawStyle.italic === 'boolean') style.italic = rawStyle.italic;

  const weight = Number(rawStyle.weight);
  if (Number.isFinite(weight)) {
    style.weight = weight;
  }

  return Object.keys(style).length > 0 ? style : null;
}

function decodeJsonString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function parseLooseStyle(rawStyleText) {
  if (!rawStyleText) return null;

  const italicMatch = rawStyleText.match(/"italic"\s*:\s*(true|false)/);
  return normalizeStyle({
    align: rawStyleText.match(/"align"\s*:\s*"([^"]+)"/)?.[1],
    lettering: rawStyleText.match(/"lettering"\s*:\s*"([^"]+)"/)?.[1],
    emphasis: rawStyleText.match(/"emphasis"\s*:\s*"([^"]+)"/)?.[1],
    casing: rawStyleText.match(/"casing"\s*:\s*"([^"]+)"/)?.[1],
    italic: italicMatch ? italicMatch[1] === 'true' : undefined,
    weight: rawStyleText.match(/"weight"\s*:\s*(\d+)/)?.[1]
  });
}

function parseLooseBlocks(raw) {
  const blockStarts = [...raw.matchAll(/"original"\s*:/g)].map(match => match.index);
  if (blockStarts.length === 0) {
    return [];
  }

  const blocks = [];
  for (let index = 0; index < blockStarts.length; index++) {
    const start = blockStarts[index];
    const end = blockStarts[index + 1] ?? raw.length;
    const segment = raw.slice(start, end);
    const originalMatch = segment.match(/"original"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    const translatedMatch = segment.match(/"translated"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    if (!originalMatch || !translatedMatch) {
      continue;
    }

    const bboxMatch = segment.match(
      /"bbox"\s*:\s*\{[\s\S]*?"x"\s*:\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*,[\s\S]*?"y"\s*:\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*,[\s\S]*?"width"\s*:\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*,[\s\S]*?"height"\s*:\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/s
    );
    const styleMatch = segment.match(/"style"\s*:\s*\{([\s\S]*?)\}/s);

    blocks.push({
      original: decodeJsonString(originalMatch[1]),
      translated: decodeJsonString(translatedMatch[1]),
      type: segment.match(/"type"\s*:\s*"([^"]+)"/)?.[1] || 'dialogue',
      bbox: bboxMatch
        ? normalizeBBox({
            x: bboxMatch[1],
            y: bboxMatch[2],
            width: bboxMatch[3],
            height: bboxMatch[4]
          })
        : null,
      tone: segment.match(/"tone"\s*:\s*"([^"]+)"/)?.[1] || 'neutral',
      style: parseLooseStyle(styleMatch?.[1] || '')
    });
  }

  return blocks.filter(block => block.original && block.translated);
}

function parseAiResponse(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.blocks)) {
      return parsed.blocks
        .map(normalizeIncomingBlock)
        .filter(Boolean);
    }
  } catch {
    const recovered = parseLooseBlocks(raw);
    if (recovered.length > 0) {
      return recovered.map(normalizeIncomingBlock).filter(Boolean);
    }
  }

  return parseLooseBlocks(raw).map(normalizeIncomingBlock).filter(Boolean);
}

function normalizeIncomingBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const original = normalizeText(block.original || block.text || '');
  const translated = normalizeText(block.translated || block.translation || '');
  const bbox = normalizeBBox(block.bbox || block.box);

  if (!original || !bbox) {
    return null;
  }

  const confidence = Number(block.confidence);
  return {
    original,
    translated,
    type: typeof block.type === 'string' ? block.type : 'dialogue',
    bbox,
    tone: typeof block.tone === 'string' ? block.tone : 'neutral',
    style: normalizeStyle(block.style),
    confidence: Number.isFinite(confidence) ? confidence : null,
    sourceEngine: typeof block.sourceEngine === 'string'
      ? block.sourceEngine
      : (typeof block.engine === 'string' ? block.engine : null)
  };
}

function normalizeBlockList(blocks) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map(normalizeIncomingBlock)
    .filter(Boolean)
    .sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
}

function translateCommonTerms(text) {
  const dictionary = {
    huh: 'hein',
    what: 'quoi',
    hey: 'he',
    wait: 'attends',
    stop: 'arrete',
    no: 'non',
    yes: 'oui',
    really: 'vraiment',
    seriously: 'serieusement',
    damn: 'merde',
    shit: 'merde',
    please: "s'il te plait",
    sorry: 'pardon',
    thanks: 'merci',
    'thank you': 'merci',
    attack: 'attaque',
    defense: 'defense',
    skill: 'technique',
    'young master': 'jeune maitre',
    master: 'maitre',
    king: 'roi',
    emperor: 'empereur',
    die: 'meurs',
    kill: 'tuer',
    run: 'courir',
    look: 'regarder',
    see: 'voir',
    come: 'viens',
    go: 'aller',
    how: 'comment',
    why: 'pourquoi',
    where: 'ou',
    who: 'qui',
    'how dare you': 'comment oses-tu',
    'dont move': 'ne bouge pas',
    'watch out': 'attention'
  };

  const normalized = String(text || '').toLowerCase().trim();
  const translated = dictionary[normalized];
  if (!translated) {
    return null;
  }

  if (text === text.toUpperCase()) {
    return translated.toUpperCase();
  }
  if (text[0] === text[0]?.toUpperCase()) {
    return translated.charAt(0).toUpperCase() + translated.slice(1);
  }
  return translated;
}

function looksMostlyEnglish(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/[àâçéèêëîïôûùüÿœæ]/i.test(value)) return false;
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(value)) return false;

  const commonWords = /\b(the|you|your|what|why|when|where|how|sure|plan|chance|silence|dramatic|pause|corridor|city|sky|keep|running|away)\b/i;
  return commonWords.test(value);
}

function needsTranslation(block) {
  const original = normalizeText(block?.original);
  const translated = normalizeText(block?.translated);
  if (!original) return false;
  if (!translated) return true;
  if (translated.toLowerCase() === original.toLowerCase()) return true;
  return looksMostlyEnglish(translated);
}

function getTranslationCacheKey(text, target = 'fr') {
  return `${target}:${String(text || '').trim().toLowerCase()}`;
}

function getCachedTranslation(key) {
  const cached = translationCache.get(key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.timestamp > config.translationCacheTtlMs) {
    translationCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedTranslation(key, value) {
  translationCache.set(key, {
    value,
    timestamp: Date.now()
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function assertAuth(req) {
  if (!config.authToken) {
    return true;
  }

  const authHeader = req.headers.authorization || '';
  return authHeader === `Bearer ${config.authToken}`;
}

async function fetchOcrService(path, body) {
  if (!config.ocrServiceUrl) {
    return null;
  }

  const response = await fetchJsonWithTimeout(`${config.ocrServiceUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  }, config.ocrServiceTimeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OCR pipeline ${response.status}: ${text || 'unknown error'}`);
  }

  return response.json();
}

async function translateWithLocalModel(text, source = 'en', target = 'fr') {
  if (!config.ocrServiceUrl) {
    return null;
  }

  try {
    const payload = await fetchOcrService('/translate/local', {
      text,
      source,
      target
    });
    return normalizeText(payload?.translation || '');
  } catch {
    return null;
  }
}

async function translateManyWithLocalModel(texts, source = 'en', target = 'fr') {
  const normalizedTexts = [...new Set((texts || []).map(text => normalizeText(text)).filter(Boolean))];
  if (!config.ocrServiceUrl || normalizedTexts.length === 0) {
    return new Map();
  }

  try {
    const payload = await fetchOcrService('/translate/local-batch', {
      texts: normalizedTexts,
      source,
      target
    });
    const translations = Array.isArray(payload?.translations) ? payload.translations : [];
    const results = new Map();
    normalizedTexts.forEach((text, index) => {
      const translated = normalizeText(translations[index] || '');
      if (translated) {
        results.set(text, translated);
      }
    });
    return results;
  } catch {
    return new Map();
  }
}

async function getOcrServiceHealth() {
  if (!config.ocrServiceUrl) {
    return {
      configured: false,
      ok: false
    };
  }

  try {
    const response = await fetchJsonWithTimeout(`${config.ocrServiceUrl}/health`, {
      headers: { 'Accept': 'application/json' }
    }, 3000);

    const payload = await response.json().catch(() => ({}));
    return {
      configured: true,
      ok: response.ok,
      url: config.ocrServiceUrl,
      payload
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      url: config.ocrServiceUrl,
      error: error.message
    };
  }
}

async function translateWithGemini(text, context) {
  if (!config.geminiApiKey) {
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
  const response = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: buildTranslationPrompt(text, context) }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 256
      }
    })
  }, 12000);

  if (!response.ok) {
    throw new Error(`Gemini translation ${response.status}`);
  }

  const data = await response.json();
  return normalizeText(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function translateWithOpenAI(text, context) {
  if (!config.openaiApiKey) {
    return null;
  }

  const response = await fetchJsonWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiTextModel,
      messages: [{
        role: 'user',
        content: buildTranslationPrompt(text, context)
      }],
      temperature: 0.1,
      max_tokens: 256
    })
  }, 12000);

  if (!response.ok) {
    throw new Error(`OpenAI translation ${response.status}`);
  }

  const data = await response.json();
  return normalizeText(data.choices?.[0]?.message?.content || '');
}

async function translateWithLibre(text) {
  if (!config.enablePublicTranslationFallback) {
    return null;
  }

  for (const endpoint of LIBRE_TRANSLATE_ENDPOINTS) {
    try {
      const response = await fetchJsonWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          q: text,
          source: 'en',
          target: 'fr',
          format: 'text'
        })
      }, 8000);

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      if (data?.translatedText && data.translatedText !== text) {
        return normalizeText(data.translatedText);
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function translateWithMyMemory(text) {
  if (!config.enablePublicTranslationFallback) {
    return null;
  }

  try {
    const encoded = encodeURIComponent(text);
    const response = await fetchJsonWithTimeout(
      `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|fr`,
      {
        headers: { 'Accept': 'application/json' }
      },
      8000
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data?.responseStatus === 200 && data.responseData?.translatedText) {
      return normalizeText(data.responseData.translatedText);
    }
  } catch {
    return null;
  }

  return null;
}

async function translateText(text, context) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const common = translateCommonTerms(normalized);
  if (common) {
    return common;
  }

  const localTranslation = await translateWithLocalModel(normalized, 'en', 'fr');
  if (localTranslation) {
    return localTranslation;
  }

  if (config.openaiApiKey) {
    try {
      const translated = await translateWithOpenAI(normalized, context);
      if (translated) return translated;
    } catch {}
  }

  if (config.geminiApiKey) {
    try {
      const translated = await translateWithGemini(normalized, context);
      if (translated) return translated;
    } catch {}
  }

  return (
    await translateWithMyMemory(normalized) ||
    await translateWithLibre(normalized) ||
    null
  );
}

async function translateTextCached(text, context) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const cacheKey = getTranslationCacheKey(normalized);
  const cached = getCachedTranslation(cacheKey);
  if (cached) {
    return cached;
  }

  const translated = await translateText(normalized, context);
  if (translated) {
    setCachedTranslation(cacheKey, translated);
  }
  return translated;
}

async function ensureTranslatedBlocks(blocks, context) {
  const orderedBlocks = normalizeBlockList(blocks);
  const uniqueTexts = [...new Set(
    orderedBlocks
      .filter(block => needsTranslation(block))
      .map(block => normalizeText(block.original))
      .filter(Boolean)
  )];
  const translationMap = new Map();
  const missingTexts = [];

  uniqueTexts.forEach(text => {
    const common = translateCommonTerms(text);
    if (common) {
      translationMap.set(text, common);
      return;
    }

    const cached = getCachedTranslation(getTranslationCacheKey(text));
    if (cached) {
      translationMap.set(text, cached);
      return;
    }

    missingTexts.push(text);
  });

  const localTranslations = await translateManyWithLocalModel(missingTexts, 'en', 'fr');
  for (const text of missingTexts) {
    const translated = localTranslations.get(text);
    if (translated) {
      translationMap.set(text, translated);
      setCachedTranslation(getTranslationCacheKey(text), translated);
    }
  }

  const unresolvedTexts = missingTexts.filter(text => !translationMap.has(text));
  await Promise.all(unresolvedTexts.map(async text => {
    const translated = await translateText(text, context);
    if (translated) {
      translationMap.set(text, translated);
      setCachedTranslation(getTranslationCacheKey(text), translated);
    }
  }));

  return orderedBlocks.map(block => {
    const nextBlock = { ...block };
    if (needsTranslation(nextBlock)) {
      nextBlock.translated =
        translationMap.get(normalizeText(nextBlock.original)) ||
        nextBlock.translated ||
        nextBlock.original;
    }
    if (!nextBlock.translated) {
      nextBlock.translated = nextBlock.original;
    }
    return nextBlock;
  });
}

async function ocrWithLocalPipeline(image, ocrEngine, context) {
  if (!config.ocrServiceUrl) {
    return null;
  }

  const payload = await fetchOcrService('/ocr/manga', {
    image,
    ocrEngine,
    context
  });

  const blocks = normalizeBlockList(payload?.blocks || []);
  if (blocks.length === 0) {
    return null;
  }

  return {
    engine: payload?.engine || 'manga-stack',
    blocks,
    quality: payload?.quality || null,
    diagnostics: payload?.diagnostics || null
  };
}

function shouldEscalateLocalOcr(result, requestedEngine, hasVisionProvider) {
  if (!result || !hasVisionProvider) {
    return false;
  }

  if (!['auto', 'manga-stack'].includes(requestedEngine)) {
    return false;
  }

  return !!result?.quality?.needsVisionFallback;
}

async function ocrWithGemini(image, context) {
  if (!config.geminiApiKey) {
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
  const response = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: buildOcrPrompt(context) },
          {
            inline_data: {
              mime_type: image.mimeType,
              data: image.base64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json'
      }
    })
  }, 45000);

  if (!response.ok) {
    throw new Error(`Gemini OCR ${response.status}`);
  }

  const data = await response.json();
  return normalizeBlockList(parseAiResponse(data.candidates?.[0]?.content?.parts?.[0]?.text || ''));
}

async function ocrWithOpenAI(image, context) {
  if (!config.openaiApiKey) {
    return null;
  }

  const response = await fetchJsonWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiVisionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildOcrPrompt(context) },
          {
            type: 'image_url',
            image_url: {
              url: `data:${image.mimeType};base64,${image.base64}`,
              detail: 'high'
            }
          }
        ]
      }],
      temperature: 0.1,
      max_tokens: 2048
    })
  }, 45000);

  if (!response.ok) {
    throw new Error(`OpenAI OCR ${response.status}`);
  }

  const data = await response.json();
  return normalizeBlockList(parseAiResponse(data.choices?.[0]?.message?.content || ''));
}

async function runAiOcr(image, ocrEngine, context) {
  const normalizedEngine = typeof ocrEngine === 'string' ? ocrEngine.trim() : '';
  const requestedEngine = SUPPORTED_OCR_ENGINE_IDS.has(normalizedEngine) ? normalizedEngine : 'auto';
  const providers = [];
  const hasVisionProvider = !!(config.geminiApiKey || config.openaiApiKey);
  let bestLocalResult = null;

  if (LOCAL_OCR_ENGINES.has(requestedEngine) && config.ocrServiceUrl) {
    providers.push([
      requestedEngine === 'auto' ? 'manga-stack' : requestedEngine,
      async () => ocrWithLocalPipeline(image, requestedEngine, context)
    ]);
  }

  if ((requestedEngine === 'auto' || requestedEngine === 'gemini') && config.geminiApiKey) {
    providers.push([
      'Gemini',
      async () => ({ engine: 'Gemini', blocks: await ocrWithGemini(image, context) })
    ]);
  }

  if ((requestedEngine === 'auto' || requestedEngine === 'openai') && config.openaiApiKey) {
    providers.push([
      'OpenAI',
      async () => ({ engine: 'OpenAI', blocks: await ocrWithOpenAI(image, context) })
    ]);
  }

  if (providers.length === 0) {
    const error = new Error('Aucun moteur OCR backend configure pour cette requete');
    error.statusCode = 503;
    throw error;
  }

  for (const [name, run] of providers) {
    try {
      const result = await run();
      const blocks = normalizeBlockList(result?.blocks || []);
      if (blocks.length === 0) {
        continue;
      }

      const normalizedResult = {
        engine: result?.engine || name,
        blocks: await ensureTranslatedBlocks(blocks, context),
        quality: result?.quality || null,
        diagnostics: result?.diagnostics || null
      };

      if (LOCAL_OCR_ENGINES.has(requestedEngine) && shouldEscalateLocalOcr(normalizedResult, requestedEngine, hasVisionProvider)) {
        bestLocalResult = normalizedResult;
        continue;
      }

      return normalizedResult;
    } catch {
      continue;
    }
  }

  if (bestLocalResult) {
    return bestLocalResult;
  }

  return { engine: 'backend', blocks: [] };
}

async function handleTranslate(req, res, body) {
  if (!assertAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const text = normalizeText(body?.text);
  if (!text) {
    return sendJson(res, 400, { error: 'Missing text' });
  }

  const translation = await translateTextCached(text, body?.context || null);
  return sendJson(res, 200, { translation });
}

async function runWithConcurrency(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex;
      nextIndex += 1;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  );
  return results;
}

async function handleBatchTranslate(req, res, body) {
  if (!assertAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const rawTexts = Array.isArray(body?.texts) ? body.texts : [];
  const texts = rawTexts.filter(t => typeof t === 'string' && t.trim().length > 0);
  const context = body?.context || null;

  if (texts.length === 0) {
    return sendJson(res, 400, { error: 'Missing texts array' });
  }

  if (texts.length > 50) {
    return sendJson(res, 400, { error: 'Batch size exceeds limit of 50' });
  }

  const tasks = texts.map(text => () => translateTextCached(normalizeText(text), context));
  const results = await runWithConcurrency(tasks, 5);

  return sendJson(res, 200, { translations: results });
}

async function handleAiOcr(req, res, body) {
  if (!assertAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (!body?.image?.base64 || !body?.image?.mimeType) {
    return sendJson(res, 400, { error: 'Missing image payload' });
  }

  try {
    const result = await runAiOcr(body.image, body.ocrEngine || 'auto', body.context || null);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, { error: error.message });
  }
}

async function handleHealth(res) {
  const ocrPipeline = await getOcrServiceHealth();
  return sendJson(res, 200, {
    ok: true,
    userApiKeysRequired: false,
    policy: {
      ocrPrimary: 'local-manga-stack',
      visionFallback: ['gemini', 'openai'],
      translation: 'server-managed'
    },
    providers: {
      gemini: !!config.geminiApiKey,
      openai: !!config.openaiApiKey
    },
    ocrPipeline,
    publicTranslationFallback: config.enablePublicTranslationFallback
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health' && req.method === 'GET') {
    return handleHealth(res);
  }

  if (req.url === '/v1/ocr/engines' && req.method === 'GET') {
    return sendJson(res, 200, {
      engines: SUPPORTED_OCR_ENGINES
    });
  }

  let body = {};
  try {
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  if (req.url === '/v1/translate' && req.method === 'POST') {
    return handleTranslate(req, res, body);
  }

  if (req.url === '/v1/translate-batch' && req.method === 'POST') {
    return handleBatchTranslate(req, res, body);
  }

  if (req.url === '/v1/ai-ocr' && req.method === 'POST') {
    return handleAiOcr(req, res, body);
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(config.port, config.host, () => {
  console.log(`Manwha backend listening on http://${config.host}:${config.port}`);
});
