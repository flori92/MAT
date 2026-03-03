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
  ocrServiceUrl: String(process.env.OCR_PIPELINE_URL || 'http://127.0.0.1:8788').trim().replace(/\/+$/, ''),
  ocrServiceTimeoutMs: Number(process.env.OCR_PIPELINE_TIMEOUT_MS || 120000),
  translationCacheTtlMs: Number(process.env.TRANSLATION_CACHE_TTL_MS || 86400000)
};

const SUPPORTED_OCR_ENGINES = [
  { id: 'auto', label: 'Stack manga auto' },
  { id: 'manga-stack', label: 'Stack manga auto' },
  { id: 'paddle', label: 'PaddleOCR' },
  { id: 'mangaocr', label: 'MangaOCR refine' },
  { id: 'doctr', label: 'docTR' }
];
const SUPPORTED_OCR_ENGINE_IDS = new Set(SUPPORTED_OCR_ENGINES.map(engine => engine.id));

const translationCache = new Map();
const OCR_HEALTH_TTL_MS = Number(process.env.OCR_HEALTH_TTL_MS || 15000);
const OCR_HEALTH_TIMEOUT_MS = Number(process.env.OCR_HEALTH_TIMEOUT_MS || 2500);
let ocrHealthCache = null;
let ocrHealthRefreshPromise = null;

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

function normalizeIncomingBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const original = normalizeText(block.original || block.text || '');
  const translated = normalizeText(block.translated || block.translation || '');
  const bbox = normalizeBBox(block.bbox || block.box);

  if (!original) {
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
    .sort((a, b) => {
      const ay = a.bbox?.y ?? 1;
      const by = b.bbox?.y ?? 1;
      const ax = a.bbox?.x ?? 1;
      const bx = b.bbox?.x ?? 1;
      return (ay - by) || (ax - bx);
    });
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

async function probeOcrServiceHealth() {
  if (!config.ocrServiceUrl) {
    return {
      configured: false,
      ok: false
    };
  }

  try {
    const response = await fetchJsonWithTimeout(`${config.ocrServiceUrl}/health`, {
      headers: { 'Accept': 'application/json' }
    }, OCR_HEALTH_TIMEOUT_MS);

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

function refreshOcrServiceHealth() {
  if (ocrHealthRefreshPromise) {
    return ocrHealthRefreshPromise;
  }

  ocrHealthRefreshPromise = probeOcrServiceHealth()
    .then(value => {
      ocrHealthCache = {
        timestamp: Date.now(),
        value
      };
      return value;
    })
    .finally(() => {
      ocrHealthRefreshPromise = null;
    });

  return ocrHealthRefreshPromise;
}

function getOcrServiceHealthSnapshot() {
  if (!config.ocrServiceUrl) {
    return {
      configured: false,
      ok: false
    };
  }

  const now = Date.now();
  const isFresh = ocrHealthCache && (now - ocrHealthCache.timestamp) < OCR_HEALTH_TTL_MS;

  if (isFresh) {
    return {
      ...ocrHealthCache.value,
      stale: false,
      refreshing: !!ocrHealthRefreshPromise
    };
  }

  refreshOcrServiceHealth().catch(() => {});

  if (ocrHealthCache?.value) {
    return {
      ...ocrHealthCache.value,
      stale: true,
      refreshing: true
    };
  }

  return {
    configured: true,
    ok: false,
    url: config.ocrServiceUrl,
    stale: true,
    refreshing: true,
    warmingUp: true
  };
}

async function translateWithArgos(text) {
  if (!config.ocrServiceUrl) return null;
  try {
    const payload = await fetchOcrService('/translate/argos', { text, source: 'en', target: 'fr' });
    return normalizeText(payload?.translation || '');
  } catch {
    return null;
  }
}

async function translateText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const common = translateCommonTerms(normalized);
  if (common) return common;

  const localTranslation = await translateWithLocalModel(normalized, 'en', 'fr');
  if (localTranslation) return localTranslation;

  const argosTranslation = await translateWithArgos(normalized);
  if (argosTranslation) return argosTranslation;

  return null;
}

async function translateTextCached(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const cacheKey = getTranslationCacheKey(normalized);
  const cached = getCachedTranslation(cacheKey);
  if (cached) return cached;

  const translated = await translateText(normalized);
  if (translated) setCachedTranslation(cacheKey, translated);
  return translated;
}

async function ensureTranslatedBlocks(blocks) {
  const orderedBlocks = normalizeBlockList(blocks);
  const uniqueTexts = [...new Set(
    orderedBlocks
      .filter(block => needsTranslation(block))
      .map(block => normalizeText(block.original))
      .filter(Boolean)
  )];

  if (uniqueTexts.length === 0) return orderedBlocks;

  const translationMap = new Map();
  const missingTexts = [];

  uniqueTexts.forEach(text => {
    const common = translateCommonTerms(text);
    if (common) { translationMap.set(text, common); return; }
    const cached = getCachedTranslation(getTranslationCacheKey(text));
    if (cached) { translationMap.set(text, cached); return; }
    missingTexts.push(text);
  });

  if (missingTexts.length > 0) {
    const localTranslations = await translateManyWithLocalModel(missingTexts, 'en', 'fr');
    for (const text of missingTexts) {
      const translated = localTranslations.get(text);
      if (translated) {
        translationMap.set(text, translated);
        setCachedTranslation(getTranslationCacheKey(text), translated);
      }
    }

    const stillMissing = missingTexts.filter(text => !translationMap.has(text));
    for (const text of stillMissing) {
      const translated = await translateTextCached(text);
      if (translated) translationMap.set(text, translated);
    }
  }

  return orderedBlocks.map(block => {
    const nextBlock = { ...block };
    if (needsTranslation(nextBlock)) {
      nextBlock.translated =
        translationMap.get(normalizeText(nextBlock.original)) ||
        nextBlock.translated ||
        nextBlock.original;
    }
    if (!nextBlock.translated) nextBlock.translated = nextBlock.original;
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

async function runAiOcr(image, ocrEngine, context) {
  const normalizedEngine = typeof ocrEngine === 'string' ? ocrEngine.trim() : '';
  const requestedEngine = SUPPORTED_OCR_ENGINE_IDS.has(normalizedEngine) ? normalizedEngine : 'auto';
  const log = (...args) => console.log('[OCR]', ...args);

  if (!config.ocrServiceUrl) {
    const error = new Error(
      'Pipeline OCR non configuré. Vérifiez OCR_PIPELINE_URL dans .env et démarrez le pipeline Python.'
    );
    error.statusCode = 503;
    throw error;
  }

  log(`Requête OCR engine=${requestedEngine} pipeline=${config.ocrServiceUrl}`);

  const t0 = Date.now();
  try {
    const result = await ocrWithLocalPipeline(image, requestedEngine, context);
    const elapsed = Date.now() - t0;

    if (result && result.blocks.length > 0) {
      log(`Pipeline → ${result.blocks.length} bloc(s), ${elapsed}ms`);
      // Le pipeline auto-traduit maintenant, mais on s'assure que tout est traduit
      const blocks = await ensureTranslatedBlocks(result.blocks);
      return { ...result, blocks };
    }

    log(`Pipeline → 0 blocs, ${elapsed}ms`);
    return { engine: 'pipeline', blocks: [], diagnostics: result?.diagnostics || {} };
  } catch (err) {
    log(`Pipeline erreur: ${err.message} (${Date.now() - t0}ms)`);
    throw Object.assign(new Error(`Pipeline OCR indisponible: ${err.message}`), { statusCode: 503 });
  }
}

async function handleTranslate(req, res, body) {
  if (!assertAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const text = normalizeText(body?.text);
  if (!text) {
    return sendJson(res, 400, { error: 'Missing text' });
  }

  const translation = await translateTextCached(text);
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

  const tasks = texts.map(text => () => translateTextCached(normalizeText(text)));
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

function handleHealth(res) {
  const ocrPipeline = getOcrServiceHealthSnapshot();
  return sendJson(res, 200, {
    ok: true,
    mode: 'local-only',
    policy: {
      ocr: 'PaddleOCR + doctr + manga-ocr (local pipeline)',
      translation: 'Helsinki-NLP/opus-mt-en-fr + Argostranslate (local)'
    },
    ocrPipeline
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
