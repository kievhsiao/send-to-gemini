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
 * Staff Level 4.1: Unified Scoring Engine with expanded container detection.
 * Handles Timeline feed items (via aria-posinset) and Permalink posts.
 */
function findFacebookPostContainer(target: Element | null, x: number, y: number): Element | null {
    const scoreCandidate = (el: Element): number => {
        const role = el.getAttribute('role');
        const hasPosInSet = el.hasAttribute('aria-posinset');
        
        // Timeline shortcut: If it has aria-posinset, it's definitely a main post container.
        if (hasPosInSet) return 1000;
        
        // Standard role check
        if (role !== 'article' && role !== 'dialog') return -100;
        
        let s = 0;
        // 2. 內容標記 (通常僅出現在主貼文)
        if (el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) s += 50;
        if (el.querySelector('[data-testid="post_message"]')) s += 40;
        
        // 3. 結構標記
        if (el.hasAttribute('aria-labelledby') || el.hasAttribute('aria-describedby')) s += 30;

        // 4. 文字特徵
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('post')) s += 20;

        // 5. 負向標記 (排斥留言、回覆)
        // Only apply strong negative scores to non-posinset articles (Permalinks)
        if (label.includes('comment') || label.includes('reply')) s -= 60;
        if (el.classList.contains('comment') || el.closest('[role="complementary"]')) s -= 40;

        return s;
    };

    // --- 三階段定位策略 ---

    // 1. Path Lookup (向上尋找評分最高的容器)
    let curr: Element | null = target;
    while (curr) {
        const container = curr.closest('[role="article"], [role="dialog"], [aria-posinset]');
        if (!container) break;
        if (scoreCandidate(container) >= 20) return container;
        curr = container.parentElement;
    }

    // 2. Point Lookup (座標命中)
    if (x > 0 && y > 0) {
        const hitEl = document.elementFromPoint(x, y);
        let hitCurr: Element | null = hitEl;
        while (hitCurr) {
            const container = hitCurr.closest('[role="article"], [role="dialog"], [aria-posinset]');
            if (!container) break;
            if (scoreCandidate(container) >= 20) return container;
            hitCurr = container.parentElement;
        }
    }

    // 3. Viewport Selection (全域掃描分數 > 0 且最顯眼的文章)
    const allCandidates = Array.from(document.querySelectorAll('[role="article"], [role="dialog"], [aria-posinset]'));
    const scoredList = allCandidates
        .map(el => ({ el, s: scoreCandidate(el) }))
        .filter(c => c.s >= 20);

    if (scoredList.length > 0) {
        if (y > 0) {
            let best = scoredList[0].el;
            let minD = Infinity;
            for (const item of scoredList) {
                const rect = item.el.getBoundingClientRect();
                const d = (y >= rect.top && y <= rect.bottom) ? 0 : Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
                if (d < minD) { minD = d; best = item.el; }
                if (d === 0) break;
            }
            return best;
        } else {
            const centerY = window.innerHeight / 2;
            let best = scoredList[0].el;
            let minD = Infinity;
            for (const item of scoredList) {
                const rect = item.el.getBoundingClientRect();
                const d = Math.abs(centerY - (rect.top + rect.height / 2));
                if (d < minD) { minD = d; best = item.el; }
            }
            return best;
        }
    }

    return null;
}






/**
 * Helper to find the X.com (Twitter) tweet container.
 */
function findXPostContainer(target: Element | null, x: number, y: number): Element | null {
    // 1. Direct path via data-testid
    const byClosest = target?.closest('article[data-testid="tweet"]');
    if (byClosest) return byClosest;

    // 2. elementFromPoint fallback
    if (x > 0 && y > 0) {
        const hitEl = document.elementFromPoint(x, y);
        const byHit = hitEl?.closest('article[data-testid="tweet"]');
        if (byHit) return byHit;
    }

    // 3. Viewport fallback — only return if y is actually inside a tweet rect
    const allTweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const tweet of allTweets) {
        const rect = tweet.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return tweet;
    }
    // Cannot determine which tweet was targeted — return null so Defuddle can handle
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
        // Expanded selectors: [data-ad-preview] for ads, [data-testid="post_message"] for general posts.
        // Use div[dir="auto"] (not [dir="auto"]) to avoid matching author name spans.
        const fbContent = container
            ? container.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"], div[dir="auto"]')
            : null;

        if (fbContent) {
            const fbTd = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '-',
            });
            fbTd.addRule('removeNoise', {
                filter: ['script', 'style', 'noscript', 'button', 'svg'] as any,
                replacement: () => ''
            });
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
        } else if (container) {
            // Fallback: content selector missed — convert the full article container.
            // Respect stripLinks so Save-as-Markdown preserves links correctly.
            const fbFallbackTd = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
            fbFallbackTd.addRule('removeNoise', {
                filter: ['script', 'style', 'noscript', 'button', 'svg'] as any,
                replacement: () => ''
            });
            if (stripLinks) {
                fbFallbackTd.addRule('stripLinks', {
                    filter: 'a' as any,
                    replacement: (content: string) => content
                });
            }
            const markdown = cleanupMarkdown(fbFallbackTd.turndown(container.outerHTML));
            return { markdown, title: document.title || 'Facebook Post', siteName: 'Facebook' };
        } else {
            // No container found at all — should be rare after Phase 2 relaxed detection.
            // Do NOT fall through to Defuddle: it grabs the entire FB page (multiple posts).
            throw new Error('無法精準定位您所點選的 Facebook 貼文內容。');
        }
    }
    // --- End Facebook Handling ---

    // --- Special Handling for X.com (Twitter) ---
    if (url.match(/https?:\/\/(x|twitter)\.com/) && !url.includes('/status/')) {
        const container = findXPostContainer(lastRightClickedElement, lastClickX, lastClickY);
        const tweetText = container?.querySelector('[data-testid="tweetText"]');
        const userName = container?.querySelector('[data-testid="User-Name"]');
        
        if (container && (tweetText || userName)) {
            const td = makeTurndown();
            if (stripLinks) {
                td.addRule('stripLinks', {
                    filter: 'a' as any,
                    replacement: (content: string) => content
                });
            }
            const textMd = tweetText ? td.turndown(tweetText.innerHTML) : '';
            const author = userName ? (userName as HTMLElement).innerText.replace(/\n+/g, ' ') : 'Unknown';
            
            return {
                markdown: cleanupMarkdown(textMd),
                title: `Tweet by ${author}`,
                siteName: 'X (Twitter)',
                author: author
            };
        }
        // If it's single tweet page, fallback to Defuddle (which works well there)
    }
    // --- End X.com Handling ---

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
