function injectPrompt(text: string | undefined, imageData: { base64: string, mimeType: string } | undefined) {
    const maxRetries = 20;
    let retries = 0;

    const timer = setInterval(() => {
        // Gemini's input typically uses a contenteditable div
        const inputBox = document.querySelector('div[contenteditable="true"], .ql-editor') as HTMLElement;

        if (inputBox) {
            clearInterval(timer);

            inputBox.focus();

            if (text) {
                // Modern way to insert text if possible (works better with some rich text editors)
                const inserted = document.execCommand('insertText', false, text);

                // Fallback if execCommand fails
                if (!inserted) {
                    inputBox.textContent = text;
                    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            if (imageData) {
                try {
                    // Convert Base64 back to a byte array
                    const byteCharacters = atob(imageData.base64);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);

                    // Create Blob and File
                    const blob = new Blob([byteArray], { type: imageData.mimeType });
                    const file = new File([blob], "image.png", { type: imageData.mimeType });

                    // Create DataTransfer and dispatch paste event
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: dataTransfer,
                        bubbles: true,
                        cancelable: true
                    });
                    inputBox.dispatchEvent(pasteEvent);
                } catch (e) {
                    console.error("Successfully injected text, but failed to paste image.", e);
                }
            }
        }

        retries++;
        if (retries >= maxRetries) {
            clearInterval(timer);
            console.error('Send to Gemini: Input box not found.');
        }
    }, 500);
}

chrome.storage.local.get(['pendingGeminiPrompt', 'pendingGeminiImage'], (result) => {
    if (result.pendingGeminiPrompt || result.pendingGeminiImage) {
        injectPrompt(result.pendingGeminiPrompt, result.pendingGeminiImage);
        // Clear it so it doesn't trigger again on manual refresh
        chrome.storage.local.remove(['pendingGeminiPrompt', 'pendingGeminiImage']);
    }
});
