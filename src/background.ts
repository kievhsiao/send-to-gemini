import { DEFAULT_PROMPTS, Gem, STORAGE_KEY_PROMPTS, STORAGE_KEY_GEMS } from './shared';

chrome.runtime.onInstalled.addListener(async () => {
    const data = await chrome.storage.sync.get([STORAGE_KEY_PROMPTS, STORAGE_KEY_GEMS]);
    let prompts: string[] = data[STORAGE_KEY_PROMPTS];
    let gems: Gem[] = data[STORAGE_KEY_GEMS] || [];

    if (!prompts) {
        prompts = DEFAULT_PROMPTS;
        await chrome.storage.sync.set({ [STORAGE_KEY_PROMPTS]: prompts });
    }
    updateContextMenus(prompts, gems);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        chrome.storage.sync.get([STORAGE_KEY_PROMPTS, STORAGE_KEY_GEMS]).then(data => {
            updateContextMenus(data[STORAGE_KEY_PROMPTS] || DEFAULT_PROMPTS, data[STORAGE_KEY_GEMS] || []);
        });
    }
});

/** Structured result from Defuddle content script */
interface ExtractionResult {
    text: string;
}

function updateContextMenus(prompts: string[], gems: Gem[]) {
    chrome.contextMenus.removeAll(() => {
        // 1. Direct Send Action (requires selection)
        chrome.contextMenus.create({
            id: 'gemini-direct',
            title: '直接傳送 (Direct Send)',
            contexts: ['selection', 'image']
        });

        chrome.contextMenus.create({
            id: 'separator-1',
            type: 'separator',
            contexts: ['selection', 'image']
        });

        // 2. Prompt Actions (requires selection)
        prompts.forEach((prompt, index) => {
            chrome.contextMenus.create({
                id: `gemini-prompt-${index}`,
                title: prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt,
                contexts: ['selection', 'image']
            });
        });

        // 3. Gem Actions (requires selection)
        if (gems && gems.length > 0) {
            chrome.contextMenus.create({
                id: 'separator-2',
                type: 'separator',
                contexts: ['selection', 'image']
            });

            gems.forEach((gem, index) => {
                chrome.contextMenus.create({
                    id: `gemini-gem-${index}`,
                    title: `送至 Gem: ${gem.name}`,
                    contexts: ['selection', 'image']
                });
            });
        }

        // ── 全網頁全文擷取（page context 頂層項目，不選取文字時直接顯示）────
        chrome.contextMenus.create({
            id: 'gemini-page-direct',
            title: '直接傳送 (Direct Send)',
            contexts: ['page']
        });

        if (prompts.length > 0) {
            chrome.contextMenus.create({
                id: 'sep-page-prompts',
                type: 'separator',
                contexts: ['page']
            });
            prompts.forEach((prompt, index) => {
                chrome.contextMenus.create({
                    id: `gemini-page-prompt-${index}`,
                    title: prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt,
                    contexts: ['page']
                });
            });
        }

        if (gems && gems.length > 0) {
            chrome.contextMenus.create({
                id: 'sep-page-gems',
                type: 'separator',
                contexts: ['page']
            });
            gems.forEach((gem, index) => {
                chrome.contextMenus.create({
                    id: `gemini-page-gem-${index}`,
                    title: `送至 Gem: ${gem.name}`,
                    contexts: ['page']
                });
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        // 4. Web Clipper
        chrome.contextMenus.create({
            id: 'separator-clipper',
            type: 'separator',
            contexts: ['page', 'selection', 'image']
        });

        chrome.contextMenus.create({
            id: 'clipper-frame',
            title: '擷取框架內容 (Save as Markdown)',
            contexts: ['page', 'selection', 'image']
        });

        chrome.contextMenus.create({
            id: 'clipper-selection',
            title: '擷取選取內容 (Clip Selection)',
            contexts: ['selection']
        });

        // 5. Download Images
        chrome.contextMenus.create({
            id: 'separator-download',
            type: 'separator',
            contexts: ['page', 'selection', 'image']
        });

        chrome.contextMenus.create({
            id: 'download-all-images',
            title: '下載所有圖片檔 (Download All Images)',
            contexts: ['page', 'selection', 'image']
        });
    });
}

// Fix #2: Single, canonical ArrayBuffer → Base64 converter.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function prepareMediaData(info: chrome.contextMenus.OnClickData): Promise<{ base64: string; mimeType: string } | null> {
    if (info.mediaType === 'image' && info.srcUrl) {
        try {
            const response = await fetch(info.srcUrl);
            const blob = await response.blob();
            // Fix #2: reuse arrayBufferToBase64 instead of duplicating the logic
            const base64 = arrayBufferToBase64(await blob.arrayBuffer());
            return { base64, mimeType: blob.type };
        } catch (e) {
            console.error("Error fetching image", e);
        }
    }
    return null;
}

function executeDownload(url: string, tabUrl: string | undefined, withHeaders: boolean) {
    const options: chrome.downloads.DownloadOptions = { url: url };
    if (withHeaders && tabUrl && tabUrl.startsWith('http')) {
        options.headers = [{ name: 'Referer', value: tabUrl }];
    }

    try {
        chrome.downloads.download(options, (downloadId) => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message || 'Unknown error';
                console.error(`[Background] Download failed for ${url} (Headers: ${withHeaders}):`, errMsg);
                if (withHeaders) {
                    console.log(`[Background] Retrying ${url} WITHOUT headers...`);
                    executeDownload(url, tabUrl, false);
                }
            } else {
                console.log(`[Background] Download started: ${downloadId} for ${url}`);
            }
        });
    } catch (e: any) {
        console.error(`[Background] Exception calling chrome.downloads.download for ${url}:`, e.message);
        if (withHeaders) {
            executeDownload(url, tabUrl, false);
        }
    }
}


// Fix #3: Shared helper that sends a message to a content script, injecting
// clipper_content.js on-demand if not yet loaded.
//
// Per-tab injection cache: avoids redundant executeScript calls.
// Even though clipper_content.ts has its own idempotency guard, we track
// which tabs have been injected to skip the inject+wait round-trip entirely.
const injectedTabs = new Set<number>();

// Clear cache when the user navigates or closes a tab (the injected script
// will be gone and must be re-injected on the next action).
chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') injectedTabs.delete(tabId);
});

async function sendToContentScript(tabId: number, message: { action: string;[key: string]: unknown }): Promise<unknown> {
    if (!injectedTabs.has(tabId)) {
        try {
            const result = await chrome.tabs.sendMessage(tabId, message);
            injectedTabs.add(tabId);
            return result;
        } catch (err: any) {
            // Only retry on "Receiving end does not exist" (Standard content script missing error)
            const msg = err?.message || '';
            if (msg.includes('Receiving end does not exist')) {
                await chrome.scripting.executeScript({ target: { tabId }, files: ['clipper_content.js'] });
                await new Promise(r => setTimeout(r, 200));
                injectedTabs.add(tabId);
                return await chrome.tabs.sendMessage(tabId, message);
            }
            // If it's a port closed error, do NOT retry. Re-throw so caller knows the request was interrupted.
            throw err;
        }
    }
    return await chrome.tabs.sendMessage(tabId, message);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    let menuId = info.menuItemId.toString();

    // ── Normalize Page-specific sub-menu IDs to their generic equivalents ──
    const isPageMenu = menuId.startsWith('gemini-page-');
    if (isPageMenu) {
        menuId = menuId.replace('gemini-page-', 'gemini-');
    }
    // ───────────────────────────────────────────────────────────────────────

    if (menuId.startsWith('gemini-')) {
        const data = await chrome.storage.sync.get([STORAGE_KEY_PROMPTS, STORAGE_KEY_GEMS]);
        const prompts: string[] = data[STORAGE_KEY_PROMPTS] || DEFAULT_PROMPTS;
        const gems: Gem[] = data[STORAGE_KEY_GEMS] || [];

        let fullText = "";
        let destinationUrl = 'https://gemini.google.com/app';
        let pendingGeminiImage = await prepareMediaData(info);

        // --- CONTENT AUTO-FETCH LOGIC (including X.com) ---
        let baseText = info.selectionText;

        const isXcom = !!tab?.url?.match(/https?:\/\/(x|twitter)\.com/);
        // Only auto-fetch if:
        // 1. No text is selected
        // 2. AND (Explicit force from "Send Page Content" sub-menu OR (On X.com AND not right-clicking an image/video))
        const shouldAutoFetch = !baseText && (isPageMenu || (isXcom && !info.mediaType));

        if (shouldAutoFetch && tab?.id) {
            try {
                // Simplified: use Defuddle (via 'extract-content') for all cases
                // Pass tab.url to the content script to satisfy Defuddle's URL requirements
                const response = await sendToContentScript(tab.id, { 
                    action: 'extract-content',
                    url: tab.url 
                }) as { text?: string };
                if (response?.text) {
                    baseText = response.text;
                }
            } catch (err) {
                console.error('[Background] Failed to auto-extract content:', err);
            }
        }
        // --- END AUTO-FETCH LOGIC ---

        if (menuId === 'gemini-direct') {
            if (baseText) fullText = baseText;
        } else if (menuId.startsWith('gemini-prompt-')) {
            const index = parseInt(menuId.replace('gemini-prompt-', ''), 10);
            const selectedPrompt = prompts[index];
            if (!selectedPrompt) return;
            if (baseText) {
                fullText = `${selectedPrompt}\n\n以下為輸入內容：\n${baseText}`;
            } else {
                fullText = selectedPrompt;
            }
        } else if (menuId.startsWith('gemini-gem-')) {
            const index = parseInt(menuId.replace('gemini-gem-', ''), 10);
            const selectedGem = gems[index];
            if (!selectedGem) return;
            destinationUrl = `https://gemini.google.com/gem/${selectedGem.id}`;
            if (baseText) fullText = baseText;
        }

        if (fullText || pendingGeminiImage) {
            const storageData: Record<string, unknown> = {};
            if (fullText) storageData.pendingGeminiPrompt = fullText;
            if (pendingGeminiImage) storageData.pendingGeminiImage = pendingGeminiImage;
            await chrome.storage.local.set(storageData);
            chrome.tabs.create({ url: destinationUrl });
        }
    } else if (menuId === 'download-all-images') {
        if (tab?.id !== undefined) {
            const tabId = tab.id;
            console.log('[Background] Download All Images triggered for tab:', tabId, 'URL:', tab.url);

            if (!chrome.downloads) {
                console.error('[Background] chrome.downloads API is NOT available. Check manifest permissions.');
                return;
            }

            const tabUrl = tab.url;

            try {
                // Fix #3: use shared sendToContentScript helper
                const response = await sendToContentScript(tabId, { action: 'get-all-images' }) as { urls?: string[] };
                const urls = response?.urls || [];
                console.log('[Background] Found URLs count:', urls.length);

                if (urls.length > 0) {
                    const ruleId = 1;
                    console.log('[Background] Setting DNR rule for Referer:', tabUrl);
                    await chrome.declarativeNetRequest.updateDynamicRules({
                        removeRuleIds: [ruleId],
                        addRules: [{
                            id: ruleId,
                            priority: 1,
                            action: {
                                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                                requestHeaders: [{
                                    header: 'Referer',
                                    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                                    value: tabUrl || ''
                                }]
                            },
                            condition: {
                                urlFilter: '*',
                                resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
                            }
                        }]
                    });

                    for (let i = 0; i < urls.length; i++) {
                        const url = urls[i];
                        console.log(`[Background] Fetching image ${i + 1}/${urls.length}: ${url}`);
                        try {
                            const fetchResponse = await fetch(url);
                            if (!fetchResponse.ok) throw new Error(`HTTP ${fetchResponse.status}`);

                            const blob = await fetchResponse.blob();
                            // Fix #2: reuse arrayBufferToBase64
                            const base64 = arrayBufferToBase64(await blob.arrayBuffer());
                            const dataUrl = `data:${blob.type};base64,${base64}`;
                            executeDownload(dataUrl, undefined, false);
                        } catch (err) {
                            console.error(`[Background] Failed to fetch/download ${url}:`, err);
                            executeDownload(url, tabUrl, false);
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }

                    // Cleanup DNR rule
                    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
                } else {
                    console.warn('[Background] No image URLs returned. Try scrolling down?');
                }
            } catch (err) {
                console.error('[Background] Content script message failed:', err);
            }
        }
    } else if (menuId === 'clipper-frame') {
        if (tab?.id !== undefined) {
            // Fix #3: use shared sendToContentScript helper
            try {
                await sendToContentScript(tab.id, { action: 'clip-frame' });
            } catch (err) {
                console.error('[Clipper] Failed to inject or message content script:', err);
            }
        }
    } else if (menuId === 'clipper-selection') {
        if (tab?.id !== undefined) {
            // Fix #3: use shared sendToContentScript helper
            try {
                await sendToContentScript(tab.id, { action: 'clip-selection' });
            } catch (err) {
                console.error('[Clipper] Failed to inject or message content script:', err);
            }
        }
    }
});
