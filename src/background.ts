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
            // Option 1: Direct Send (No Prepended Prompt)
            if (info.selectionText) fullText = info.selectionText;

        } else if (menuId.startsWith('gemini-prompt-')) {
            // Option 2: Pre-prompt Send
            const index = parseInt(menuId.replace('gemini-prompt-', ''), 10);
            const selectedPrompt = prompts[index];
            if (!selectedPrompt) return;

            if (info.selectionText) {
                fullText = `${selectedPrompt}\n\n以下為輸入內容:\n${info.selectionText}`;
            } else {
                fullText = selectedPrompt;
            }

        } else if (menuId.startsWith('gemini-gem-')) {
            // Option 3: Send to a specific Gem directly (No Prepended Prompt)
            const index = parseInt(menuId.replace('gemini-gem-', ''), 10);
            const selectedGem = gems[index];
            if (!selectedGem) return;

            destinationUrl = `https://gemini.google.com/gem/${selectedGem.id}`;
            if (info.selectionText) fullText = info.selectionText;
        }

        // Only save state and open tab if there is text OR an image. 
        if (fullText || pendingGeminiImage) {
            const storageData: any = {};
            if (fullText) storageData.pendingGeminiPrompt = fullText;
            if (pendingGeminiImage) storageData.pendingGeminiImage = pendingGeminiImage;

            await chrome.storage.local.set(storageData);
            chrome.tabs.create({ url: destinationUrl });
        }
    }
});
