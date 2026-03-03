// Content Script - Manwha Translator
// Runs on all pages to detect and translate manwha scans

(function() {
  'use strict';

  // State
  let isTranslating = false;
  let autoTranslate = false;
  let translatedImages = new Map();
  let imageElements = [];
  let pageTranslationContext = [];
  let settings = {
    displayMode: 'overlay',
    ocrEngine: 'auto',
    keepOriginal: false
  };
  const CHAPTER_CONTEXT_LIMIT = 120;
  const CHAPTER_RECENT_LIMIT = 12;
  const CHAPTER_GLOSSARY_LIMIT = 18;

  function sendRuntimeMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        resolve({ error: error.message });
      }
    });
  }

  function hashText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }

  function getTranslationCacheKey(text) {
    return `en-fr:${hashText(text.trim())}`;
  }

  function safeDecodeUri(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  function getSiteAdapterApi() {
    return window.ManwhaSiteAdapters || null;
  }

  function resolveImageSource(img) {
    const adapterApi = getSiteAdapterApi();
    return adapterApi?.resolveImageSource?.(img) || img?.currentSrc || img?.src || img?.dataset?.src || '';
  }

  function getActiveSiteAdapter() {
    return getSiteAdapterApi()?.getActiveAdapter?.(location.href) || null;
  }

  async function loadStoredSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get({
        autoTranslate: false,
        displayMode: 'overlay',
        ocrEngine: 'auto',
        keepOriginal: false
      }, resolve);
    });
  }

  function normalizeText(text) {
    return (text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s([?.!,;:])/g, '$1')
      .trim();
  }

  // Detect manwha/manga images on the page
  function detectManwhaImages() {
    const adapterApi = getSiteAdapterApi();
    const candidates = adapterApi?.collectCandidateImages?.(document) || Array.from(document.querySelectorAll('img'));
    return candidates.filter(img => isManwhaImage(img));
  }

  // Check if an image is likely a manwha/manga scan
  function isManwhaImage(img) {
    const src = resolveImageSource(img);
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    const alt = (img.alt || '').toLowerCase();
    const className = typeof img.className === 'string' ? img.className.toLowerCase() : '';
    const rect = img.getBoundingClientRect();
    const hidden = rect.width === 0 || rect.height === 0 || getComputedStyle(img).display === 'none';
    const activeAdapter = getActiveSiteAdapter();
    const insideReaderRoot = activeAdapter?.readerRoots?.some(selector => img.closest(selector)) || false;
    
    // Skip small icons and thumbnails
    if (width < 400 && height < 400) return false;
    if (width < 200 || height < 300) return false;
    if (hidden) return false;
    if (/avatar|logo|icon|banner|cover|thumb|thumbnail|advert/i.test(`${src} ${alt} ${className}`)) {
      return false;
    }
    if (img.closest('header, nav, footer, aside, [role="banner"], [role="navigation"], .ads, .ad, .advertisement, .sidebar')) {
      return false;
    }

    // Check for common manwha image patterns
    const manwhaPatterns = [
      /chapter/i,
      /scan/i,
      /manga/i,
      /manwha/i,
      /manhua/i,
      /webtoon/i,
      /comic/i,
      /page/i,
      /\d+\.\w+$/,
      /img.*\d+/i,
      /image.*\d+/i
    ];

    const matchesPattern = manwhaPatterns.some(pattern => pattern.test(src));
    
    // Check aspect ratio (manwha are typically vertical)
    const aspectRatio = height / width;
    const isVertical = aspectRatio > 1.2;

    return matchesPattern || isVertical || className.includes('manga') || 
           className.includes('chapter') || insideReaderRoot ||
           img.closest('.reader, .reading-content, #reader, .viewer') !== null;
  }

  // Translate text using LibreTranslate (free, no API key needed)
  async function translateText(text) {
    if (!text || text.trim().length < 2) return null;
    
    try {
      const cacheKey = getTranslationCacheKey(text);
      const cached = await sendRuntimeMessage({
        action: 'getCachedTranslation',
        key: cacheKey
      });

      if (cached && cached.translation) {
        return cached.translation;
      }

      const remoteTranslation = await sendRuntimeMessage({
        action: 'translateText',
        text
      });

      const translation = remoteTranslation?.translation || null;

      if (translation) {
        await sendRuntimeMessage({
          action: 'cacheTranslation',
          key: cacheKey,
          translation
        });
      }

      return translation;
    } catch (e) {
      console.error('Translation error:', e);
      return null;
    }
  }

  function loadImageElement(src, useCors = true) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout'));
      }, 10000);

      if (useCors) {
        image.crossOrigin = 'anonymous';
      }

      image.onload = () => {
        clearTimeout(timeoutId);
        resolve(image);
      };

      image.onerror = () => {
        clearTimeout(timeoutId);
        reject(new Error('Image load failed'));
      };

      image.src = src;
    });
  }

  function buildAiContext(index, total) {
    const glossary = buildChapterGlossary(pageTranslationContext);
    const chapterSummary = summarizeChapterContext(pageTranslationContext);
    return {
      pageUrl: location.href,
      pageTitle: document.title || '',
      currentImageIndex: index,
      totalImages: total,
      chapterKey: getChapterContextStorageKey(),
      recentBlocks: pageTranslationContext.slice(-CHAPTER_RECENT_LIMIT).map(block => ({
        original: block.original,
        translated: block.translated,
        type: block.type,
        tone: block.tone,
        lettering: block.style?.lettering || null,
        emphasis: block.style?.emphasis || null
      })),
      glossary,
      chapterSummary
    };
  }

  function buildChapterGlossary(entries) {
    const glossaryMap = new Map();

    for (const block of entries || []) {
      if (!block || !block.original || !block.translated) continue;

      const original = normalizeText(block.original);
      const translated = normalizeText(block.translated);
      if (!original || !translated) continue;

      const key = original.toLowerCase();
      const existing = glossaryMap.get(key);
      if (!existing) {
        glossaryMap.set(key, {
          original,
          translated,
          count: 1,
          tones: new Set(block.tone ? [block.tone] : []),
          types: new Set(block.type ? [block.type] : [])
        });
        continue;
      }

      existing.count += 1;
      if (block.tone) existing.tones.add(block.tone);
      if (block.type) existing.types.add(block.type);
    }

    return Array.from(glossaryMap.values())
      .filter(entry => entry.count >= 2 || entry.original.split(' ').length <= 3)
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.original.length - b.original.length;
      })
      .slice(0, CHAPTER_GLOSSARY_LIMIT)
      .map(entry => ({
        original: entry.original,
        translated: entry.translated,
        count: entry.count,
        tones: Array.from(entry.tones).slice(0, 3),
        types: Array.from(entry.types).slice(0, 3)
      }));
  }

  function summarizeChapterContext(entries) {
    const toneCounts = new Map();
    const typeCounts = new Map();

    for (const block of entries || []) {
      if (!block) continue;
      const tone = block.tone || 'neutral';
      const type = block.type || 'dialogue';
      toneCounts.set(tone, (toneCounts.get(tone) || 0) + 1);
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }

    const dominantTones = Array.from(toneCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tone]) => tone);
    const dominantTypes = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type);

    return {
      totalBlocks: entries?.length || 0,
      dominantTones,
      dominantTypes
    };
  }

  function getChapterContextStorageKey() {
    const url = new URL(location.href);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments.length > 1) {
      const last = segments[segments.length - 1];
      if (/^(page[-_ ]?\d+|\d+|p\d+)$/i.test(last)) {
        segments.pop();
      }
    }

    const normalizedPath = segments
      .map(segment => segment.replace(/\d+$/, match => match))
      .join('/');

    return `chapter-context:${url.origin}/${normalizedPath || ''}`;
  }

  async function loadChapterContext() {
    const storageKey = getChapterContextStorageKey();
    try {
      const stored = await chrome.storage.local.get(storageKey);
      const context = stored?.[storageKey];
      if (!Array.isArray(context)) {
        return [];
      }

      return context
        .filter(entry => entry && entry.original && entry.translated)
        .slice(-CHAPTER_CONTEXT_LIMIT);
    } catch (error) {
      console.warn('[ManwhaTranslator] Chargement contexte chapitre impossible:', error);
      return [];
    }
  }

  async function persistChapterContext() {
    const storageKey = getChapterContextStorageKey();
    try {
      await chrome.storage.local.set({
        [storageKey]: pageTranslationContext.slice(-CHAPTER_CONTEXT_LIMIT)
      });
    } catch (error) {
      console.warn('[ManwhaTranslator] Sauvegarde contexte chapitre impossible:', error);
    }
  }

  async function rememberAiContext(blocks) {
    for (const block of blocks || []) {
      if (!block || !block.text || !block.translatedText) continue;
      pageTranslationContext.push({
        original: block.text,
        translated: block.translatedText,
        type: block.type || 'dialogue',
        tone: block.tone || 'neutral',
        style: block.style || null
      });
    }

    if (pageTranslationContext.length > CHAPTER_CONTEXT_LIMIT) {
      pageTranslationContext = pageTranslationContext.slice(-CHAPTER_CONTEXT_LIMIT);
    }

    await persistChapterContext();
  }

  async function loadImageForProcessing(img) {
    const src = resolveImageSource(img);

    if (!src) {
      throw new Error('Image source introuvable');
    }

    try {
      return await loadImageElement(src, true);
    } catch (error) {
      const response = await sendRuntimeMessage({
        action: 'fetchImage',
        url: src
      });

      if (!response || response.error || !response.data) {
        throw new Error(response?.error || 'Impossible de recuperer l image');
      }

      return loadImageElement(response.data, false);
    }
  }

  function canvasToBackendImagePayload(canvas) {
    const dataUrl = canvas.toDataURL('image/png');
    return {
      base64: dataUrl.split(',')[1],
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height
    };
  }

  async function requestAiOcr(canvas, ocrEngine, context) {
    const payload = {
      action: 'aiOcrTranslate',
      image: canvasToBackendImagePayload(canvas),
      ocrEngine,
      context
    };

    let response = await sendRuntimeMessage(payload);
    if ((!response || response.error) && ocrEngine && ocrEngine !== 'auto') {
      const errorMessage = response?.error || '';
      if (
        /Aucun moteur OCR backend configure/i.test(errorMessage) ||
        /Unsupported/i.test(errorMessage) ||
        /Unknown/i.test(errorMessage)
      ) {
        response = await sendRuntimeMessage({
          ...payload,
          ocrEngine: 'auto'
        });
      }
    }

    if (!response || response.error) {
      throw new Error(response?.error || 'Backend OCR indisponible');
    }

    return response;
  }

  async function ensureBackendAvailable() {
    const health = await sendRuntimeMessage({ action: 'backendHealth' });
    if (health?.ok) {
      return true;
    }

    const guidance = await sendRuntimeMessage({ action: 'startupGuidance' });
    const backendUrl = guidance?.backendUrl || 'http://127.0.0.1:8787';
    const details = [
      `Backend indisponible: ${backendUrl}`,
      `Gateway: ${guidance?.gatewayCommand || 'cd backend && npm start'}`,
      `OCR: ${guidance?.ocrCommand || 'cd backend/ocr-pipeline && .venv312/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8788'}`
    ];

    throw new Error(details.join(' | '));
  }

  function normalizeMatchText(text) {
    return normalizeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function computeTextMatchScore(referenceText, candidateText) {
    const reference = normalizeMatchText(referenceText);
    const candidate = normalizeMatchText(candidateText);

    if (!reference || !candidate) {
      return 0;
    }

    if (reference === candidate) {
      return 1000;
    }

    const referenceTokens = new Set(reference.split(' ').filter(token => token.length > 1));
    const candidateTokens = new Set(candidate.split(' ').filter(token => token.length > 1));
    let overlap = 0;

    for (const token of referenceTokens) {
      if (candidateTokens.has(token)) {
        overlap += 1;
      }
    }

    return (overlap * 24) - (Math.abs(reference.length - candidate.length) * 0.45);
  }

  function countWordHints(text, hints) {
    const normalized = ` ${normalizeMatchText(text)} `;
    let count = 0;

    for (const hint of hints) {
      if (normalized.includes(` ${hint} `)) {
        count += 1;
      }
    }

    return count;
  }

  function getFrenchSignalScore(text) {
    const frenchHints = ['je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'que', 'qui', 'pas', 'dans', 'sur', 'avec', 'pour', 'mais', 'donc', 'est', 'suis', 'es', 'ce', 'cette', 'ça', 'seul', 'chance', 'plan'];
    const englishHints = ['the', 'a', 'an', 'i', 'you', 'he', 'she', 'we', 'they', 'only', 'one', 'chance', 'sure', 'plan', 'what', 'why', 'how', 'keep', 'running', 'away'];
    const frenchCount = countWordHints(text, frenchHints);
    const englishCount = countWordHints(text, englishHints);
    let score = (frenchCount * 12) - (englishCount * 10);

    if (/[àâçéèêëîïôûùüÿœæ]/i.test(text)) {
      score += 18;
    }

    if (/(^|[\s'])[ldjcmnstqu]['’]/i.test(text)) {
      score += 8;
    }

    return score;
  }

  function needsTranslationRepair(originalText, translatedText) {
    const original = normalizeMatchText(originalText);
    const translated = normalizeMatchText(translatedText);

    if (!translated) {
      return true;
    }

    if (original && translated === original) {
      return true;
    }

    return getFrenchSignalScore(translatedText) < 0;
  }

  function getAiBlockQualityScore(block) {
    if (!block) {
      return -Infinity;
    }

    let score = 0;
    const original = normalizeMatchText(block.text);
    const translated = normalizeMatchText(block.translatedText);

    if (translated && translated !== original) {
      score += 45;
    } else {
      score -= 60;
    }

    score += getFrenchSignalScore(block.translatedText || '');
    score += Math.min(30, (block.translatedText || '').length * 0.18);
    score += Math.min(18, (block.text || '').length * 0.08);

    if (block.repairedTranslation) {
      score += 20;
    }

    if (block.shapeBounds) {
      score += 8;
    }

    return score;
  }

  function shouldCollapseAiCandidates(a, b) {
    if (!a || !b) {
      return false;
    }

    const sameShape = shouldMergeBlocksByShape(a, b) || getRectIoU(a, b) >= 0.38;
    if (!sameShape) {
      return false;
    }

    const originalScore = computeTextMatchScore(a.text, b.text);
    const translatedScore = computeTextMatchScore(a.translatedText, b.translatedText);
    if (originalScore >= 18 || translatedScore >= 18) {
      return true;
    }

    return needsTranslationRepair(a.text, a.translatedText) !== needsTranslationRepair(b.text, b.translatedText);
  }

  function collapseOverlappingAiBlocks(blocks) {
    const clusters = [];

    for (const block of sortBlocksByReadingOrder(blocks)) {
      let targetCluster = null;

      for (const cluster of clusters) {
        if (cluster.blocks.some(existing => shouldCollapseAiCandidates(existing, block))) {
          targetCluster = cluster;
          break;
        }
      }

      if (!targetCluster) {
        clusters.push({ blocks: [block] });
      } else {
        targetCluster.blocks.push(block);
      }
    }

    return clusters.map(cluster => {
      const bestBlock = [...cluster.blocks].sort((a, b) => getAiBlockQualityScore(b) - getAiBlockQualityScore(a))[0];
      const representative = getRepresentativeShapeBlock(cluster.blocks) || bestBlock;
      return {
        ...representative,
        text: bestBlock.text,
        translatedText: bestBlock.translatedText,
        type: bestBlock.type,
        tone: bestBlock.tone,
        style: bestBlock.style || representative.style || null,
        repairedTranslation: !!bestBlock.repairedTranslation
      };
    });
  }

  async function finalizeAiBlocks(blocks) {
    const repairedBlocks = [];

    for (const block of blocks || []) {
      if (!block || !block.text || !block.translatedText) {
        continue;
      }

      let nextBlock = { ...block };

      if (needsTranslationRepair(nextBlock.text, nextBlock.translatedText)) {
        const repairedTranslation = await translateText(nextBlock.text);
        if (repairedTranslation) {
          nextBlock = {
            ...nextBlock,
            translatedText: normalizeText(repairedTranslation),
            repairedTranslation: true
          };
        }
      }

      if (needsTranslationRepair(nextBlock.text, nextBlock.translatedText)) {
        continue;
      }

      repairedBlocks.push(nextBlock);
    }

    return collapseOverlappingAiBlocks(repairedBlocks);
  }

  function sortBlocksByReadingOrder(blocks) {
    return [...(blocks || [])].sort((a, b) => {
      const deltaY = Math.abs((a?.y || 0) - (b?.y || 0));
      if (deltaY > 12) {
        return (a?.y || 0) - (b?.y || 0);
      }
      return (a?.x || 0) - (b?.x || 0);
    });
  }

  function getRectArea(rect) {
    if (!rect) return 0;
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function getRectIntersectionArea(a, b) {
    if (!a || !b) return 0;
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function getRectIoU(a, b) {
    const intersection = getRectIntersectionArea(a, b);
    if (!intersection) return 0;
    const union = getRectArea(a) + getRectArea(b) - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function getRepresentativeShapeBlock(blocks) {
    return (blocks || []).reduce((best, block) => {
      const bestArea = getRectArea(best?.shapeBounds || best?.bodyBounds || best);
      const blockArea = getRectArea(block?.shapeBounds || block?.bodyBounds || block);
      return blockArea > bestArea ? block : best;
    }, blocks?.[0] || null);
  }

  function refineDetectedBlocks(blocks, sourceCtx) {
    return (blocks || []).map(block => {
      const refinedShape = findBubbleShape(sourceCtx, block);
      if (!refinedShape) {
        return block;
      }

      return {
        ...block,
        x: refinedShape.textBox.x,
        y: refinedShape.textBox.y,
        width: refinedShape.textBox.width,
        height: refinedShape.textBox.height,
        shapeType: refinedShape.shapeType,
        shapeBounds: refinedShape.shapeBounds,
        bodyBounds: refinedShape.bodyBounds,
        shapeGuides: refinedShape.shapeGuides
      };
    });
  }

  function shouldMergeBlocksByShape(a, b) {
    const aShape = a?.shapeBounds || a?.bodyBounds;
    const bShape = b?.shapeBounds || b?.bodyBounds;
    if (!aShape || !bShape) {
      return false;
    }

    const iou = getRectIoU(aShape, bShape);
    const overlapRatio = getRectIntersectionArea(aShape, bShape) / Math.max(1, Math.min(getRectArea(aShape), getRectArea(bShape)));
    const centerDeltaX = Math.abs((aShape.x + (aShape.width / 2)) - (bShape.x + (bShape.width / 2)));
    const centerDeltaY = Math.abs((aShape.y + (aShape.height / 2)) - (bShape.y + (bShape.height / 2)));

    return (
      iou >= 0.45 ||
      overlapRatio >= 0.72 ||
      (
        centerDeltaX <= Math.max(aShape.width, bShape.width) * 0.2 &&
        centerDeltaY <= Math.max(aShape.height, bShape.height) * 0.2
      )
    );
  }

  function mergeBlocksBySharedShape(blocks) {
    const clusters = [];

    for (const block of sortBlocksByReadingOrder(blocks)) {
      if (!block || !block.text) continue;

      let targetCluster = null;
      for (const cluster of clusters) {
        if (shouldMergeBlocksByShape(cluster.representative, block)) {
          targetCluster = cluster;
          break;
        }
      }

      if (!targetCluster) {
        clusters.push({
          representative: block,
          blocks: [block]
        });
        continue;
      }

      targetCluster.blocks.push(block);
      targetCluster.representative = getRepresentativeShapeBlock(targetCluster.blocks);
    }

    return clusters.map(cluster => {
      const representative = cluster.representative;
      const orderedBlocks = sortBlocksByReadingOrder(cluster.blocks);
      const mergedText = normalizeText(orderedBlocks.map(block => block.text).join(' '));
      const mergedBlock = {
        ...representative,
        text: mergedText
      };

      if (!mergedBlock.text) {
        return null;
      }

      return mergedBlock;
    }).filter(Boolean);
  }

  async function extractTextBlocksFromCanvas(canvas, sourceCtx) {
    const detectedBlocks = await detectTextRegions(canvas);
    const refinedBlocks = refineDetectedBlocks(detectedBlocks, sourceCtx);
    return mergeBlocksBySharedShape(refinedBlocks);
  }

  function buildAiBlocksFromGeometry(aiBlocks, geometryBlocks, sourceCtx) {
    if (!Array.isArray(aiBlocks) || aiBlocks.length === 0 || !Array.isArray(geometryBlocks) || geometryBlocks.length === 0) {
      return [];
    }

    const availableGeometry = geometryBlocks
      .filter(block => block && block.width > 8 && block.height > 8)
      .map(block => ({ ...block, matched: false }))
      .sort((a, b) => {
        const deltaY = Math.abs(a.y - b.y);
        if (deltaY > 12) {
          return a.y - b.y;
        }
        return a.x - b.x;
      });

    const aiOrderedBlocks = aiBlocks
      .filter(block => block && block.original && block.translated)
      .map(block => ({ ...block }));

    const matchedBlocks = [];

    for (let index = 0; index < aiOrderedBlocks.length; index++) {
      const aiBlock = aiOrderedBlocks[index];
      let bestIndex = -1;
      let bestScore = -Infinity;

      for (let candidateIndex = 0; candidateIndex < availableGeometry.length; candidateIndex++) {
        const geometryBlock = availableGeometry[candidateIndex];
        if (geometryBlock.matched) continue;

        const textScore = computeTextMatchScore(aiBlock.original, geometryBlock.text);
        const orderPenalty = Math.abs(candidateIndex - index) * 6;
        const score = textScore - orderPenalty;

        if (score > bestScore) {
          bestScore = score;
          bestIndex = candidateIndex;
        }
      }

      if (bestIndex === -1) {
        continue;
      }

      const geometryBlock = availableGeometry[bestIndex];
      geometryBlock.matched = true;
      matchedBlocks.push({
        x: geometryBlock.x,
        y: geometryBlock.y,
        width: geometryBlock.width,
        height: geometryBlock.height,
        text: normalizeText(aiBlock.original || geometryBlock.text || ''),
        translatedText: normalizeText(aiBlock.translated || ''),
        type: aiBlock.type || 'dialogue',
        tone: aiBlock.tone || 'neutral',
        style: aiBlock.style || null
      });
    }

    return refineAiBlocks(matchedBlocks, sourceCtx);
  }

  // Process a single image
  async function processImage(img, index, total) {
    const existingEntry = translatedImages.get(img);
    const currentSrc = img.currentSrc || img.src;
    if (existingEntry && existingEntry.originalSrc === currentSrc) return true;
    if (existingEntry && existingEntry.originalSrc !== currentSrc) {
      translatedImages.delete(img);
    }

    try {
      updateProgress(Math.round((index / total) * 100), 
        `Traitement de l'image ${index + 1}/${total}...`);

      // Get image data
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      
      // Handle cross-origin images
      const imgToProcess = await loadImageForProcessing(img);

      canvas.width = imgToProcess.naturalWidth;
      canvas.height = imgToProcess.naturalHeight;
      ctx.drawImage(imgToProcess, 0, 0);

      let translatedBlocks = [];
      let extractedTextBlocks = null;
      const selectedEngine = settings.ocrEngine || 'auto';
      const engine = selectedEngine === 'tesseract' ? 'auto' : selectedEngine;

      try {
        updateProgress(Math.round((index / total) * 100),
          `🧩 OCR backend — image ${index + 1}/${total}...`);
        const aiResult = await requestAiOcr(
          canvas,
          engine,
          buildAiContext(index, total)
        );

        if (aiResult && aiResult.blocks && aiResult.blocks.length > 0) {
          const aiBlocks = await finalizeAiBlocks(
            refineAiBlocks(
              mapAiBlocksToCanvas(aiResult.blocks, canvas.width, canvas.height),
              ctx
            )
          );
          if (aiBlocks.length > 0) {
            console.log(`[ManwhaTranslator] ${aiResult.engine} → ${aiBlocks.length} bloc(s) positionné(s)`);
            translatedBlocks = aiBlocks;
          } else {
            extractedTextBlocks = await extractTextBlocksFromCanvas(canvas, ctx);
            const geometryMappedBlocks = await finalizeAiBlocks(
              buildAiBlocksFromGeometry(aiResult.blocks, extractedTextBlocks, ctx)
            );
            if (geometryMappedBlocks.length > 0) {
              console.log(`[ManwhaTranslator] ${aiResult.engine} → ${geometryMappedBlocks.length} bloc(s) aligné(s) via géométrie`);
              translatedBlocks = geometryMappedBlocks;
            } else {
              console.warn('[ManwhaTranslator] OCR backend sans bbox exploitable et sans fallback géométrique utilisable');
            }
          }
        } else {
          console.warn('[ManwhaTranslator] OCR backend n\'a renvoye aucun bloc exploitable', aiResult?.diagnostics || null);
        }
      } catch (aiErr) {
        console.warn('[ManwhaTranslator] OCR backend échoué:', aiErr.message);
      }

      if (translatedBlocks.length === 0) {
        console.warn('[ManwhaTranslator] Aucun bloc traduit retenu pour cette image');
        return false;
      }

      await rememberAiContext(translatedBlocks);

      // Apply translation based on display mode
      await applyTranslation(img, canvas, translatedBlocks);

      translatedImages.set(img, {
        originalSrc: currentSrc,
        blocks: translatedBlocks
      });
      img.dataset.manwhaTranslated = 'true';
      return true;

    } catch (error) {
      console.error('Error processing image:', error);
      return false;
    }
  }

  // Fallback text detection using edge detection
  async function detectTextRegions(canvas) {
    // No reliable non-OCR fallback is implemented yet.
    return [];
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeAiBlock(block, canvasWidth, canvasHeight) {
    if (!block || !block.translated) return null;

    const source = block.bbox && typeof block.bbox === 'object' ? block.bbox : block;
    const rawX = Number(source.x);
    const rawY = Number(source.y);
    const rawWidth = Number(source.width);
    const rawHeight = Number(source.height);

    if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite)) {
      return null;
    }

    const usesNormalizedCoords = rawX <= 1.2 && rawY <= 1.2 && rawWidth <= 1.2 && rawHeight <= 1.2;
    let x = usesNormalizedCoords ? rawX * canvasWidth : rawX;
    let y = usesNormalizedCoords ? rawY * canvasHeight : rawY;
    let width = usesNormalizedCoords ? rawWidth * canvasWidth : rawWidth;
    let height = usesNormalizedCoords ? rawHeight * canvasHeight : rawHeight;

    if (width <= 0 || height <= 0) {
      return null;
    }

    width = clamp(width, 48, canvasWidth);
    height = clamp(height, 28, canvasHeight);
    x = clamp(x, 0, Math.max(0, canvasWidth - width));
    y = clamp(y, 0, Math.max(0, canvasHeight - height));

    return {
      text: normalizeText(block.original || ''),
      translatedText: normalizeText(block.translated || ''),
      type: block.type || 'dialogue',
      tone: block.tone || 'neutral',
      style: block.style || null,
      x,
      y,
      width,
      height
    };
  }

  function mapAiBlocksToCanvas(blocks, canvasWidth, canvasHeight) {
    return (blocks || [])
      .map(block => normalizeAiBlock(block, canvasWidth, canvasHeight))
      .filter(block => block && block.text && block.translatedText)
      .sort((a, b) => {
        const deltaY = Math.abs(a.y - b.y);
        if (deltaY > 12) {
          return a.y - b.y;
        }
        return a.x - b.x;
      });
  }

  function drawRoundedRectPath(ctx, x, y, width, height, radius) {
    const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();

    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, width, height, safeRadius);
      return;
    }

    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
  }

  function rgbToFillStyle(rgb) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  function luminance(rgb) {
    return (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
  }

  function estimateBlockBackground(ctx, block) {
    const sampleX = Math.max(0, Math.floor(block.x));
    const sampleY = Math.max(0, Math.floor(block.y));
    const sampleWidth = Math.max(1, Math.min(ctx.canvas.width - sampleX, Math.ceil(block.width)));
    const sampleHeight = Math.max(1, Math.min(ctx.canvas.height - sampleY, Math.ceil(block.height)));
    const imageData = ctx.getImageData(sampleX, sampleY, sampleWidth, sampleHeight).data;

    let lightR = 0;
    let lightG = 0;
    let lightB = 0;
    let lightCount = 0;
    let allR = 0;
    let allG = 0;
    let allB = 0;
    let allCount = 0;

    for (let i = 0; i < imageData.length; i += 4) {
      const alpha = imageData[i + 3];
      if (alpha < 32) continue;

      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const bright = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);

      allR += r;
      allG += g;
      allB += b;
      allCount += 1;

      if (bright >= 150) {
        lightR += r;
        lightG += g;
        lightB += b;
        lightCount += 1;
      }
    }

    const sourceCount = lightCount || allCount || 1;
    const sourceR = lightCount ? lightR : allR;
    const sourceG = lightCount ? lightG : allG;
    const sourceB = lightCount ? lightB : allB;
    const rgb = {
      r: Math.round(sourceR / sourceCount),
      g: Math.round(sourceG / sourceCount),
      b: Math.round(sourceB / sourceCount)
    };

    return {
      fillRgb: rgb,
      fillStyle: rgbToFillStyle(rgb),
      textColor: luminance(rgb) >= 150 ? '#111111' : '#f8f8f8'
    };
  }

  function applyCaseStyle(text, casing) {
    if (!text) return '';
    if (casing === 'upper') return text.toLocaleUpperCase('fr-FR');
    if (casing === 'lower') return text.toLocaleLowerCase('fr-FR');
    return text;
  }

  function getFontFamily(style) {
    switch (style.lettering) {
      case 'narration':
      case 'caption':
        return 'Georgia, "Times New Roman", serif';
      case 'sfx':
        return 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif';
      case 'handwritten':
      case 'thought':
        return '"Comic Sans MS", "Trebuchet MS", cursive';
      case 'dialogue':
      default:
        return '"Trebuchet MS", Arial, Helvetica, sans-serif';
    }
  }

  function getDefaultAlign(block) {
    if (block.type === 'narration' || block.type === 'caption') {
      return 'left';
    }
    return 'center';
  }

  function buildRenderStyle(block, mode) {
    const style = block.style || {};
    const lettering = style.lettering || (
      block.type === 'narration' || block.type === 'caption'
        ? 'narration'
        : block.type === 'thought'
          ? 'thought'
          : block.type === 'sfx'
            ? 'sfx'
            : 'dialogue'
    );
    const emphasis = style.emphasis || (
      block.type === 'sfx' ? 'extreme' :
      ['angry', 'urgent', 'dramatic'].includes(block.tone) ? 'strong' :
      'normal'
    );
    const align = style.align || getDefaultAlign(block);
    const italic = typeof style.italic === 'boolean'
      ? style.italic
      : block.type === 'narration' || block.type === 'thought';
    const fontWeight = clamp(Number(style.weight) || (
      emphasis === 'extreme' ? 900 :
      emphasis === 'strong' ? 800 :
      block.type === 'narration' ? 700 : 750
    ), 400, 900);
    const casing = style.casing || (block.type === 'sfx' ? 'upper' : 'mixed');

    const base = {
      align,
      lettering,
      emphasis,
      casing,
      italic,
      fontWeight,
      fontFamily: getFontFamily({ lettering }),
      lineHeightMultiplier: lettering === 'sfx' ? 0.94 : lettering === 'narration' ? 1.12 : 1.04,
      minFontSize: lettering === 'sfx' ? 16 : lettering === 'narration' ? 12 : 11,
      maxFontRatioHeight: lettering === 'sfx' ? 0.9 : lettering === 'narration' ? 0.58 : 0.78,
      maxFontRatioWidth: lettering === 'sfx' ? 0.28 : lettering === 'narration' ? 0.17 : 0.22,
      paddingXRatio: lettering === 'narration' ? 0.07 : 0.09,
      paddingYRatio: lettering === 'narration' ? 0.12 : 0.14
    };

    if (mode === 'replace' && (block.type === 'narration' || block.type === 'caption')) {
      base.paddingXRatio = 0.06;
      base.paddingYRatio = 0.1;
    }

    return base;
  }

  function colorDistanceSq(r, g, b, target) {
    const dr = r - target.r;
    const dg = g - target.g;
    const db = b - target.b;
    return (dr * dr) + (dg * dg) + (db * db);
  }

  function deriveTextBoxFromShape(shapeBounds, bodyBounds, block) {
    const baseBounds = bodyBounds || shapeBounds;
    const shapeType = block.shapeType || 'rect';
    const isNarration = block.type === 'narration' || block.type === 'caption';
    const insetXRatio = isNarration ? 0.06 : shapeType === 'ellipse' ? 0.16 : 0.1;
    const insetYRatio = isNarration ? 0.12 : shapeType === 'ellipse' ? 0.18 : 0.12;

    const insetX = Math.max(6, baseBounds.width * insetXRatio);
    const insetY = Math.max(6, baseBounds.height * insetYRatio);

    return {
      x: baseBounds.x + insetX,
      y: baseBounds.y + insetY,
      width: Math.max(36, baseBounds.width - (insetX * 2)),
      height: Math.max(24, baseBounds.height - (insetY * 2))
    };
  }

  function buildShapeGuides(guideBaseX, guideBaseY, rowMin, rowMax, firstRow, lastRow, block, shapeType) {
    const guides = [];
    const isNarration = block.type === 'narration' || block.type === 'caption';
    const insetRatio = isNarration ? 0.06 : shapeType === 'ellipse' ? 0.12 : 0.08;

    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const minX = rowMin[rowIndex];
      const maxX = rowMax[rowIndex];
      if (!Number.isFinite(minX) || maxX < minX) {
        continue;
      }

      const spanWidth = (maxX - minX) + 1;
      const inset = Math.max(3, spanWidth * insetRatio);
      const x = guideBaseX + minX + inset;
      const width = Math.max(16, spanWidth - (inset * 2));

      guides.push({
        y: guideBaseY + rowIndex,
        x,
        width
      });
    }

    return guides;
  }

  function findBubbleShape(ctx, block) {
    const searchPadX = Math.max(24, block.width * 0.55);
    const searchPadY = Math.max(24, block.height * 0.55);
    const regionX = Math.max(0, Math.floor(block.x - searchPadX));
    const regionY = Math.max(0, Math.floor(block.y - searchPadY));
    const regionWidth = Math.max(1, Math.min(ctx.canvas.width - regionX, Math.ceil(block.width + (searchPadX * 2))));
    const regionHeight = Math.max(1, Math.min(ctx.canvas.height - regionY, Math.ceil(block.height + (searchPadY * 2))));
    const imageData = ctx.getImageData(regionX, regionY, regionWidth, regionHeight).data;
    const background = estimateBlockBackground(ctx, block).fillRgb;
    const isNarration = block.type === 'narration' || block.type === 'caption';
    const tolerance = isNarration ? 34 : 52;
    const toleranceSq = tolerance * tolerance;
    const mask = new Uint8Array(regionWidth * regionHeight);

    for (let y = 0; y < regionHeight; y++) {
      for (let x = 0; x < regionWidth; x++) {
        const idx = ((y * regionWidth) + x);
        const pixelIndex = idx * 4;
        const alpha = imageData[pixelIndex + 3];
        if (alpha < 32) continue;

        const r = imageData[pixelIndex];
        const g = imageData[pixelIndex + 1];
        const b = imageData[pixelIndex + 2];
        const bright = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);

        if (colorDistanceSq(r, g, b, background) <= toleranceSq && (isNarration || bright >= 150)) {
          mask[idx] = 1;
        }
      }
    }

    const visited = new Uint8Array(regionWidth * regionHeight);
    const centerX = block.x + (block.width / 2);
    const centerY = block.y + (block.height / 2);
    const originalLeft = block.x;
    const originalTop = block.y;
    const originalRight = block.x + block.width;
    const originalBottom = block.y + block.height;
    let best = null;

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || visited[start]) continue;

      const queue = [start];
      visited[start] = 1;
      let head = 0;
      let count = 0;
      let minX = regionWidth;
      let minY = regionHeight;
      let maxX = 0;
      let maxY = 0;
      let overlap = 0;
      let containsCenter = false;
      const pixels = [];

      while (head < queue.length) {
        const current = queue[head++];
        const localX = current % regionWidth;
        const localY = Math.floor(current / regionWidth);
        const globalX = regionX + localX;
        const globalY = regionY + localY;

        pixels.push(current);
        count += 1;
        minX = Math.min(minX, localX);
        minY = Math.min(minY, localY);
        maxX = Math.max(maxX, localX);
        maxY = Math.max(maxY, localY);

        if (
          globalX >= originalLeft && globalX <= originalRight &&
          globalY >= originalTop && globalY <= originalBottom
        ) {
          overlap += 1;
        }

        if (
          Math.abs(globalX - centerX) <= 1 &&
          Math.abs(globalY - centerY) <= 1
        ) {
          containsCenter = true;
        }

        const neighbors = [
          current - 1,
          current + 1,
          current - regionWidth,
          current + regionWidth
        ];

        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= mask.length) continue;
          const nx = neighbor % regionWidth;
          const ny = Math.floor(neighbor / regionWidth);
          if (Math.abs(nx - localX) + Math.abs(ny - localY) !== 1) continue;
          if (!mask[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }

      if (count < 120) continue;

      const width = (maxX - minX) + 1;
      const height = (maxY - minY) + 1;
      const fillRatio = count / Math.max(1, width * height);
      const score = (containsCenter ? 150000 : 0) + (overlap * 6) + count - (Math.abs((regionX + minX + (width / 2)) - centerX) * 6);

      if (!best || score > best.score) {
        best = { score, pixels, minX, minY, maxX, maxY, width, height, fillRatio };
      }
    }

    if (!best) {
      return null;
    }

    const rowMin = new Array(best.height).fill(Infinity);
    const rowMax = new Array(best.height).fill(-1);
    let maxRowWidth = 0;

    for (const pixel of best.pixels) {
      const localX = pixel % regionWidth;
      const localY = Math.floor(pixel / regionWidth);
      const rowIndex = localY - best.minY;
      rowMin[rowIndex] = Math.min(rowMin[rowIndex], localX);
      rowMax[rowIndex] = Math.max(rowMax[rowIndex], localX);
    }

    for (let i = 0; i < rowMin.length; i++) {
      if (rowMax[i] >= rowMin[i]) {
        maxRowWidth = Math.max(maxRowWidth, (rowMax[i] - rowMin[i]) + 1);
      }
    }

    const mainRows = [];
    const minBodyWidth = maxRowWidth * 0.58;
    for (let i = 0; i < rowMin.length; i++) {
      const rowWidth = rowMax[i] >= rowMin[i] ? (rowMax[i] - rowMin[i]) + 1 : 0;
      if (rowWidth >= minBodyWidth) {
        mainRows.push(i);
      }
    }

    const bodyTop = mainRows.length > 0 ? best.minY + mainRows[0] : best.minY;
    const bodyBottom = mainRows.length > 0 ? best.minY + mainRows[mainRows.length - 1] : best.maxY;
    let bodyMinX = best.maxX;
    let bodyMaxX = best.minX;

    if (mainRows.length > 0) {
      for (const row of mainRows) {
        bodyMinX = Math.min(bodyMinX, rowMin[row]);
        bodyMaxX = Math.max(bodyMaxX, rowMax[row]);
      }
    } else {
      bodyMinX = best.minX;
      bodyMaxX = best.maxX;
    }

    const shapeType = (block.type === 'narration' || block.type === 'caption' || best.fillRatio > 0.82)
      ? 'rect'
      : 'ellipse';
    const shapeBounds = {
      x: regionX + best.minX,
      y: regionY + best.minY,
      width: best.width,
      height: best.height
    };
    const bodyBounds = {
      x: regionX + bodyMinX,
      y: regionY + bodyTop,
      width: Math.max(1, (bodyMaxX - bodyMinX) + 1),
      height: Math.max(1, (bodyBottom - bodyTop) + 1)
    };
    const textBox = deriveTextBoxFromShape(shapeBounds, bodyBounds, {
      ...block,
      shapeType
    });
    const shapeGuides = buildShapeGuides(
      regionX,
      regionY + best.minY,
      rowMin,
      rowMax,
      bodyTop - best.minY,
      bodyBottom - best.minY,
      block,
      shapeType
    );

    return {
      shapeType,
      shapeBounds,
      bodyBounds,
      textBox,
      shapeGuides
    };
  }

  function refineAiBlocks(blocks, sourceCtx) {
    return (blocks || []).map(block => {
      const refinedShape = findBubbleShape(sourceCtx, block);
      if (!refinedShape) {
        return block;
      }

      return {
        ...block,
        x: refinedShape.textBox.x,
        y: refinedShape.textBox.y,
        width: refinedShape.textBox.width,
        height: refinedShape.textBox.height,
        shapeType: refinedShape.shapeType,
        shapeBounds: refinedShape.shapeBounds,
        bodyBounds: refinedShape.bodyBounds,
        shapeGuides: refinedShape.shapeGuides
      };
    });
  }

  function wrapTextLines(ctx, text, maxWidth) {
    const tokens = normalizeText(text).split(' ').filter(Boolean);
    if (tokens.length === 0) {
      return [];
    }

    const lines = [];
    let currentLine = '';

    function splitLongToken(token) {
      const pieces = [];
      let chunk = '';

      for (const char of token) {
        const testChunk = chunk + char;
        if (chunk && ctx.measureText(testChunk).width > maxWidth) {
          pieces.push(chunk);
          chunk = char;
        } else {
          chunk = testChunk;
        }
      }

      if (chunk) {
        pieces.push(chunk);
      }

      return pieces;
    }

    for (const token of tokens) {
      if (ctx.measureText(token).width > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
        }

        const pieces = splitLongToken(token);
        for (let i = 0; i < pieces.length; i++) {
          if (i < pieces.length - 1) {
            lines.push(pieces[i]);
          } else {
            currentLine = pieces[i];
          }
        }
        continue;
      }

      const testLine = currentLine ? `${currentLine} ${token}` : token;
      if (currentLine && ctx.measureText(testLine).width > maxWidth) {
        lines.push(currentLine);
        currentLine = token;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  function wrapTextLinesWithLineWidths(ctx, text, lineWidths) {
    const tokens = normalizeText(text).split(' ').filter(Boolean);
    if (tokens.length === 0) {
      return [];
    }

    const lines = [];
    let currentLine = '';
    let lineIndex = 0;

    function currentWidth() {
      return lineWidths[Math.min(lineIndex, lineWidths.length - 1)];
    }

    function pushLine(force = false) {
      if (!currentLine && !force) return true;
      lines.push(currentLine);
      currentLine = '';
      lineIndex += 1;
      return lineIndex < lineWidths.length || force;
    }

    function splitLongToken(token, maxWidth) {
      const pieces = [];
      let chunk = '';

      for (const char of token) {
        const testChunk = chunk + char;
        if (chunk && ctx.measureText(testChunk).width > maxWidth) {
          pieces.push(chunk);
          chunk = char;
        } else {
          chunk = testChunk;
        }
      }

      if (chunk) {
        pieces.push(chunk);
      }

      return pieces;
    }

    for (const token of tokens) {
      let availableWidth = currentWidth();
      if (!availableWidth) {
        return null;
      }

      if (ctx.measureText(token).width > availableWidth) {
        const pieces = splitLongToken(token, availableWidth);
        for (const piece of pieces) {
          availableWidth = currentWidth();
          if (!availableWidth) return null;

          const testLine = currentLine ? `${currentLine} ${piece}` : piece;
          if (currentLine && ctx.measureText(testLine).width > availableWidth) {
            if (!pushLine()) return null;
            availableWidth = currentWidth();
            if (!availableWidth || ctx.measureText(piece).width > availableWidth) {
              return null;
            }
            currentLine = piece;
          } else {
            currentLine = testLine;
          }
        }
        continue;
      }

      const testLine = currentLine ? `${currentLine} ${token}` : token;
      if (currentLine && ctx.measureText(testLine).width > availableWidth) {
        if (!pushLine()) return null;
        availableWidth = currentWidth();
        if (!availableWidth || ctx.measureText(token).width > availableWidth) {
          return null;
        }
        currentLine = token;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length <= lineWidths.length ? lines : null;
  }

  function buildCurvedLineWidths(boxWidth, boxHeight, lineCount, lineHeight, shapeType) {
    if (shapeType !== 'ellipse') {
      return new Array(lineCount).fill(boxWidth);
    }

    const centerY = boxHeight / 2;
    const radiusY = Math.max(1, boxHeight / 2);
    const widths = [];

    for (let i = 0; i < lineCount; i++) {
      const lineCenterY = ((i + 0.5) * lineHeight);
      const normalizedY = Math.min(1, Math.abs(lineCenterY - centerY) / radiusY);
      const curveFactor = Math.sqrt(Math.max(0, 1 - (normalizedY * normalizedY)));
      widths.push(Math.max(boxWidth * 0.46, boxWidth * curveFactor * 0.96));
    }

    return widths;
  }

  function sampleShapeGuide(shapeGuides, centerY, bandHeight) {
    if (!Array.isArray(shapeGuides) || shapeGuides.length === 0) {
      return null;
    }

    const minY = centerY - (bandHeight / 2);
    const maxY = centerY + (bandHeight / 2);
    let sumX = 0;
    let sumWidth = 0;
    let count = 0;

    for (const guide of shapeGuides) {
      if (guide.y >= minY && guide.y <= maxY) {
        sumX += guide.x;
        sumWidth += guide.width;
        count += 1;
      }
    }

    if (count === 0) {
      let closest = null;
      for (const guide of shapeGuides) {
        const distance = Math.abs(guide.y - centerY);
        if (!closest || distance < closest.distance) {
          closest = { distance, guide };
        }
      }
      return closest ? closest.guide : null;
    }

    return {
      x: sumX / count,
      width: sumWidth / count
    };
  }

  function buildLineMetrics(boxX, boxY, boxWidth, boxHeight, lineCount, lineHeight, shapeType, shapeGuides) {
    const totalTextHeight = lineCount * lineHeight;
    const topOffset = Math.max(0, (boxHeight - totalTextHeight) / 2);

    if (Array.isArray(shapeGuides) && shapeGuides.length > 0) {
      return new Array(lineCount).fill(null).map((_, index) => {
        const y = boxY + topOffset + (index * lineHeight);
        const centerY = y + (lineHeight / 2);
        const sampled = sampleShapeGuide(shapeGuides, centerY, lineHeight * 0.95);
        if (!sampled) {
          const fallbackWidth = buildCurvedLineWidths(boxWidth, boxHeight, lineCount, lineHeight, shapeType)[index];
          const fallbackX = boxX + Math.max(0, (boxWidth - fallbackWidth) / 2);
          return {
            x: fallbackX,
            y,
            width: fallbackWidth,
            centerX: fallbackX + (fallbackWidth / 2)
          };
        }

        return {
          x: sampled.x,
          y,
          width: sampled.width,
          centerX: sampled.x + (sampled.width / 2)
        };
      });
    }

    const lineWidths = buildCurvedLineWidths(boxWidth, boxHeight, lineCount, lineHeight, shapeType);
    return lineWidths.map((lineWidth, index) => {
      const x = boxX + Math.max(0, (boxWidth - lineWidth) / 2);
      const y = boxY + topOffset + (index * lineHeight);
      return {
        x,
        y,
        width: lineWidth,
        centerX: x + (lineWidth / 2)
      };
    });
  }

  function createTextLayout(ctx, text, boxWidth, boxHeight, options = {}) {
    const minFontSize = Math.max(11, Math.floor(options.minFontSize || 11));
    const maxFontSize = Math.max(
      minFontSize,
      Math.floor(options.maxFontSize || Math.min(boxHeight * 0.55, boxWidth * 0.22))
    );
    const lineHeightMultiplier = options.lineHeightMultiplier || 1.08;
    const fontFamily = options.fontFamily || 'Arial, sans-serif';
    const fontWeight = options.fontWeight || '700';
    const italic = options.italic ? 'italic ' : '';
    const shapeType = options.shapeType || 'rect';
    const boxX = options.boxX || 0;
    const boxY = options.boxY || 0;
    const shapeGuides = options.shapeGuides || null;

    for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize--) {
      ctx.font = `${italic}${fontWeight} ${fontSize}px ${fontFamily}`;
      const lineHeight = fontSize * lineHeightMultiplier;
      const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));

      for (let lineCount = 1; lineCount <= maxLines; lineCount++) {
        const lineMetrics = buildLineMetrics(
          boxX,
          boxY,
          boxWidth,
          boxHeight,
          lineCount,
          lineHeight,
          shapeType,
          shapeGuides
        );
        const lines = wrapTextLinesWithLineWidths(ctx, text, lineMetrics.map(metric => metric.width));
        if (!lines) {
          continue;
        }

        const textHeight = lines.length * lineHeight;
        if (lines.length > 0 && textHeight <= boxHeight) {
          return {
            lines,
            fontSize,
            lineHeight,
            fontFamily,
            fontWeight,
            italic,
            lineMetrics
          };
        }
      }
    }

    ctx.font = `${italic}${fontWeight} ${minFontSize}px ${fontFamily}`;
    const fallbackLineHeight = minFontSize * lineHeightMultiplier;
    const fallbackMaxLines = Math.max(1, Math.floor(boxHeight / fallbackLineHeight));
    const fallbackLineMetrics = buildLineMetrics(
      boxX,
      boxY,
      boxWidth,
      boxHeight,
      fallbackMaxLines,
      fallbackLineHeight,
      shapeType,
      shapeGuides
    );
    return {
      lines: wrapTextLinesWithLineWidths(
        ctx,
        text,
        fallbackLineMetrics.map(metric => metric.width)
      ) || wrapTextLines(ctx, text, boxWidth),
      fontSize: minFontSize,
      lineHeight: fallbackLineHeight,
      fontFamily,
      fontWeight,
      italic,
      lineMetrics: fallbackLineMetrics
    };
  }

  function drawFittedText(ctx, block, options = {}) {
    const hasShapeGuides = Array.isArray(block.shapeGuides) && block.shapeGuides.length > 0;
    const paddingX = hasShapeGuides
      ? Math.max(2, Math.min(options.paddingX ?? 0, block.width * 0.03))
      : (options.paddingX ?? Math.max(10, block.width * 0.08));
    const paddingY = hasShapeGuides
      ? Math.max(2, Math.min(options.paddingY ?? 0, block.height * 0.05))
      : (options.paddingY ?? Math.max(8, block.height * 0.12));
    const boxX = block.x + paddingX;
    const boxY = block.y + paddingY;
    const boxWidth = Math.max(24, block.width - (paddingX * 2));
    const boxHeight = Math.max(20, block.height - (paddingY * 2));
    const text = applyCaseStyle(block.translatedText, options.casing);
    const layout = createTextLayout(ctx, text, boxWidth, boxHeight, {
      ...options,
      boxX,
      boxY,
      shapeGuides: block.shapeGuides || options.shapeGuides || null,
      shapeType: options.shapeType || block.shapeType || 'rect'
    });

    ctx.fillStyle = options.textColor || '#111111';
    ctx.textBaseline = 'top';
    ctx.font = `${layout.italic}${layout.fontWeight} ${layout.fontSize}px ${layout.fontFamily}`;

    for (let lineNumber = 0; lineNumber < layout.lines.length; lineNumber++) {
      const line = layout.lines[lineNumber];
      const lineMetric = layout.lineMetrics?.[Math.min(lineNumber, layout.lineMetrics.length - 1)] || {
        x: boxX,
        y: boxY + (lineNumber * layout.lineHeight),
        width: boxWidth,
        centerX: boxX + (boxWidth / 2)
      };

      if (options.align === 'left') {
        ctx.textAlign = 'left';
        ctx.fillText(line, lineMetric.x, lineMetric.y);
      } else if (options.align === 'right') {
        ctx.textAlign = 'right';
        ctx.fillText(line, lineMetric.x + lineMetric.width, lineMetric.y);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(line, lineMetric.centerX, lineMetric.y);
      }
    }

    ctx.textAlign = 'left';
  }

  function findImageBySource(srcUrl) {
    if (!srcUrl) return null;

    const normalizedTarget = safeDecodeUri(srcUrl);

    return detectManwhaImages().find(img => {
      const currentSrc = resolveImageSource(img);
      const normalizedCurrent = safeDecodeUri(currentSrc);

      return currentSrc === srcUrl ||
        normalizedCurrent === normalizedTarget ||
        currentSrc.includes(srcUrl) ||
        srcUrl.includes(currentSrc);
    }) || null;
  }

  async function translateSingleImage(srcUrl, userSettings = {}) {
    if (isTranslating) {
      return { success: false, error: 'Une traduction est deja en cours' };
    }

    pageTranslationContext = await loadChapterContext();
    settings = { ...settings, ...userSettings };

    const targetImage = findImageBySource(srcUrl);
    if (!targetImage) {
      return { success: false, error: 'Image cible introuvable sur la page' };
    }

    isTranslating = true;
    try {
      updateProgress(2, 'Vérification du backend OCR...');
      await ensureBackendAvailable();

      const translated = await processImage(targetImage, 0, 1);
      chrome.runtime.sendMessage({
        action: 'stats',
        imageCount: 1,
        translatedCount: translated ? 1 : 0
      });

      return {
        success: translated,
        error: translated ? null : 'Aucun texte exploitable detecte sur cette image',
        translatedCount: translated ? 1 : 0
      };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      isTranslating = false;
    }
  }

  // Apply translation to image
  async function applyTranslation(originalImg, sourceCanvas, textBlocks) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    
    // Draw original image
    ctx.drawImage(sourceCanvas, 0, 0);

    // Apply translations based on mode
    switch (settings.displayMode) {
      case 'replace':
        await drawTranslatedText(ctx, textBlocks, true, sourceCtx);
        break;
      case 'bubble':
        await drawTranslatedBubbles(ctx, textBlocks);
        break;
      case 'overlay':
      default:
        await drawTranslatedOverlay(ctx, textBlocks, sourceCtx);
        break;
    }

    // Replace or overlay the original image
    if (settings.displayMode === 'replace') {
      originalImg.src = canvas.toDataURL('image/png');
    } else {
      // Create overlay
      createOverlay(originalImg, canvas.toDataURL('image/png'));
    }
  }

  // Draw translated text replacing original
  async function drawTranslatedText(ctx, blocks, clearBackground = false, sampleCtx = ctx) {
    for (const block of blocks) {
      const renderStyle = buildRenderStyle(block, 'replace');
      const bg = estimateBlockBackground(sampleCtx, block);
      const clearTarget = block.shapeBounds || block;

      if (clearBackground) {
        const padX = Math.max(2, clearTarget.width * (block.type === 'narration' || block.type === 'caption' ? 0.02 : 0.015));
        const padY = Math.max(2, clearTarget.height * (block.type === 'narration' || block.type === 'caption' ? 0.03 : 0.015));
        const clearX = Math.max(0, clearTarget.x - padX);
        const clearY = Math.max(0, clearTarget.y - padY);
        const clearWidth = Math.min(ctx.canvas.width - clearX, clearTarget.width + (padX * 2));
        const clearHeight = Math.min(ctx.canvas.height - clearY, clearTarget.height + (padY * 2));

        ctx.fillStyle = bg.fillStyle;
        if (block.shapeType === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(
            clearX + (clearWidth / 2),
            clearY + (clearHeight / 2),
            clearWidth / 2,
            clearHeight / 2,
            0,
            0,
            Math.PI * 2
          );
        } else {
          drawRoundedRectPath(
            ctx,
            clearX,
            clearY,
            clearWidth,
            clearHeight,
            block.type === 'narration' || block.type === 'caption'
              ? Math.max(4, Math.min(clearWidth, clearHeight) * 0.05)
              : Math.max(10, Math.min(clearWidth, clearHeight) * 0.18)
          );
        }
        ctx.fill();
      }

      drawFittedText(ctx, block, {
        textColor: bg.textColor,
        fontFamily: renderStyle.fontFamily,
        fontWeight: renderStyle.fontWeight,
        italic: renderStyle.italic,
        casing: renderStyle.casing,
        align: renderStyle.align,
        maxFontSize: Math.min(block.height * renderStyle.maxFontRatioHeight, block.width * renderStyle.maxFontRatioWidth),
        minFontSize: renderStyle.minFontSize,
        lineHeightMultiplier: renderStyle.lineHeightMultiplier,
        paddingX: Math.max(4, block.width * renderStyle.paddingXRatio),
        paddingY: Math.max(4, block.height * renderStyle.paddingYRatio)
      });
    }
  }

  // Draw translated text in bubbles
  async function drawTranslatedBubbles(ctx, blocks) {
    for (const block of blocks) {
      const renderStyle = buildRenderStyle(block, 'bubble');

      // Draw bubble background
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      
      const padding = 10;
      const bubbleX = block.x - padding;
      const bubbleY = block.y - padding;
      const bubbleWidth = block.width + padding * 2;
      const bubbleHeight = block.height + padding * 2;
      
      drawRoundedRectPath(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, 10);
      ctx.fill();
      ctx.stroke();

      drawFittedText(ctx, {
        ...block,
        x: bubbleX,
        y: bubbleY,
        width: bubbleWidth,
        height: bubbleHeight
      }, {
        textColor: '#111111',
        fontFamily: renderStyle.fontFamily,
        fontWeight: renderStyle.fontWeight,
        italic: renderStyle.italic,
        casing: renderStyle.casing,
        align: renderStyle.align,
        paddingX: Math.max(padding + 4, bubbleWidth * renderStyle.paddingXRatio),
        paddingY: Math.max(padding + 2, bubbleHeight * renderStyle.paddingYRatio),
        maxFontSize: Math.min(bubbleHeight * renderStyle.maxFontRatioHeight, bubbleWidth * renderStyle.maxFontRatioWidth),
        minFontSize: renderStyle.minFontSize,
        lineHeightMultiplier: renderStyle.lineHeightMultiplier
      });
    }
  }

  // Draw overlay mode
  async function drawTranslatedOverlay(ctx, blocks, sampleCtx = ctx) {
    // Similar to bubble but with semi-transparent background
    for (const block of blocks) {
      const renderStyle = buildRenderStyle(block, 'overlay');
      const bg = estimateBlockBackground(sampleCtx, block);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      drawRoundedRectPath(ctx, block.x - 4, block.y - 4, block.width + 8, block.height + 8, 8);
      ctx.fill();

      drawFittedText(ctx, block, {
        textColor: bg.textColor,
        fontFamily: renderStyle.fontFamily,
        fontWeight: renderStyle.fontWeight,
        italic: renderStyle.italic,
        casing: renderStyle.casing,
        align: renderStyle.align,
        maxFontSize: Math.min(block.height * renderStyle.maxFontRatioHeight, block.width * renderStyle.maxFontRatioWidth),
        minFontSize: renderStyle.minFontSize,
        lineHeightMultiplier: renderStyle.lineHeightMultiplier,
        paddingX: Math.max(6, block.width * renderStyle.paddingXRatio),
        paddingY: Math.max(6, block.height * renderStyle.paddingYRatio)
      });
    }
  }

  // Create overlay element
  function createOverlay(originalImg, translatedDataUrl) {
    // Remove existing overlay if any
    const existing = originalImg.parentElement.querySelector('.manwha-translator-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('img');
    overlay.src = translatedDataUrl;
    overlay.className = 'manwha-translator-overlay';
    overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: ${settings.keepOriginal ? '1' : '0'};
      transition: opacity 0.3s ease;
      pointer-events: none;
      z-index: 1000;
    `;

    // Ensure parent has position
    const parent = originalImg.parentElement;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(overlay);

    // Show on hover
    originalImg.addEventListener('mouseenter', () => {
      overlay.style.opacity = '1';
    });
    originalImg.addEventListener('mouseleave', () => {
      if (!settings.keepOriginal) {
        overlay.style.opacity = '0';
      }
    });

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'manwha-translator-toggle';
    toggleBtn.innerHTML = '🇫🇷';
    toggleBtn.title = 'Afficher/Masquer la traduction';
    toggleBtn.onclick = () => {
      const isVisible = overlay.style.opacity === '1';
      overlay.style.opacity = isVisible ? '0' : '1';
    };
    parent.appendChild(toggleBtn);
  }

  // Update progress
  function updateProgress(percent, status) {
    chrome.runtime.sendMessage({
      action: 'progress',
      percent,
      status
    });
  }

  // Main translate function
  async function translatePage(userSettings = {}) {
    if (isTranslating) {
      return { success: false, error: 'Une traduction est deja en cours' };
    }
    
    isTranslating = true;
    pageTranslationContext = await loadChapterContext();
    const storedSettings = await loadStoredSettings();
    settings = { ...settings, ...storedSettings, ...userSettings };
    
    try {
      updateProgress(2, 'Vérification du backend OCR...');
      await ensureBackendAvailable();

      imageElements = detectManwhaImages();
      
      if (imageElements.length === 0) {
        updateProgress(100, 'Aucune image de manwha détectée');
        return { success: true, translatedCount: 0 };
      }

      // Update stats
      chrome.runtime.sendMessage({
        action: 'stats',
        imageCount: imageElements.length,
        translatedCount: translatedImages.size
      });

      let translatedCountForRun = 0;

      // Process each image
      for (let i = 0; i < imageElements.length; i++) {
        const translated = await processImage(imageElements[i], i, imageElements.length);
        if (translated) {
          translatedCountForRun += 1;
        }
      }

      updateProgress(100, 'Traduction terminée !');

      chrome.runtime.sendMessage({
        action: 'stats',
        imageCount: imageElements.length,
        translatedCount: translatedImages.size
      });
      
      return { 
        success: true, 
        translatedCount: translatedCountForRun
      };

    } catch (error) {
      console.error('Translation error:', error);
      return { success: false, error: error.message };
    } finally {
      isTranslating = false;
    }
  }

  // Reset translations
  function resetTranslations() {
    translatedImages.forEach((data, img) => {
      if (img.src !== data.originalSrc) {
        img.src = data.originalSrc;
      }
      delete img.dataset.manwhaTranslated;
    });
    translatedImages.clear();
    
    // Remove overlays
    document.querySelectorAll('.manwha-translator-overlay, .manwha-translator-toggle').forEach(el => {
      el.remove();
    });

    chrome.runtime.sendMessage({
      action: 'stats',
      imageCount: imageElements.length,
      translatedCount: 0
    });
  }

  // Auto-translate observer
  let autoTranslateObserver = null;
  
  function setupAutoTranslate() {
    if (autoTranslateObserver) {
      autoTranslateObserver.disconnect();
    }

    if (!autoTranslate) return;

    autoTranslateObserver = new MutationObserver((mutations) => {
      let shouldTranslate = false;
      
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IMG' && isManwhaImage(node)) {
            shouldTranslate = true;
          } else if (node.querySelectorAll) {
            const images = node.querySelectorAll('img');
            for (const img of images) {
              if (isManwhaImage(img)) {
                shouldTranslate = true;
                break;
              }
            }
          }
        });
      });

      if (shouldTranslate && !isTranslating) {
        setTimeout(() => translatePage(settings), 1000);
      }
    });

    autoTranslateObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      switch (request.action) {
        case 'ping':
          sendResponse({ ok: true });
          break;

        case 'translatePage':
          const result = await translatePage(request.settings);
          sendResponse(result);
          break;

        case 'translateSingleImage':
          const singleResult = await translateSingleImage(request.srcUrl, request.settings);
          sendResponse(singleResult);
          break;
          
        case 'reset':
          resetTranslations();
          sendResponse({ success: true });
          break;
          
        case 'setAutoTranslate':
          autoTranslate = request.value;
          if (request.settings) {
            settings = { ...settings, ...request.settings };
          }
          setupAutoTranslate();
          sendResponse({ success: true });
          break;
          
        case 'getStats':
          sendResponse({
            imageCount: imageElements.length,
            translatedCount: translatedImages.size
          });
          break;
      }
    })();
    return true; // Keep channel open for async
  });

  // Initialize
  loadStoredSettings().then((storedSettings) => {
    autoTranslate = storedSettings.autoTranslate;
    settings = { ...settings, ...storedSettings };

    if (autoTranslate) {
      setupAutoTranslate();
      // Auto-translate on page load
      setTimeout(() => translatePage(), 2000);
    }
  });

  // Add CSS for toggle button
  const style = document.createElement('style');
  style.textContent = `
    .manwha-translator-toggle {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: linear-gradient(135deg, #00d4ff, #7b2cbf);
      border: none;
      cursor: pointer;
      font-size: 18px;
      z-index: 1001;
      opacity: 0;
      transition: opacity 0.3s, transform 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .manwha-translator-toggle:hover {
      transform: scale(1.1);
    }
    
    img:hover + .manwha-translator-toggle,
    .manwha-translator-toggle:hover,
    img:hover ~ .manwha-translator-toggle {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);

  console.log('🌸 Manwha Translator loaded!');
})();
