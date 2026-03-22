import Defuddle from 'defuddle/full';
import TurndownService from 'turndown';

// ── Idempotency guard ───────────────────────────────────────────────────────
// Chrome's scripting.executeScript() does NOT deduplicate injections.
// If this script is injected more than once into the same page (e.g., on
// transient sendMessage failures), registering a second onMessage listener
// would cause clip-frame / clip-selection to fire twice → two downloads.
// The window-level flag ensures we bail out on any subsequent injection.
declare const __clipperContentLoaded: boolean | undefined;
if ((window as any).__clipperContentLoaded) {
    throw new Error('[Clipper] Already loaded — skipping duplicate registration.');
}
(window as any).__clipperContentLoaded = true;
// ───────────────────────────────────────────────────────────────────────────

// Track the last right-clicked element
let lastRightClickedElement: Element | null = null;

document.addEventListener('contextmenu', (e: MouseEvent) => {
    lastRightClickedElement = e.target as Element;
});

/**
 * Sanitize a string to be a safe filename.
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 80)
        .trim();
}

/** Shared Turndown instance factory */
function makeTurndown(): TurndownService {
    const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
    });
    td.addRule('strikethrough', {
        filter: ['del', 's'] as any,
        replacement: (content: string) => `~~${content}~~`
    });
    td.addRule('removeScripts', {
        filter: ['script', 'style', 'noscript'] as any,
        replacement: () => ''
    });
    // Convert links to plain text
    td.addRule('linksToText', {
        filter: 'a' as any,
        replacement: (content: string) => content
    });
    return td;
}

/** Trigger a file download in the browser */
function downloadMarkdown(content: string, filename: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** Cleanup excessive whitespace and blank lines */
function cleanupMarkdown(markdown: string): string {
    return markdown
        .replace(/\n{2,}/g, '\n\n') // Standardize to max 2 newlines
        .replace(/[ \t]+\n/g, '\n')  // Remove trailing spaces on lines
        .trim();
}

/**
 * Helper to build YAML front-matter from Defuddle metadata
 */
function buildFrontMatter(resp: any): string {
    const meta = [
        '---',
        `title: "${(resp.title || document.title || 'Untitled').replace(/"/g, '\\"')}"`,
        `url: "${window.location.href}"`,
    ];

    if (resp.author) meta.push(`author: "${resp.author.replace(/"/g, '\\"')}"`);
    if (resp.site) meta.push(`site: "${resp.site}"`);
    if (resp.published) meta.push(`published: "${resp.published}"`);
    if (resp.description) meta.push(`description: "${resp.description.replace(/"/g, '\\"')}"`);
    
    meta.push(`clipped_at: ${new Date().toISOString()}`);
    meta.push('---');
    meta.push('');
    
    return meta.join('\n');
}

/**
 * Clip the current page as Markdown using Defuddle.
 */
async function clipFrame(): Promise<void> {
    try {
        const resp = await new Defuddle(document, { 
            markdown: true, 
            separateMarkdown: true,
            useAsync: true 
        }).parseAsync();

        const frontMatter = buildFrontMatter(resp);
        const markdown = cleanupMarkdown(resp.contentMarkdown || resp.content || '');
        const finalContent = frontMatter + markdown;
        
        const datePrefix = new Date().toISOString().substring(0, 10);
        const filename = `clip-${datePrefix}-${sanitizeFilename(resp.title || 'article')}.md`;
        
        downloadMarkdown(finalContent, filename);
    } catch (err) {
        console.error('[Clipper] Defuddle extraction failed:', err);
        // Minimal fallback if Defuddle fails
        const md = `# ${document.title}\n\nExtraction failed. URL: ${window.location.href}`;
        downloadMarkdown(md, `clip-failed-${Date.now()}.md`);
    }
}

/**
 * Clip the current text selection as Markdown.
 */
function clipSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        console.warn('[Clipper] No text selected.');
        return;
    }

    const fragment = sel.getRangeAt(0).cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(fragment);

    // Minor cleanup for selection
    wrapper.querySelectorAll('script, style, noscript').forEach(n => n.remove());

    const pageTitle = document.title || 'Untitled';
    const pageUrl = window.location.href;
    const clippedAt = new Date().toISOString();

    const markdown = makeTurndown().turndown(wrapper.outerHTML);
    const cleanedMarkdown = cleanupMarkdown(markdown);
    
    const frontMatter = [
        '---',
        `title: "Selection from ${pageTitle.replace(/"/g, '\\"')}"`,
        `url: "${pageUrl}"`,
        `clipped_at: ${clippedAt}`,
        '---',
        '',
    ].join('\n');

    const datePrefix = clippedAt.substring(0, 10);
    const filename = `clip-selection-${datePrefix}.md`;
    
    downloadMarkdown(frontMatter + cleanedMarkdown, filename);
}

/**
 * Extract content as Markdown string (usually for Gemini).
 */
async function extractContent(): Promise<string> {
    try {
        const resp = await new Defuddle(document, { 
            markdown: true, 
            useAsync: true 
        }).parseAsync();
        
        const markdown = resp.contentMarkdown || resp.content || '';
        return `來自 ${resp.site || '網頁'} 的內容：\n\n${markdown}`;
    } catch (err) {
        console.error('[Clipper] Defuddle extraction failed:', err);
        return `無法擷取內容：${document.title}\n網址：${window.location.href}`;
    }
}

/**
 * Gather all image sources and return them.
 * Checks standard src, lazy-loading data attributes, and srcset.
 */
function getAllImages(): string[] {
    const urls = new Set<string>();
    const lazyAttrs = [
        'data-src', 'data-original', 'data-lazy-src', 'original-src',
        'data-actualsrc', 'data-src-retina', 'data-hi-res-src'
    ];

    function collectFromElement(root: ParentNode) {
        // 1. img tags
        root.querySelectorAll('img').forEach(img => {
            if (img.src && img.src.startsWith('http')) {
                urls.add(img.src);
            }
            for (const attr of lazyAttrs) {
                const val = img.getAttribute(attr);
                if (val && val.startsWith('http')) {
                    urls.add(val);
                }
            }
            if (img.srcset) {
                img.srcset.split(',').forEach(p => {
                    const url = p.trim().split(/\s+/)[0];
                    if (url && url.startsWith('http')) urls.add(url);
                });
            }
        });

        // 2. source tags
        root.querySelectorAll('source').forEach(source => {
            const srcset = source.getAttribute('srcset');
            if (srcset) {
                srcset.split(',').forEach(p => {
                    const url = p.trim().split(/\s+/)[0];
                    if (url && url.startsWith('http')) urls.add(url);
                });
            }
        });

        // 3. background-image in styles
        root.querySelectorAll('*').forEach(el => {
            const style = window.getComputedStyle(el);
            const bg = style.backgroundImage;
            if (bg && bg.startsWith('url("http')) {
                const url = bg.slice(5, -2);
                if (url) urls.add(url);
            }

            // 4. Check for Shadow DOM
            if (el.shadowRoot) {
                collectFromElement(el.shadowRoot);
            }
        });
    }
     collectFromElement(document);

    const result = Array.from(urls);
    console.log(`[Clipper] Found ${result.length} unique image URLs.`);
    return result;
}

/**
 * Extract visible text from the closest article container (legacy fallback)
 */
function getVisibleText(el: Element): string {
    let text = '';
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent ?? '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = (node as Element).tagName?.toUpperCase();
            if (!['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) {
                text += getVisibleText(node as Element);
            }
        }
    }
    return text.trim();
}

// Listen for commands from the background script
chrome.runtime.onMessage.addListener((message: { action: string; url?: string }, sender, sendResponse) => {
    console.log('[Clipper] Message received:', message.action);
    
    if (message.action === 'clip-frame') {
        clipFrame().then(() => sendResponse({ status: 'ok' }));
        return true; // Async response
    } 
    
    if (message.action === 'clip-selection') {
        clipSelection();
        sendResponse({ status: 'ok' });
        return false;
    } 
    
    if (message.action === 'extract-content') {
        extractContent().then(text => sendResponse({ text }));
        return true; // Async response
    }
    
    if (message.action === 'get-all-images') {
        const images = getAllImages();
        sendResponse({ urls: images });
        return false;
    }

    // Handle unknown actions
    sendResponse({ error: 'Unknown action' });
    return false;
});
