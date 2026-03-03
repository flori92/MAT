// Site adapter registry for common manhwa readers.

(function () {
  'use strict';

  const GENERIC_SELECTORS = [
    'img',
    '.reader-image',
    '.chapter-image',
    '.manga-image',
    '.scan-image',
    '.wp-manga-chapter-img',
    '.reading-content img',
    '.page-break img',
    '#reader img',
    '.viewer img',
    '[data-src]'
  ];

  const SOURCE_ATTRIBUTES = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-url',
    'data-cfsrc',
    'data-echo',
    'data-pagespeed-lazy-src'
  ];

  const SITE_ADAPTERS = [
    {
      id: 'madara',
      hosts: [/asurascans/i, /reaperscans/i, /flamescans/i, /voidscans/i, /nightscans/i, /mangafire/i],
      readerRoots: ['.reading-content', '.entry-content', '.chapter-content', '.container-chapter-reader'],
      selectors: ['.reading-content img', '.wp-manga-chapter-img', '.chapter-content img']
    },
    {
      id: 'toonily',
      hosts: [/toonily/i, /manhwaclan/i, /manhwatop/i],
      readerRoots: ['.chapter-content', '.chapter-container', '.read-container'],
      selectors: ['.chapter-content img', '.read-container img', '.chapter-container img']
    },
    {
      id: 'generic-reader',
      hosts: [/webtoon/i, /manga/i, /manhwa/i],
      readerRoots: ['#reader', '.reader', '.viewer', '.chapter-reader', '.reader-main'],
      selectors: ['#reader img', '.viewer img', '.chapter-reader img', '.reader-main img']
    }
  ];

  function getHostname(urlValue = location.href) {
    try {
      return new URL(urlValue).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function getActiveAdapter(urlValue = location.href) {
    const hostname = getHostname(urlValue);
    return SITE_ADAPTERS.find(adapter => adapter.hosts.some(pattern => pattern.test(hostname))) || null;
  }

  function extractFromSrcset(srcset) {
    if (!srcset) {
      return '';
    }

    const firstEntry = String(srcset).split(',')[0]?.trim() || '';
    return firstEntry.split(/\s+/)[0] || '';
  }

  function resolveImageSource(img) {
    if (!img) {
      return '';
    }

    if (img.currentSrc) {
      return img.currentSrc;
    }

    for (const attribute of SOURCE_ATTRIBUTES) {
      const value = img.getAttribute(attribute);
      if (value) {
        return value;
      }
    }

    const srcset = img.getAttribute('srcset') || img.dataset?.srcset;
    return extractFromSrcset(srcset);
  }

  function primeImageElement(img) {
    if (!img) {
      return img;
    }

    const resolved = resolveImageSource(img);
    if (!img.src && resolved) {
      img.src = resolved;
    }

    if (img.loading === 'lazy') {
      img.loading = 'eager';
    }

    return img;
  }

  function collectCandidateImages(doc = document) {
    const adapter = getActiveAdapter(doc.location?.href || location.href);
    const selectors = new Set([
      ...GENERIC_SELECTORS,
      ...(adapter?.selectors || [])
    ]);

    const candidates = [];
    for (const selector of selectors) {
      doc.querySelectorAll(selector).forEach(node => {
        if (node?.tagName === 'IMG' && !candidates.includes(node)) {
          candidates.push(primeImageElement(node));
        }
      });
    }

    return candidates;
  }

  window.ManwhaSiteAdapters = {
    GENERIC_SELECTORS,
    SITE_ADAPTERS,
    getActiveAdapter,
    resolveImageSource,
    primeImageElement,
    collectCandidateImages
  };
})();
