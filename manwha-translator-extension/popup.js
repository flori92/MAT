// Popup script for Manwha Translator Extension

document.addEventListener('DOMContentLoaded', async () => {
  const CONTENT_SCRIPT_FILES = ['site-adapters.js', 'content.js'];

  // Elements
  const translateBtn = document.getElementById('translateBtn');
  const autoTranslateBtn = document.getElementById('autoTranslateBtn');
  const resetBtn = document.getElementById('resetBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const autoStatus = document.getElementById('autoStatus');
  const displayMode = document.getElementById('displayMode');
  const ocrEngine = document.getElementById('ocrEngine');
  const keepOriginal = document.getElementById('keepOriginal');
  const infoBox = document.getElementById('infoBox');
  const imageCount = document.getElementById('imageCount');
  const translatedCount = document.getElementById('translatedCount');
  const backendUrl = document.getElementById('backendUrl');
  const backendToken = document.getElementById('backendToken');
  const backendStatus = document.getElementById('backendStatus');

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function ensureContentScript(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch (error) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES
      });
    }
  }

  function getCurrentSettings() {
    return {
      displayMode: displayMode.value,
      ocrEngine: ocrEngine.value,
      keepOriginal: keepOriginal.classList.contains('active')
    };
  }

  function updateBackendStatus(isHealthy = false) {
    backendStatus.classList.toggle('active', isHealthy || !!backendUrl.value.trim());
  }

  async function refreshBackendHealth() {
    try {
      const result = await chrome.runtime.sendMessage({ action: 'backendHealth' });
      const isHealthy = !!result?.ok;
      updateBackendStatus(isHealthy);
      if (!isHealthy && result?.backendUrl) {
        showInfo(`Backend indisponible: ${result.backendUrl}`);
      }
    } catch (error) {
      updateBackendStatus(false);
    }
  }

  // Load saved settings
  const settings = await chrome.storage.local.get({
    autoTranslate: false,
    displayMode: 'overlay',
    ocrEngine: 'auto',
    keepOriginal: false,
    imageCount: 0,
    translatedCount: 0,
    backendUrl: 'http://127.0.0.1:8787',
    backendToken: ''
  });

  // Apply saved settings
  displayMode.value = settings.displayMode;
  ocrEngine.value = settings.ocrEngine === 'tesseract' ? 'auto' : settings.ocrEngine;
  if (!ocrEngine.value) {
    ocrEngine.value = 'auto';
  }
  keepOriginal.classList.toggle('active', settings.keepOriginal);
  autoStatus.textContent = settings.autoTranslate ? 'ON' : 'OFF';
  imageCount.textContent = settings.imageCount;
  translatedCount.textContent = settings.translatedCount;
  backendUrl.value = settings.backendUrl;
  backendToken.value = settings.backendToken;
  updateBackendStatus();

  // Get current tab stats
  try {
    const tab = await getActiveTab();
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStats' });
    if (response) {
      imageCount.textContent = response.imageCount || 0;
      translatedCount.textContent = response.translatedCount || 0;
    }
  } catch (e) {
    // Tab might not have content script loaded
  }

  // Toggle keep original
  keepOriginal.addEventListener('click', () => {
    keepOriginal.classList.toggle('active');
    chrome.storage.local.set({ keepOriginal: keepOriginal.classList.contains('active') });
  });

  // Display mode change
  displayMode.addEventListener('change', () => {
    chrome.storage.local.set({ displayMode: displayMode.value });
  });

  // OCR engine change
  ocrEngine.addEventListener('change', () => {
    chrome.storage.local.set({ ocrEngine: ocrEngine.value });
  });

  if ((settings.ocrEngine || '') !== ocrEngine.value) {
    await chrome.storage.local.set({ ocrEngine: ocrEngine.value });
  }

  backendUrl.addEventListener('change', async () => {
    await chrome.storage.local.set({ backendUrl: backendUrl.value.trim() });
    updateBackendStatus();
    await refreshBackendHealth();
    showInfo('URL backend sauvegardée ✓');
  });

  backendToken.addEventListener('change', async () => {
    await chrome.storage.local.set({ backendToken: backendToken.value.trim() });
    await refreshBackendHealth();
    showInfo('Jeton backend sauvegardé ✓');
  });

  // Auto translate toggle
  autoTranslateBtn.addEventListener('click', async () => {
    const current = await chrome.storage.local.get('autoTranslate');
    const newValue = !current.autoTranslate;
    await chrome.storage.local.set({ autoTranslate: newValue });
    autoStatus.textContent = newValue ? 'ON' : 'OFF';
    
    // Notify content script
    const tab = await getActiveTab();
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      action: 'setAutoTranslate',
      value: newValue,
      settings: getCurrentSettings()
    });
    
    showInfo(newValue ? 'Traduction automatique activée' : 'Traduction automatique désactivée');
  });

  // Translate button
  translateBtn.addEventListener('click', async () => {
    setTranslating(true);
    
    try {
      const tab = await getActiveTab();
      await ensureContentScript(tab.id);

      const response = await chrome.tabs.sendMessage(tab.id, { 
        action: 'translatePage',
        settings: getCurrentSettings()
      });

      if (response && response.success) {
        statusText.textContent = 'Traduction terminée !';
        translatedCount.textContent = response.translatedCount || 0;
        showInfo(`${response.translatedCount} image(s) traduite(s)`);
      } else {
        statusText.textContent = 'Erreur de traduction';
        showInfo('Erreur: ' + (response?.error || 'Inconnue'));
      }
    } catch (error) {
      statusText.textContent = 'Erreur de connexion';
      showInfo('Erreur: ' + error.message);
    } finally {
      setTranslating(false);
    }
  });

  // Reset button
  resetBtn.addEventListener('click', async () => {
    try {
      const tab = await getActiveTab();
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { action: 'reset' });
      statusText.textContent = 'Page réinitialisée';
      translatedCount.textContent = '0';
      showInfo('Toutes les traductions ont été supprimées');
    } catch (error) {
      showInfo('Erreur: ' + error.message);
    }
  });

  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress') {
      progressFill.style.width = message.percent + '%';
      statusText.textContent = message.status;
    }
    if (message.action === 'stats') {
      imageCount.textContent = message.imageCount;
      translatedCount.textContent = message.translatedCount;
    }
  });

  function setTranslating(isTranslating) {
    translateBtn.disabled = isTranslating;
    progressBar.classList.toggle('active', isTranslating);
    statusDot.classList.toggle('inactive', isTranslating);
    if (isTranslating) {
      statusText.textContent = 'Traduction en cours...';
      progressFill.style.width = '0%';
    }
  }

  function showInfo(message) {
    infoBox.textContent = message;
    infoBox.style.display = 'block';
    setTimeout(() => {
      infoBox.style.display = 'none';
    }, 3000);
  }

  await refreshBackendHealth();
});
