import TurndownService from 'turndown';

// ── Idempotency guard ───────────────────────────────────────────────────────
// Chrome's scripting.executeScript() does NOT deduplicate injections.
// If this script is injected more than once into the same page (e.g., on
// transient sendMessage failures), registering a second onMessage listener
// would cause clip-frame / clip-selection to fire twice → two downloads.
// The window-level flag ensures we bail out on any subsequent injection.
declare const __clipperContentLoaded: boolean | undefined;
if ((window as Window & { __clipperContentLoaded?: boolean }).__clipperContentLoaded) {
    // Already registered — do nothing and let the existing listener handle it.
    throw new Error('[Clipper] Already loaded — skipping duplicate registration.');
}
(window as Window & { __clipperContentLoaded?: boolean }).__clipperContentLoaded = true;
// ───────────────────────────────────────────────────────────────────────────

// Track the last right-clicked element
let lastRightClickedElement: Element | null = null;

document.addEventListener('contextmenu', (e: MouseEvent) => {
    lastRightClickedElement = e.target as Element;
});

/** Tags whose content should never be the clip target */
const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'HEAD', 'META', 'LINK'
]);

/**
 * Walk up the DOM tree from the target element to find the best semantic
 * container to clip. Prefers role="article", semantic HTML5 tags, then
 * meaningful divs. Guards against selecting containers that span the whole
 * viewport (like navbars and sidebars).
 */
function findBestContainer(el: Element): Element {
    const semanticTags = new Set([
        'ARTICLE', 'SECTION', 'BLOCKQUOTE', 'FIGURE'
    ]);

    let current: Element | null = el;
    let best: Element = el;

    while (current && current !== document.body) {
        const tag = current.tagName.toUpperCase();

        // Skip non-content elements
        if (SKIP_TAGS.has(tag)) {
            current = current.parentElement;
            continue;
        }

        const role = current.getAttribute('role');

        // role="article" is ideal for FB/Twitter posts — but guard against
        // containers that are almost as tall as the full viewport (navigation).
        if (role === 'article' && !isFullViewport(current)) {
            return current;
        }

        // Semantic HTML5 elements (not nav/header/footer which tend to be chrome)
        if (semanticTags.has(tag) && !isFullViewport(current)) {
            return current;
        }

        // Facebook: data-pagelet="permalink_post_*" wraps the post on its own page
        const pagelet = current.getAttribute('data-pagelet') ?? '';
        if (pagelet.toLowerCase().includes('post') && !isFullViewport(current)) {
            return current;
        }

        // Accept any div/li/td with substantial visible text, not spanning viewport
        if (['DIV', 'LI', 'TD', 'P'].includes(tag)) {
            const text = getVisibleText(current);
            if (text.length > 100 && !isFullViewport(current)) {
                best = current;
            }
        }

        // Don't climb past body's direct children (avoids whole-page captures)
        if (current.parentElement === document.body) {
            break;
        }

        current = current.parentElement;
    }

    return best;
}

/**
 * Returns true if the element's bounding box covers most of the viewport
 * height — a signal that it's a layout shell (nav, sidebar, page wrapper)
 * rather than a content block.
 */
function isFullViewport(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // Flag if element is taller than 80 % of the visible viewport
    return rect.height > vh * 0.80;
}

/**
 * Extract only visible text (skips script/style nodes).
 */
function getVisibleText(el: Element): string {
    let text = '';
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent ?? '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = (node as Element).tagName?.toUpperCase();
            if (!SKIP_TAGS.has(tag)) {
                text += getVisibleText(node as Element);
            }
        }
    }
    return text.trim();
}

/**
 * Clone an element and strip all non-content elements before MD conversion.
 */
function cleanForMarkdown(el: Element): Element {
    const clone = el.cloneNode(true) as Element;
    const selectors = [
        'script', 'style', 'noscript', 'svg', 'link', 'meta',
        '[aria-hidden="true"]',
        '[style*="display:none"]',
        '[style*="display: none"]',
        '[style*="visibility:hidden"]',
        'img[src^="data:image/svg+xml"]',
        'img[src^="data:image/png;base64"]',
        'img[src^="data:image/jpeg;base64"]'
    ].join(', ');
    clone.querySelectorAll(selectors).forEach(n => n.remove());
    return clone;
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

/** Cleanup excessive whitespace and blank lines */
function cleanupMarkdown(markdown: string): string {
    return markdown
        .replace(/\n{2,}/g, '\n') // Collapse 2+ newlines into 1
        .replace(/[ \t]+\n/g, '\n')  // Remove trailing spaces on lines
        .trim();
}

/** Build YAML front-matter + filename */
function buildDocument(
    markdown: string,
    pageTitle: string,
    pageUrl: string,
    sectionTitle: string,
    clippedAt: string
): { content: string; filename: string } {
    const cleanedMarkdown = cleanupMarkdown(markdown);
    const frontMatter = [
        '---',
        `title: "${pageTitle.replace(/"/g, '\\"')}"`,
        `url: "${pageUrl}"`,
        `clipped_at: ${clippedAt}`,
        '---',
        '',
    ].join('\n');

    const datePrefix = clippedAt.substring(0, 10);
    const filename = `clip-${datePrefix}-${sanitizeFilename(sectionTitle)}.md`;
    return { content: frontMatter + cleanedMarkdown, filename };
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

/**
 * Clip the right-clicked frame (semantic block) as Markdown.
 */
function clipFrame(): void {
    const target = lastRightClickedElement ?? document.body;

    // Skip if target is a non-content element, walk up to a real one
    let safeTarget: Element = target;
    while (SKIP_TAGS.has(safeTarget.tagName?.toUpperCase()) && safeTarget.parentElement) {
        safeTarget = safeTarget.parentElement;
    }

    const container = findBestContainer(safeTarget);
    const cleaned = cleanForMarkdown(container);

    const pageTitle = document.title || 'Untitled';
    const pageUrl = window.location.href;
    const clippedAt = new Date().toISOString();

    const headingEl = cleaned.querySelector('h1, h2, h3, h4, h5, h6');
    const sectionTitle = headingEl?.textContent?.trim() || pageTitle;

    const markdown = makeTurndown().turndown(cleaned.outerHTML);
    const { content, filename } = buildDocument(markdown, pageTitle, pageUrl, sectionTitle, clippedAt);
    downloadMarkdown(content, filename);
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

    // Extract the selected HTML via a temporary container
    const fragment = sel.getRangeAt(0).cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(fragment);

    const cleaned = cleanForMarkdown(wrapper);

    const pageTitle = document.title || 'Untitled';
    const pageUrl = window.location.href;
    const clippedAt = new Date().toISOString();

    // Use first heading in selection, then first ~40 chars of text, then page title
    const headingEl = cleaned.querySelector('h1, h2, h3, h4, h5, h6');
    const rawText = cleaned.textContent?.trim().substring(0, 40) ?? '';
    const sectionTitle = headingEl?.textContent?.trim() || rawText || pageTitle;

    const markdown = makeTurndown().turndown(cleaned.outerHTML);
    const { content, filename } = buildDocument(markdown, pageTitle, pageUrl, sectionTitle, clippedAt);
    downloadMarkdown(content, filename);
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
        clipFrame();
    } else if (message.action === 'clip-selection') {
        clipSelection();
    } else if (message.action === 'get-all-images') {
        const images = getAllImages();
        sendResponse({ urls: images });
    }
    return true; // Keep channel open for async if needed
});
