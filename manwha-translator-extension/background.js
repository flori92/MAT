// Background Service Worker for Manwha Translator
// All extension network traffic is funneled through a single backend API.

const CONTENT_SCRIPT_FILES = ['site-adapters.js', 'content.js'];
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787';
const CACHE_PREFIX = 'cache_';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SUPPORTED_OCR_ENGINES = new Set(['auto', 'manga-stack', 'paddle', 'mangaocr', 'doctr', 'gemini', 'openai']);

function normalizeOcrEngine(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized === 'tesseract' || !SUPPORTED_OCR_ENGINES.has(normalized)) {
    return 'auto';
  }
  return normalized;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    return true;
  }
}

async function sendToTab(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    displayMode: 'overlay',
    ocrEngine: 'auto',
    keepOriginal: false
  });
}

async function getBackendSettings() {
  const settings = await chrome.storage.local.get({
    backendUrl: DEFAULT_BACKEND_URL,
    backendToken: '',
    ocrEngine: 'auto'
  });

  const backendUrl = String(settings.backendUrl || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, '');
  const backendToken = String(settings.backendToken || '').trim();

  return {
    backendUrl: backendUrl || DEFAULT_BACKEND_URL,
    backendToken,
    ocrEngine: normalizeOcrEngine(settings.ocrEngine)
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
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

async function fetchBackendJson(path, body, options = {}) {
  const { backendUrl, backendToken } = await getBackendSettings();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...options.headers
  };

  if (backendToken) {
    headers.Authorization = `Bearer ${backendToken}`;
  }

  let response;
  try {
    response = await fetchWithTimeout(`${backendUrl}${path}`, {
      method: options.method || 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }, options.timeoutMs || 30000);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `Backend trop lent ou indisponible: ${backendUrl}`
      : `Backend inaccessible: ${backendUrl}`;
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  }

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text ? { error: text } : null;
  }

  if (!response.ok) {
    const message = payload?.error || payload?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function getCachedTranslation(key) {
  const data = await chrome.storage.local.get(`${CACHE_PREFIX}${key}`);
  const cached = data[`${CACHE_PREFIX}${key}`];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.translation;
  }
  return null;
}

async function setCachedTranslation(key, translation) {
  await chrome.storage.local.set({
    [`${CACHE_PREFIX}${key}`]: {
      translation,
      timestamp: Date.now()
    }
  });
}

async function translateTextViaBackend(text, source = 'en', target = 'fr', context = null) {
  const payload = await fetchBackendJson('/v1/translate', {
    text,
    source,
    target,
    context
  }, { timeoutMs: 20000 });

  return payload?.translation || null;
}

async function aiOcrViaBackend(image, ocrEngine, context) {
  const payload = await fetchBackendJson('/v1/ai-ocr', {
    image,
    ocrEngine: normalizeOcrEngine(ocrEngine),
    context
  }, { timeoutMs: 90000 });

  return {
    blocks: Array.isArray(payload?.blocks) ? payload.blocks : [],
    engine: payload?.engine || 'backend'
  };
}

async function getBackendHealth() {
  const { backendUrl, backendToken } = await getBackendSettings();
  const headers = {
    'Accept': 'application/json'
  };

  if (backendToken) {
    headers.Authorization = `Bearer ${backendToken}`;
  }

  try {
    const response = await fetchWithTimeout(`${backendUrl}/health`, {
      method: 'GET',
      headers
    }, 5000);

    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      backendUrl,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      backendUrl,
      error: error.message
    };
  }
}

async function getStartupGuidance() {
  const { backendUrl } = await getBackendSettings();
  return {
    backendUrl,
    gatewayCommand: 'cd backend && npm start',
    ocrCommand: 'cd backend/ocr-pipeline && .venv312/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8788'
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translateImage',
    title: 'MAT · Traduire cette image',
    contexts: ['image']
  });

  chrome.contextMenus.create({
    id: 'translatePage',
    title: 'MAT · Traduire toutes les images',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  try {
    const settings = await getStoredSettings();

    if (info.menuItemId === 'translateImage') {
      await sendToTab(tab.id, {
        action: 'translateSingleImage',
        srcUrl: info.srcUrl,
        settings
      });
    } else if (info.menuItemId === 'translatePage') {
      await sendToTab(tab.id, {
        action: 'translatePage',
        settings
      });
    }
  } catch (error) {
    console.error('Context menu action failed:', error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'fetchImage':
      fetch(request.url)
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.blob();
        })
        .then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => sendResponse({ data: reader.result });
          reader.readAsDataURL(blob);
        })
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'translateText':
      translateTextViaBackend(request.text, request.source || 'en', request.target || 'fr', request.context || null)
        .then(translation => sendResponse({ translation }))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'aiOcrTranslate':
      aiOcrViaBackend(request.image, request.ocrEngine, request.context || null)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'backendHealth':
      getBackendHealth()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'startupGuidance':
      getStartupGuidance()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'cacheTranslation':
      setCachedTranslation(request.key, request.translation)
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;

    case 'getCachedTranslation':
      getCachedTranslation(request.key)
        .then(translation => sendResponse({ translation }))
        .catch(() => sendResponse({ translation: null }));
      return true;
  }
});

chrome.alarms.create('clearCache', { periodInMinutes: 60 * 24 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'clearCache') {
    return;
  }

  chrome.storage.local.get(null, (data) => {
    const now = Date.now();
    const keysToRemove = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith(CACHE_PREFIX) && now - value.timestamp > CACHE_TTL_MS) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove);
    }
  });
});

console.log('MAT background service loaded!');
