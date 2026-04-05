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

// Track the last right-clicked element and its position
let lastRightClickedElement: Element | null = null;
let lastClickX = 0;
let lastClickY = 0;

document.addEventListener('contextmenu', (e: MouseEvent) => {
    lastRightClickedElement = e.target as Element;
    lastClickX = e.clientX;
    lastClickY = e.clientY;
}, { capture: true });

/**
 * Helper to find the Facebook post container relative to a click.
 * Staff Level 2.2: Definitive Fuzzy Matching + Center-Screen Fallback.
 */
function findFacebookPostContainer(target: Element | null, x: number, y: number): Element | null {
    const isMainPost = (el: Element) => {
        const role = el.getAttribute('role');
        if (role !== 'article' && role !== 'dialog') return false;
        
        // 1. Structural Markers (Highly stable)
        if (el.hasAttribute('aria-posinset')) return true;
        
        // 2. Content Markers (Deep check for message or image containers)
        if (el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]')) return true;
        
        // 3. Featured/Pinned Markers
        if (el.getAttribute('data-testid') === 'fb-feed-item' || el.hasAttribute('data-bt')) return true;

        // 4. Broad check: Many posts have specific layout classes but always have an aria-label or describedby related to the user's name
        if (el.hasAttribute('aria-describedby') || el.hasAttribute('aria-labelledby')) return true;

        return false;
    };

    // 1. Direct Context Search (Upward from target)
    let current: Element | null = target;
    while (current) {
        const container = current.closest('div[role="article"], div[role="dialog"]');
        if (!container) break;
        if (isMainPost(container)) return container;
        current = container.parentElement;
    }

    // 2. Coordinate-Based Fuzzy Scan (Physical viewport overlap)
    // We use a much larger 100px buffer to handle gap/margin clicks.
    const allArticles = Array.from(document.querySelectorAll('div[role="article"], div[role="dialog"]'))
                            .filter(art => isMainPost(art));

    if (y > 0 && allArticles.length > 0) {
        let bestMatch: Element | null = null;
        let minDistance = Infinity;

        for (const art of allArticles) {
            const rect = art.getBoundingClientRect();
            // Check vertical overlap with a generous 100px buffer
            if (y >= rect.top - 100 && y <= rect.bottom + 100) {
                const centerY = rect.top + rect.height / 2;
                const distance = Math.abs(y - centerY);
                if (distance < minDistance) {
                    minDistance = distance;
                    bestMatch = art;
                }
            }
        }
        if (bestMatch) return bestMatch;
    }

    // 3. Ultimate Fallback: Target the article closest to the screen center
    // This is safer than the "First Post" bug because it's based on where the user is looking.
    if (allArticles.length > 0) {
        const viewportCenterY = window.innerHeight / 2;
        let closestToCenter: Element | null = null;
        let minCenterDistance = Infinity;

        for (const art of allArticles) {
            const rect = art.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const distance = Math.abs(viewportCenterY - centerY);
            if (distance < minCenterDistance) {
                minCenterDistance = distance;
                closestToCenter = art;
            }
        }
        return closestToCenter;
    }

    return null;
}

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

// ── Shared extraction result ─────────────────────────────────────────────────
interface ExtractedContent {
    markdown: string;       // cleanupMarkdown() 後的 Markdown（純空白正規化，不移除連結）
    title: string;
    siteName: string;
    author?: string;
    published?: string;
    description?: string;
}

/**
 * Core extraction engine shared by both clipFrame() and extractContent().
 * Handles Facebook coordinate-targeting AND general Defuddle extraction.
 *
 * @param overrideUrl  URL to pass to Defuddle (defaults to window.location.href)
 * @param options.stripLinks  If true, strips hyperlinks via Turndown rule.
 *   - Save as Markdown: false (preserve [text](url) for knowledge archiving)
 *   - Send to Gemini / Facebook: true (hashtag URLs are noise for LLM)
 */
async function extractPageContent(
    overrideUrl?: string,
    options?: { stripLinks?: boolean }
): Promise<ExtractedContent> {
    const url = overrideUrl || window.location.href;
    const stripLinks = options?.stripLinks ?? false;

    // --- Special Handling for Facebook ---
    if (url.includes('facebook.com')) {
        const container = findFacebookPostContainer(lastRightClickedElement, lastClickX, lastClickY);
        const fbContent = container
            ? container.querySelector('div[data-ad-preview="message"], div[data-ad-comet-preview="message"]')
            : null;

        if (fbContent) {
            const fbTd = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '-',
            });
            fbTd.addRule('removeNoise', {
                filter: ['script', 'style', 'noscript'] as any,
                replacement: () => ''
            });
            // Only strip links when destination is Gemini; Save as Markdown keeps them
            if (stripLinks) {
                fbTd.addRule('stripLinks', {
                    filter: 'a' as any,
                    replacement: (content: string) => content
                });
            }
            const markdown = cleanupMarkdown(fbTd.turndown(fbContent.innerHTML));
            return {
                markdown,
                title: document.title || 'Facebook Post',
                siteName: 'Facebook',
            };
        } else {
            throw new Error('無法精準定位您所點選的 Facebook 貼文內容。');
        }
    }
    // --- End Facebook Handling ---

    const resp = await new Defuddle(document, {
        url,
        markdown: true,
        separateMarkdown: true, // Required for contentMarkdown field (needs defuddle/full)
        useAsync: true
    }).parseAsync();

    return {
        markdown: cleanupMarkdown(resp.contentMarkdown || resp.content || ''),
        title: resp.title || document.title || 'Untitled',
        siteName: resp.site || new URL(url).hostname,
        author: resp.author,
        published: resp.published,
        description: resp.description,
    };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clip the current page as Markdown using the shared extractPageContent().
 * Preserves full links (stripLinks: false) — links are part of the archived knowledge.
 */
async function clipFrame(): Promise<void> {
    try {
        const extracted = await extractPageContent(window.location.href, { stripLinks: false });

        const frontMatter = buildFrontMatter({
            title: extracted.title,
            author: extracted.author,
            site: extracted.siteName,
            published: extracted.published,
            description: extracted.description,
        });
        const finalContent = frontMatter + extracted.markdown;

        const datePrefix = new Date().toISOString().substring(0, 10);
        const filename = `clip-${datePrefix}-${sanitizeFilename(extracted.title)}.md`;

        downloadMarkdown(finalContent, filename);
    } catch (err) {
        console.error('[Clipper] Extraction failed:', err);
        // Minimal fallback if extraction fails
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
 * Extract content as Markdown string for Gemini.
 * Delegates to extractPageContent() — the shared extraction core.
 * Facebook path strips links (stripLinks: true) because hashtag/mention URLs are LLM noise.
 */
async function extractContent(overrideUrl?: string): Promise<string> {
    try {
        const url = overrideUrl || window.location.href;
        // Strip links only for Facebook (hashtag URLs are meaningless for LLM)
        const stripLinks = url.includes('facebook.com');

        const extracted = await extractPageContent(url, { stripLinks });

        if (!extracted.markdown) return '';
        return `來自 ${extracted.siteName} 的內容：\n\n${extracted.markdown}`;
    } catch (err) {
        console.error('[Clipper] Extraction failed:', err);
        return ''; // Return empty string on failure to avoid polluting Gemini prompt
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
        extractContent(message.url).then(text => sendResponse({ text }));
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
