const { addonBuilder } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const https = require('https');

const BASE = 'https://www.thepornbang.com';
const CACHE_TTL = 5 * 60 * 1000; // 5 min cache
const cache = new Map();

// Keep-alive agent for better performance
const httpAgent = new https.Agent({
    keepAlive: true,
    timeout: 20000,
    maxSockets: 10,
});

const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function cachedFetch(url, ttl) {
    const now = Date.now();
    const effectiveTTL = ttl || CACHE_TTL;
    const cached = cache.get(url);
    if (cached && now - cached.ts < effectiveTTL) return cached.data;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url, {
                headers: FETCH_HEADERS,
                timeout: 20000,
                compress: false,
                agent: httpAgent,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.text();
            cache.set(url, { data, ts: now });
            return data;
        } catch (err) {
            if (attempt === 2) {
                console.error(`cachedFetch failed [${attempt+1}] for ${url}: ${err.message}`);
                throw err;
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}

function absUrl(href) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    return BASE + (href.startsWith('/') ? '' : '/') + href;
}

// Extract numeric video ID from URL segment like "flexible-fucking_v22"
function extractVideoNumId(segment) {
    const m = segment.match(/_v(\d+)$/);
    return m ? m[1] : null;
}

// Parse entity segment → { slug, typeChar, numId }
function parseSegment(segment) {
    const m = segment.match(/^(.+)_([cpstv])(\d+)$/);
    return m ? { slug: m[1], typeChar: m[2], numId: m[3] } : null;
}

// Slug to display name
function slugToName(slug) {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Scrapers ───────────────────────────────────────────────────────────────

// Scrape video cards from a listing page
async function scrapeVideoList(url) {
    const html = await cachedFetch(url);
    const $ = cheerio.load(html);
    const metas = [];
    const seen = new Set();

    $('div.row.item a.thumb, div.item a.thumb').each((_, el) => {
        try {
            const a = $(el);
            const href = a.attr('href') || '';
            const title = (a.attr('title') || a.find('span.text').text() || '').trim();
            if (!title || !href) return;

            const segMatch = href.match(/\/video\/([^/]+)\/?$/);
            if (!segMatch) return;
            const segment = segMatch[1];
            const numericId = extractVideoNumId(segment);
            if (!numericId) return;

            const id = `v_${segment}`;
            if (seen.has(id)) return;
            seen.add(id);

            const img = a.find('img.thumb-img');
            const poster = absUrl(img.attr('data-original') || img.attr('src') || '');
            const duration = a.find('span.duration span.value').text().trim();
            const views = a.find('span.views span.value').text().trim();
            const rating = a.find('div.rating').text().trim();
            const is4k = a.find('span.qhd').length > 0;
            const isHD = a.find('span.full, span.is-hd').length > 0;

            let qualityTag = '';
            if (is4k) qualityTag = ' 4K';
            else if (isHD) qualityTag = ' HD';

            metas.push({
                id: id,
                type: 'curvcorn',
                name: title,
                poster: poster,
                runtime: duration,
                description: `${views} views · ${rating}%${qualityTag}`,
            });
        } catch (e) { /* skip broken card */ }
    });

    return metas;
}

// Scrape category items
async function scrapeCategories(url) {
    const html = await cachedFetch(url);
    const $ = cheerio.load(html);
    const metas = [];
    const seen = new Set();

    $('a').each((_, el) => {
        try {
            const a = $(el);
            const href = a.attr('href') || '';
            const segMatch = href.match(/\/category\/([^/]+)\/?$/);
            if (!segMatch) return;
            const segment = segMatch[1];

            const id = `c_${segment}`;
            if (seen.has(id)) return;
            seen.add(id);

            const name = (a.find('div.text').text() || a.attr('title') || '').trim() || slugToName(segment.replace(/_[cpstv]\d+$/, ''));
            const img = a.find('img');
            const poster = absUrl(img.attr('data-original') || img.attr('src') || '');
            const count = a.find('span.videos, span.box-count span.value').text().trim();

            metas.push({
                id: id,
                type: 'curvcorn',
                name: name,
                poster: poster,
                description: count ? `${count} videos` : '',
            });
        } catch (e) { /* skip */ }
    });

    return metas;
}

// Scrape model/pornstar items
async function scrapeModels(url) {
    const html = await cachedFetch(url);
    const $ = cheerio.load(html);
    const metas = [];
    const seen = new Set();

    $('a').each((_, el) => {
        try {
            const a = $(el);
            const href = a.attr('href') || '';
            const segMatch = href.match(/\/pornstar\/([^/]+)\/?$/);
            if (!segMatch) return;
            const segment = segMatch[1];

            const id = `m_${segment}`;
            if (seen.has(id)) return;
            seen.add(id);

            const nameEl = a.find('span.name, div.name, .info-name');
            let name = nameEl.text().trim();
            if (!name) name = a.attr('title') || '';
            if (!name) name = slugToName(segment.replace(/_[cpstv]\d+$/, ''));

            const img = a.find('img');
            const poster = absUrl(img.attr('data-original') || img.attr('src') || '');
            const count = a.find('span.videos, span.box-count span.value').text().trim();

            metas.push({
                id: id,
                type: 'curvcorn',
                name: name,
                poster: poster,
                description: count ? `${count} videos` : '',
            });
        } catch (e) { /* skip */ }
    });

    return metas;
}

// Scrape studio/channel items
async function scrapeStudios(url) {
    const html = await cachedFetch(url);
    const $ = cheerio.load(html);
    const metas = [];
    const seen = new Set();

    $('a').each((_, el) => {
        try {
            const a = $(el);
            const href = a.attr('href') || '';
            const segMatch = href.match(/\/studio\/([^/]+)\/?$/);
            if (!segMatch) return;
            const segment = segMatch[1];

            const id = `s_${segment}`;
            if (seen.has(id)) return;
            seen.add(id);

            const nameEl = a.find('span.name, div.name, .info-name');
            let name = nameEl.text().trim();
            if (!name) name = a.attr('title') || '';
            if (!name) name = slugToName(segment.replace(/_[cpstv]\d+$/, ''));

            const img = a.find('img');
            const poster = absUrl(img.attr('data-original') || img.attr('src') || '');
            const count = a.find('span.videos, span.box-count span.value').text().trim();

            metas.push({
                id: id,
                type: 'curvcorn',
                name: name,
                poster: poster,
                description: count ? `${count} videos` : '',
            });
        } catch (e) { /* skip */ }
    });

    return metas;
}

// Scrape tag items
async function scrapeTags(url) {
    const html = await cachedFetch(url);
    const $ = cheerio.load(html);
    const metas = [];
    const seen = new Set();

    $('a').each((_, el) => {
        try {
            const a = $(el);
            const href = a.attr('href') || '';
            const segMatch = href.match(/\/tag\/([^/]+)\/?$/);
            if (!segMatch) return;
            const segment = segMatch[1];

            const id = `t_${segment}`;
            if (seen.has(id)) return;
            seen.add(id);

            const rawText = a.text().trim().replace(/\s+/g, ' ');
            const countMatch = rawText.match(/(\d[\d,.]*\d?)\s*$/);
            const count = countMatch ? countMatch[1] : '';
            let name = rawText.replace(/\d[\d,.]*\d?\s*$/, '').trim();
            if (!name) name = slugToName(segment.replace(/_[cpstv]\d+$/, ''));

            metas.push({
                id: id,
                type: 'curvcorn',
                name: name,
                poster: '',
                description: count ? `${count} videos` : '',
            });
        } catch (e) { /* skip */ }
    });

    return metas;
}

// ─── Video Detail / Meta ────────────────────────────────────────────────────

async function getVideoMeta(id) {
    const segment = id.replace('v_', '');
    const pageUrl = `${BASE}/video/${segment}/`;

    const html = await cachedFetch(pageUrl);
    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || segment;
    const description = $('meta[property="og:description"]').attr('content') || $('div.text-description, p.description').text().trim() || '';
    const poster = absUrl($('meta[property="og:image"]').attr('content') || '');
    const duration = $('meta[name="video:duration"]').attr('content') || '';
    const uploadDate = $('meta[name="ya:ovs:upload_date"]').attr('content') || '';

    // Extract models/pornstars
    const models = [];
    const modelIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/pornstar\/([^/]+)\/?$/);
        if (m && !modelIds.has(m[1])) {
            modelIds.add(m[1]);
            models.push({ id: `m_${m[1]}`, name: $(el).text().trim() });
        }
    });

    // Extract categories
    const categories = [];
    const catIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/category\/([^/]+)\/?$/);
        if (m && !catIds.has(m[1])) {
            catIds.add(m[1]);
            categories.push({ id: `c_${m[1]}`, name: $(el).text().trim() });
        }
    });

    // Extract tags
    const tags = [];
    const tagIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/tag\/([^/]+)\/?$/);
        if (m && !tagIds.has(m[1])) {
            tagIds.add(m[1]);
            const raw = $(el).text().trim().replace(/\d[\d,.]*\d?\s*$/, '').trim();
            if (raw) tags.push({ id: `t_${m[1]}`, name: raw });
        }
    });

    // Extract channel/studio
    const channels = [];
    const studioIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/studio\/([^/]+)\/?$/);
        if (m && !studioIds.has(m[1])) {
            studioIds.add(m[1]);
            channels.push({ id: `s_${m[1]}`, name: $(el).text().trim() });
        }
    });

    // Build links for cross-navigation
    const links = [];
    models.forEach(m => {
        links.push({ name: m.name, category: 'Models', url: `stremio:///detail/curvcorn/${m.id}` });
    });
    channels.forEach(c => {
        links.push({ name: c.name, category: 'Channels', url: `stremio:///detail/curvcorn/${c.id}` });
    });
    categories.forEach(c => {
        links.push({ name: c.name, category: 'Categories', url: `stremio:///detail/curvcorn/${c.id}` });
    });
    tags.forEach(t => {
        links.push({ name: t.name, category: 'Tags', url: `stremio:///detail/curvcorn/${t.id}` });
    });

    return {
        meta: {
            id: id,
            type: 'curvcorn',
            name: title,
            poster: poster,
            background: poster,
            description: description,
            runtime: duration ? `${Math.round(parseInt(duration) / 60)} min` : '',
            releaseInfo: uploadDate || '',
            genre: categories.map(c => c.name),
            cast: models.map(m => m.name),
            links: links,
        }
    };
}

// ─── Entity Meta (models, categories, studios, tags) ───────────────────────

async function getEntityMeta(id, entityType, urlPath) {
    const segment = id.replace(/^[mcst]_/, '');
    const pageUrl = `${BASE}/${urlPath}/${segment}/`;

    const html = await cachedFetch(pageUrl);
    const $ = cheerio.load(html);

    const name = $('h1').first().text().trim() || slugToName(segment.replace(/_[cpstv]\d+$/, ''));

    // Get poster image
    let poster = '';
    const mainImg = $('img.portrait, div.portrait img, div.box-img img, img.thumb-img').first();
    if (mainImg.length) {
        poster = absUrl(mainImg.attr('data-original') || mainImg.attr('src') || '');
    }

    // Scrape videos from this entity page
    const videos = [];
    const videoIds = new Set();

    function extractVideosFromPage($page) {
        $page('div.row.item a.thumb, div.item a.thumb').each((_, el) => {
            try {
                const a = $page(el);
                const href = a.attr('href') || '';
                const segMatch = href.match(/\/video\/([^/]+)\/?$/);
                if (!segMatch) return;
                const vSegment = segMatch[1];
                const vNumId = extractVideoNumId(vSegment);
                if (!vNumId) return;

                const vid = `v_${vSegment}`;
                if (videoIds.has(vid)) return;
                videoIds.add(vid);

                const vTitle = (a.attr('title') || a.find('span.text').text() || '').trim();
                const vImg = a.find('img.thumb-img');
                const vPoster = absUrl(vImg.attr('data-original') || vImg.attr('src') || '');
                const vDuration = a.find('span.duration span.value').text().trim();
                const vViews = a.find('span.views span.value').text().trim();

                videos.push({
                    id: vid,
                    title: vTitle,
                    thumbnail: vPoster,
                    duration: vDuration,
                    description: `${vViews} views`,
                    released: new Date().toISOString(),
                });
            } catch (e) { /* skip */ }
        });
    }

    extractVideosFromPage($);

    // Try page 2 and 3
    for (const pageNum of [2, 3]) {
        try {
            const nextUrl = `${BASE}/${urlPath}/${segment}/${pageNum}/`;
            const html2 = await cachedFetch(nextUrl, 60000); // longer cache for entity pages
            const $2 = cheerio.load(html2);
            extractVideosFromPage($2);
        } catch (e) { break; }
    }

    return {
        meta: {
            id: id,
            type: 'curvcorn',
            name: name,
            poster: poster,
            background: poster,
            description: `${videos.length} videos available`,
            videos: videos,
        }
    };
}

// ─── Stream Extraction ──────────────────────────────────────────────────────

// Quality labels for display in Stremio
const QUALITY_LABELS = {
    '2160': '4K UHD',
    '1080': '1080p FHD',
    '720': '720p HD',
    '480': '480p',
    '360': '360p',
};

async function getVideoStreams(id) {
    const segment = id.replace('v_', '');
    const pageUrl = `${BASE}/video/${segment}/`;

    // Fetch the video page to extract stream URLs from flashvars
    const html = await cachedFetch(pageUrl);

    const streams = [];

    // ── Extract direct MP4 stream URLs from flashvars ──
    // ThePornBang embeds stream URLs directly in the page's flashvars JavaScript:
    //   video_url: 'https://www.thepornbang.com/get_stream/{id}-{quality}.mp4?md5=...&timestamp=...'
    //   video_alt_url: '...720p...'
    //   video_alt_url2: '...1080p...'
    //   video_alt_url3: '...2160p...'
    //
    // These /get_stream/ URLs are redirect gateways:
    //   Request → 302 redirect → CDN (vkuser.net) → actual MP4 file
    // The CDN returns proper video/mp4 with Accept-Ranges: bytes support.
    // Stremio's internal player (MPV) follows 302 redirects natively,
    // and the CDN redirect uses the USER's IP (not our server's),
    // so IP-based auth on the CDN works correctly.
    //
    // Key discovery: The full URL with md5/timestamp params returns 302 to CDN.
    // The bare .mp4 URL (without params) may return HTML instead of a redirect.
    // So we MUST preserve the full URL with auth params.

    const streamUrls = [];
    const seen = new Set();

    // Pattern 1: Extract from flashvars key-value pairs
    // Matches: video_url: 'https://...get_stream/...', video_alt_url2: 'https://...get_stream/...'
    const flashvarsPattern = /video_(?:url|alt_url\d*)\s*:\s*'([^']*get_stream\/[^']+)'/gi;
    let match;
    while ((match = flashvarsPattern.exec(html)) !== null) {
        const url = match[1];
        if (!seen.has(url)) {
            seen.add(url);
            streamUrls.push(url);
        }
    }

    // Pattern 2: Broader fallback - any get_stream URL in quotes
    if (streamUrls.length === 0) {
        const broadPattern = /['"](https?:\/\/[^'"]+\/get_stream\/\d+-\d+\.mp4\?[^'"]+)['"]/gi;
        while ((match = broadPattern.exec(html)) !== null) {
            const url = match[1];
            if (!seen.has(url)) {
                seen.add(url);
                streamUrls.push(url);
            }
        }
    }

    // Pattern 3: Relative URL fallback
    if (streamUrls.length === 0) {
        const relPattern = /['"](\/get_stream\/\d+-\d+\.mp4\?[^'"]+)['"]/gi;
        while ((match = relPattern.exec(html)) !== null) {
            const url = BASE + match[1];
            if (!seen.has(url)) {
                seen.add(url);
                streamUrls.push(url);
            }
        }
    }

    // Build direct stream entries (highest quality first)
    // Sort by quality descending
    streamUrls.sort((a, b) => {
        const qA = parseInt(a.match(/-(\d+)\.mp4/)?.[1] || '0');
        const qB = parseInt(b.match(/-(\d+)\.mp4/)?.[1] || '0');
        return qB - qA;
    });

    for (const url of streamUrls) {
        const qualityMatch = url.match(/-(\d+)\.mp4/);
        const qualityNum = qualityMatch ? qualityMatch[1] : '';
        const label = QUALITY_LABELS[qualityNum] || (qualityNum ? qualityNum + 'p' : 'Video');

        streams.push({
            name: 'Curvcorn',
            title: label,
            url: url,
        });
    }

    // ── Fallback: Proxy redirect resolver ──
    // If direct URLs don't work for some reason (e.g. Stremio can't follow
    // the 302 redirect), our server can resolve the redirect and pass the
    // CDN URL directly to Stremio's player.
    if (streamUrls.length > 0) {
        // Add a proxy stream for each quality as fallback
        const addonBase = 'https://curvcorn-thepornbang.vercel.app';
        for (const url of streamUrls) {
            const qualityMatch = url.match(/-(\d+)\.mp4/);
            const qualityNum = qualityMatch ? qualityMatch[1] : '';
            const label = QUALITY_LABELS[qualityNum] || (qualityNum ? qualityNum + 'p' : 'Video');

            streams.push({
                name: 'Curvcorn Proxy',
                title: label + ' (Proxy)',
                url: `${addonBase}/stream-proxy/${segment}/${qualityNum}`,
            });
        }
    } else {
        // Last resort: proxy that fetches page and resolves
        const addonBase = 'https://curvcorn-thepornbang.vercel.app';
        streams.push({
            name: 'Curvcorn',
            title: 'Play (Proxy)',
            url: `${addonBase}/stream-proxy/${segment}/1080`,
        });
    }

    // ── Cross-navigation streams: Models ──
    // These appear as stream cards. Clicking navigates to the model's page
    // within Stremio (not a browser/webview).
    const $ = cheerio.load(html);
    const modelIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/pornstar\/([^/]+)\/?$/);
        if (m && !modelIds.has(m[1])) {
            modelIds.add(m[1]);
            const name = $(el).text().trim();
            if (name) {
                streams.push({
                    name: 'Model',
                    title: name,
                    externalUrl: `stremio:///detail/curvcorn/m_${m[1]}`,
                });
            }
        }
    });

    // ── Cross-navigation streams: Tags ──
    const tagIds = new Set();
    $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/tag\/([^/]+)\/?$/);
        if (m && !tagIds.has(m[1])) {
            tagIds.add(m[1]);
            const raw = $(el).text().trim().replace(/\d[\d,.]*\d?\s*$/, '').trim();
            if (raw) {
                streams.push({
                    name: 'Tag',
                    title: raw,
                    externalUrl: `stremio:///detail/curvcorn/t_${m[1]}`,
                });
            }
        }
    });

    return { streams };
}

// ─── Manifest & Builder ─────────────────────────────────────────────────────

const manifest = {
    id: 'community.curvcorn-thepornbang',
    version: '2.0.0',
    name: 'Curvcorn: ThePornBang',
    description: 'ThePornBang content for Stremio — Videos, Models, Categories, Channels & Tags',
    logo: 'https://www.thepornbang.com/apple-touch-icon.png',
    types: ['curvcorn'],
    catalogs: [
        { type: 'curvcorn', id: 'tpb-home', name: 'Home', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-popular', name: 'Popular', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-toprated', name: 'Top Rated', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-categories', name: 'Categories', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-models', name: 'Models', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-channels', name: 'Channels', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-tags', name: 'Tags', extra: [{ name: 'skip', isRequired: false }] },
        { type: 'curvcorn', id: 'tpb-search', name: 'Search', extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }] },
    ],
    idPrefixes: ['v_', 'm_', 'c_', 's_', 't_'],
    resources: ['catalog', 'meta', 'stream'],
    behaviorHints: { configurable: false },
};

const builder = new addonBuilder(manifest);

// ─── Catalog Handler ────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'curvcorn') return { metas: [] };

    const skip = parseInt(extra?.skip || '0');
    const page = Math.floor(skip / 72) + 1;
    const search = extra?.search;

    try {
        switch (id) {
            case 'tpb-home': {
                const url = page <= 1 ? `${BASE}/home35/` : `${BASE}/videos_27/${page}/`;
                return { metas: await scrapeVideoList(url) };
            }
            case 'tpb-popular': {
                return { metas: await scrapeVideoList(`${BASE}/most-viewed_17/${page}/`) };
            }
            case 'tpb-toprated': {
                return { metas: await scrapeVideoList(`${BASE}/top-rated_15/${page}/`) };
            }
            case 'tpb-categories': {
                const catPage = page <= 1 ? `${BASE}/categories_16/` : `${BASE}/categories_16/${page}/`;
                return { metas: await scrapeCategories(catPage) };
            }
            case 'tpb-models': {
                return { metas: await scrapeModels(`${BASE}/pornstars_19/${page}/`) };
            }
            case 'tpb-channels': {
                return { metas: await scrapeStudios(`${BASE}/studios_32/`) };
            }
            case 'tpb-tags': {
                return { metas: await scrapeTags(`${BASE}/tags_34/`) };
            }
            case 'tpb-search': {
                if (!search) return { metas: [] };
                return { metas: await scrapeVideoList(`${BASE}/search/${encodeURIComponent(search)}/${page}/`) };
            }
            default:
                return { metas: [] };
        }
    } catch (e) {
        console.error(`Catalog error [${id}]:`, e.message);
        return { metas: [] };
    }
});

// ─── Meta Handler ───────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'curvcorn') return { meta: null };

    try {
        if (id.startsWith('v_')) {
            return await getVideoMeta(id);
        } else if (id.startsWith('m_')) {
            return await getEntityMeta(id, 'model', 'pornstar');
        } else if (id.startsWith('c_')) {
            return await getEntityMeta(id, 'category', 'category');
        } else if (id.startsWith('s_')) {
            return await getEntityMeta(id, 'studio', 'studio');
        } else if (id.startsWith('t_')) {
            return await getEntityMeta(id, 'tag', 'tag');
        }
    } catch (e) {
        console.error(`Meta error [${id}]:`, e.message);
    }
    return { meta: null };
});

// ─── Stream Handler ─────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'curvcorn' || !id.startsWith('v_')) return { streams: [] };

    try {
        return await getVideoStreams(id);
    } catch (e) {
        console.error(`Stream error [${id}]:`, e.message);
        return { streams: [] };
    }
});

module.exports = builder.getInterface();
