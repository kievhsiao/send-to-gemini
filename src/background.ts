const BG_DEFAULT_PROMPTS = [
    "翻譯以下文字: ",
    "Translate to English: ",
    "請總結這段文字: "
];

interface Gem {
    name: string;
    id: string;
}

chrome.runtime.onInstalled.addListener(async () => {
    const data = await chrome.storage.sync.get(['prompts', 'gems']);
    let prompts: string[] = data.prompts;
    let gems: Gem[] = data.gems || [];

    if (!prompts) {
        prompts = BG_DEFAULT_PROMPTS;
        await chrome.storage.sync.set({ prompts });
    }
    updateContextMenus(prompts, gems);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        chrome.storage.sync.get(['prompts', 'gems']).then(data => {
            updateContextMenus(data.prompts || BG_DEFAULT_PROMPTS, data.gems || []);
        });
    }
});

function updateContextMenus(prompts: string[], gems: Gem[]) {
    chrome.contextMenus.removeAll(() => {
        // 1. Direct Send Action
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

        // 2. Prompt Actions
        prompts.forEach((prompt, index) => {
            chrome.contextMenus.create({
                id: `gemini-prompt-${index}`,
                title: prompt.length > 20 ? prompt.substring(0, 20) + '...' : prompt,
                contexts: ['selection', 'image']
            });
        });

        // 3. Gem Actions
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

async function prepareMediaData(info: chrome.contextMenus.OnClickData): Promise<{ base64: string; mimeType: string } | null> {
    if (info.mediaType === 'image' && info.srcUrl) {
        try {
            const response = await fetch(info.srcUrl);
            const blob = await response.blob();

            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i += 8192) {
                const chunk = bytes.subarray(i, i + 8192);
                const chunkArray = Array.from(chunk);
                binary += String.fromCharCode.apply(null, chunkArray);
            }
            const base64 = btoa(binary);
            return { base64: base64, mimeType: blob.type };
        } catch (e) {
            console.error("Error fetching image", e);
        }
    }
    return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const menuId = info.menuItemId.toString();

    if (menuId.startsWith('gemini-')) {
        const data = await chrome.storage.sync.get(['prompts', 'gems']);
        const prompts: string[] = data.prompts || BG_DEFAULT_PROMPTS;
        const gems: Gem[] = data.gems || [];

        let fullText = "";
        let destinationUrl = 'https://gemini.google.com/app';
        let pendingGeminiImage = await prepareMediaData(info);

        if (menuId === 'gemini-direct') {
            if (info.selectionText) fullText = info.selectionText;
        } else if (menuId.startsWith('gemini-prompt-')) {
            const index = parseInt(menuId.replace('gemini-prompt-', ''), 10);
            const selectedPrompt = prompts[index];
            if (!selectedPrompt) return;
            if (info.selectionText) {
                fullText = `${selectedPrompt}\n\n以下為輸入內容:\n${info.selectionText}`;
            } else {
                fullText = selectedPrompt;
            }
        } else if (menuId.startsWith('gemini-gem-')) {
            const index = parseInt(menuId.replace('gemini-gem-', ''), 10);
            const selectedGem = gems[index];
            if (!selectedGem) return;
            destinationUrl = `https://gemini.google.com/gem/${selectedGem.id}`;
            if (info.selectionText) fullText = info.selectionText;
        }

        if (fullText || pendingGeminiImage) {
            const storageData: any = {};
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

            async function processDownloadRequest() {
                try {
                    const response = await chrome.tabs.sendMessage(tabId, { action: 'get-all-images' });
                    const urls = response?.urls || [];
                    console.log('[Background] Found URLs count:', urls.length);
                    
                    if (urls.length > 0) {
                        const ruleId = 1;
                        // Add DNR rule to inject Referer for all extension-initiated requests
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
                                const arrayBuffer = await blob.arrayBuffer();
                                const base64 = arrayBufferToBase64(arrayBuffer);
                                const dataUrl = `data:${blob.type};base64,${base64}`;
                                
                                executeDownload(dataUrl, undefined, false);
                            } catch (err) {
                                console.error(`[Background] Failed to fetch/download ${url}:`, err);
                                // Last resort: direct download
                                executeDownload(url, tabUrl, false);
                            }
                            await new Promise(r => setTimeout(r, 100));
                        }

                        // Cleanup rule
                        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
                    } else {
                        console.warn('[Background] No image URLs returned. Try scrolling down?');
                    }
                } catch (err) {
                    console.error('[Background] Messaging failed (F5 required):', err);
                    throw err;
                }
            }

            try {
                await processDownloadRequest();
            } catch (err) {
                console.log('[Background] Attempting content script injection fallback...');
                try {
                    await chrome.scripting.executeScript({ target: { tabId }, files: ['clipper_content.js'] });
                    await new Promise(r => setTimeout(r, 400));
                    await processDownloadRequest();
                } catch (injectErr) {
                    console.error('[Background] Injection fallback failed. Direct action to this page is blocked or script missing.', injectErr);
                }
            }
        }
    } else if (menuId === 'clipper-frame') {
        if (tab?.id !== undefined) {
            const tabId = tab.id;
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'clip-frame' });
            } catch (_e) {
                try {
                    await chrome.scripting.executeScript({ target: { tabId }, files: ['clipper_content.js'] });
                    await new Promise(r => setTimeout(r, 150));
                    await chrome.tabs.sendMessage(tabId, { action: 'clip-frame' });
                } catch (injectErr) {
                    console.error('[Clipper] Failed to inject or message content script:', injectErr);
                }
            }
        }
    } else if (menuId === 'clipper-selection') {
        if (tab?.id !== undefined) {
            const tabId = tab.id;
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'clip-selection' });
            } catch (_e) {
                try {
                    await chrome.scripting.executeScript({ target: { tabId }, files: ['clipper_content.js'] });
                    await new Promise(r => setTimeout(r, 150));
                    await chrome.tabs.sendMessage(tabId, { action: 'clip-selection' });
                } catch (injectErr) {
                    console.error('[Clipper] Failed to inject or message content script:', injectErr);
                }
            }
        }
    }
});
