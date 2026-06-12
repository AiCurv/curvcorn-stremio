const { addonBuilder } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const fetch = require("node-fetch");

const BASE_URL = "https://w1mp.com";
const CDN_STATIC = "https://cdnstatic.w1mp.com";
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
};

// ─── Cache (5 min TTL) ─────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function cachedFetch(url) {
    const now = Date.now();
    const cached = cache.get(url);
    if (cached && now - cached.ts < CACHE_TTL) return cached.html;
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const html = await res.text();
    cache.set(url, { html, ts: now });
    return html;
}

// ─── Helpers ────────────────────────────────────────────────────────

function fixUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return BASE_URL + url;
    return url;
}

// Generate a plausible ISO date from a video ID (higher ID = more recent)
// KVS sites use auto-incrementing IDs, so higher = newer
// Calibrated: ID ~500000 ≈ May 2026, ID ~1 ≈ Jan 2020
function videoIdToDate(videoId) {
    const id = parseInt(videoId);
    const baseDate = new Date("2020-01-01").getTime();
    const msPerId = (6.4 * 365.25 * 24 * 60 * 60 * 1000) / 500000;
    const date = new Date(baseDate + id * msPerId);
    return date.toISOString();
}

// ─── Video Card Parser ─────────────────────────────────────────────

function parseVideoCard(el, $) {
    let linkEl = el.find("a[href*='/video/']").first();
    if (!linkEl.length) return null;

    const href = linkEl.attr("href") || "";
    const videoMatch = href.match(/\/video\/(\d+)\//);
    if (!videoMatch) return null;
    const videoId = videoMatch[1];

    const title = el.find(".card-meta .title, .title").first().text().trim();
    if (!title) return null;

    const img = el.find(".card-img img").first();
    const poster = fixUrl(img.attr("data-webp") || img.attr("src") || "");

    const badgeEl = el.find(".badges .badge").first();
    const badgeText = badgeEl.text().trim();
    const isHD = badgeEl.find(".hd-badge").length > 0;
    const durationMatch = badgeText.match(/(\d+:\d+)/);
    const duration = durationMatch ? durationMatch[1] : "";

    const modelEl = el.find(".item-tool.model a").first();
    const modelName = modelEl.text().trim();
    const modelHref = modelEl.attr("href") || "";
    const modelSlugMatch = modelHref.match(/\/models\/([^/]+)\/?/);
    const modelSlug = modelSlugMatch ? modelSlugMatch[1] : "";

    const viewsEl = el.find(".info-item .item-tool").last();
    const views = viewsEl.text().trim();

    return {
        videoId, title, poster, duration, isHD,
        modelName, modelSlug, views, href: fixUrl(href),
    };
}

function extractVideoCards(html) {
    const $ = cheerio.load(html);
    const videos = [];
    $(".card.item").each((_, el) => {
        const card = parseVideoCard($(el), $);
        if (card) videos.push(card);
    });
    return videos;
}

// ─── Model Card Parser ─────────────────────────────────────────────

function extractModelCards(html) {
    const $ = cheerio.load(html);
    const models = [];
    $(".thumbs.models-thumbs .card.item").each((_, el) => {
        const $el = $(el);
        const linkEl = $el.find("a").first();
        const href = linkEl.attr("href") || "";
        const slugMatch = href.match(/\/models\/([^/]+)\/?/);
        if (!slugMatch) return;
        const slug = slugMatch[1];
        const name = $el.find(".title").first().text().trim();
        const img = $el.find(".card-img img").first();
        const poster = fixUrl(img.attr("src") || "");
        const videoCount = $el.find(".info-item .item-tool").first().text().trim();
        const rating = $el.find(".info-item .item-tool").eq(1).text().trim();
        models.push({ slug, name, poster, videoCount, rating });
    });
    return models;
}

// ─── Video Page Data Extractor ──────────────────────────────────────
// Extracts models, categories, and tags from a full video page

function extractVideoPageLinks(html) {
    const $ = cheerio.load(html);

    const models = [];
    const categories = [];
    const tags = [];

    // Models from js-models-list (yellow tags — these are the model tags)
    const modelSlugs = new Set();
    $(".js-models-list a[href*='/models/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        const slugMatch = href.match(/\/models\/([^/]+)\/?/);
        const name = $(el).text().trim();
        if (slugMatch && name) {
            const slug = slugMatch[1];
            if (!modelSlugs.has(slug)) {
                modelSlugs.add(slug);
                models.push({ slug, name });
            }
        }
    });

    // Also check video cards below for additional models (deduplicated)
    $(".item-tool.model a[href*='/models/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        const slugMatch = href.match(/\/models\/([^/]+)\/?/);
        const name = $(el).text().trim();
        if (slugMatch && name) {
            const slug = slugMatch[1];
            if (!modelSlugs.has(slug)) {
                modelSlugs.add(slug);
                models.push({ slug, name });
            }
        }
    });

    // Categories from top-player-items-wrap (gray tags with /categories/ href)
    $(".top-player-items-wrap a[href*='/categories/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        const slugMatch = href.match(/\/categories\/([^/]+)\/?/);
        const name = $(el).text().trim();
        if (slugMatch && name) {
            const slug = slugMatch[1];
            if (!categories.find(c => c.slug === slug)) {
                categories.push({ slug, name });
            }
        }
    });

    // Tags from top-player-items-wrap (gray tags with /tags/ href)
    $(".top-player-items-wrap a[href*='/tags/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        const slugMatch = href.match(/\/tags\/([^/]+)\/?/);
        const name = $(el).text().trim();
        if (slugMatch && name) {
            const slug = slugMatch[1];
            if (!tags.find(t => t.slug === slug)) {
                tags.push({ slug, name });
            }
        }
    });

    // Extract video poster from og:image
    const poster = $("meta[property='og:image']").attr("content") || "";

    return { models, categories, tags, poster };
}

// ─── Manifest ───────────────────────────────────────────────────────

const manifest = {
    id: "community.w1mp",
    version: "3.0.0",
    name: "W1MP",
    description: "Browse models, tags, categories, and videos from w1mp.com. Add model/tag pages to your library!",
    logo: "https://www.google.com/s2/favicons?domain=w1mp.com&sz=256",
    background: "https://cdnstatic.w1mp.com/static/images/logo.png",
    resources: [
        "catalog",
        { name: "meta", types: ["channel", "movie"], idPrefixes: ["model_", "video_", "tag_", "cat_"] },
        { name: "stream", types: ["movie"], idPrefixes: ["video_"] },
    ],
    types: ["channel", "movie"],
    catalogs: [
        // ── CHANNEL TYPE: Models ──
        {
            type: "channel",
            id: "models",
            name: "Models",
            extra: [
                { name: "search", isRequired: false },
                { name: "skip", isRequired: false },
            ],
        },
        // ── CHANNEL TYPE: Tags ──
        {
            type: "channel",
            id: "tags",
            name: "Tags",
            extra: [
                { name: "search", isRequired: false },
            ],
        },
        // ── MOVIE TYPE: Video Search ──
        {
            type: "movie",
            id: "video_search",
            name: "Video Search",
            extra: [{ name: "search", isRequired: true }],
        },
        // ── MOVIE TYPE: Browse catalogs ──
        {
            type: "movie",
            id: "latest",
            name: "Latest Videos",
            extra: [{ name: "skip", isRequired: false }],
        },
        {
            type: "movie",
            id: "top_rated",
            name: "Top Rated",
            extra: [{ name: "skip", isRequired: false }],
        },
        {
            type: "movie",
            id: "most_popular",
            name: "Most Popular",
            extra: [{ name: "skip", isRequired: false }],
        },
        // ── MOVIE TYPE: Categories (browsable with genre filter) ──
        {
            type: "movie",
            id: "categories",
            name: "Categories",
            extra: [
                {
                    name: "genre", isRequired: false, options: [
                        "Amateur", "Anal", "Arab", "Asian", "Babe", "BBW",
                        "Behind The Scenes", "Big Ass", "Big Dick", "Big Tits",
                        "Blonde", "Blowjob", "Bondage", "Brazilian", "British",
                        "Brunette", "Bukkake", "Casting", "Compilation", "Cosplay",
                        "Creampie", "Cuckold", "Cumshot", "Czech", "Double Penetration",
                        "Ebony", "Euro", "Facial", "Feet", "Female Orgasm", "Fetish",
                        "Fisting", "French", "Gangbang", "German", "Hairy", "Handjob",
                        "Hardcore", "Hentai", "Interracial", "Italian", "Japanese",
                        "Latina", "Lesbian", "Massage", "Masturbation", "Mature",
                        "MILF", "Old Young", "Orgy", "POV", "Public", "Reality",
                        "Red Head", "Role Play", "Romantic", "Rough Sex", "Russian",
                        "School", "Solo Female", "Squirt", "Step Fantasy", "Strap On",
                        "Striptease", "Teen", "Threesome", "Toys", "Vintage"
                    ]
                },
                { name: "skip", isRequired: false },
            ],
        },
    ],
    idPrefixes: ["model_", "video_", "tag_", "cat_"],
    behaviorHints: {
        adult: true,
        p2p: false,
        configurable: false,
        configurationRequired: false,
    },
};

const builder = new addonBuilder(manifest);

// ─── Category slug mapping ──────────────────────────────────────────

const CATEGORY_SLUG_MAP = {
    "amateur": "amateur", "anal": "anal", "arab": "arab", "asian": "asian",
    "babe": "babe", "bbw": "bbw", "behind the scenes": "behind-the-scenes",
    "big ass": "big-ass", "big dick": "big-dick", "big tits": "big-tits",
    "blonde": "blonde", "blowjob": "blowjob", "bondage": "bondage",
    "brazilian": "brazilian", "british": "british", "brunette": "brunette",
    "bukkake": "bukkake", "casting": "casting", "compilation": "compilation",
    "cosplay": "cosplay", "creampie": "creampie", "cuckold": "cuckold",
    "cumshot": "cumshot", "czech": "czech", "double penetration": "double-penetration",
    "ebony": "ebony", "euro": "euro", "facial": "facial", "feet": "feet",
    "female orgasm": "female-orgasm", "fetish": "fetish", "fisting": "fisting",
    "french": "french", "gangbang": "gangbang", "german": "german",
    "hairy": "hairy", "handjob": "handjob", "hardcore": "hardcore",
    "hentai": "hentai", "interracial": "interracial", "italian": "italian",
    "japanese": "japanese", "latina": "latina", "lesbian": "lesbian",
    "massage": "massage", "masturbation": "masturbation", "mature": "mature",
    "milf": "milf", "old young": "old-young-18", "orgy": "orgy",
    "pov": "pov", "public": "public", "reality": "reality",
    "red head": "red-head", "role play": "role-play", "romantic": "romantic",
    "rough sex": "rough-sex", "russian": "russian", "school": "school-18",
    "solo female": "solo-female", "squirt": "squirt",
    "step fantasy": "step-fantasy", "strap on": "strap-on",
    "striptease": "striptease", "teen": "teen-18", "threesome": "threesome",
    "toys": "toys", "vintage": "vintage",
};

// ─── CATALOG HANDLER ────────────────────────────────────────────────

builder.defineCatalogHandler(async (args) => {
    const skip = parseInt(args.extra?.skip || "0");
    const page = Math.floor(skip / 40) + 1;

    try {
        // ── Models catalog (channel type, searchable) ──
        if (args.id === "models" && args.type === "channel") {
            if (args.extra?.search) {
                const query = args.extra.search;
                const queryLower = query.toLowerCase();
                const searchUrl = `${BASE_URL}/search/?q=${encodeURIComponent(query)}`;
                const html = await cachedFetch(searchUrl);
                const videos = extractVideoCards(html);

                // Extract unique models from search results
                const modelMap = {};
                for (const v of videos) {
                    if (v.modelSlug) {
                        if (!modelMap[v.modelSlug]) {
                            modelMap[v.modelSlug] = { name: v.modelName, slug: v.modelSlug };
                        }
                    }
                }

                const metas = Object.values(modelMap).map(m => ({
                    id: `model_${m.slug}`,
                    type: "channel",
                    name: m.name,
                    poster: "",
                    posterShape: "poster",
                    description: `${m.name} — model page on W1MP`,
                }));

                // Sort: models whose name matches the query come FIRST
                metas.sort((a, b) => {
                    const aMatch = a.name.toLowerCase().includes(queryLower) ? 0 : 1;
                    const bMatch = b.name.toLowerCase().includes(queryLower) ? 0 : 1;
                    return aMatch - bMatch;
                });

                return { metas };
            } else {
                // Browse all models
                const modelsUrl = page > 1
                    ? `${BASE_URL}/models/${page}/`
                    : `${BASE_URL}/models/`;
                const html = await cachedFetch(modelsUrl);
                const models = extractModelCards(html);

                const metas = models.map(m => ({
                    id: `model_${m.slug}`,
                    type: "channel",
                    name: m.name,
                    poster: m.poster || "",
                    posterShape: "poster",
                    description: `${m.videoCount} | Rating: ${m.rating}`,
                }));

                return { metas };
            }
        }

        // ── Tags catalog (channel type, searchable) ──
        if (args.id === "tags" && args.type === "channel") {
            if (args.extra?.search) {
                const query = args.extra.search;
                const searchUrl = `${BASE_URL}/search/?q=${encodeURIComponent(query)}`;
                const html = await cachedFetch(searchUrl);

                // Get the full video page for the first result to extract tags
                const $ = cheerio.load(html);
                const firstVideoHref = $("a[href*='/video/']").first().attr("href");
                let tagMetas = [];

                if (firstVideoHref) {
                    const fullUrl = fixUrl(firstVideoHref);
                    try {
                        const videoHtml = await cachedFetch(fullUrl);
                        const data = extractVideoPageLinks(videoHtml);

                        // Return tags as channel items
                        tagMetas = data.tags.map(t => ({
                            id: `tag_${t.slug}`,
                            type: "channel",
                            name: t.name,
                            poster: "",
                            posterShape: "poster",
                            description: `Browse "${t.name}" tag on W1MP`,
                        }));
                    } catch (e) {}
                }

                // Also search the tags page directly
                try {
                    const tagUrl = `${BASE_URL}/tags/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"))}/`;
                    const tagHtml = await cachedFetch(tagUrl);
                    const t$ = cheerio.load(tagHtml);
                    const count = t$(".card.item").length;
                    if (count > 0) {
                        const slug = query.toLowerCase().replace(/\s+/g, "-");
                        // Don't add duplicate
                        if (!tagMetas.find(t => t.id === `tag_${slug}`)) {
                            tagMetas.unshift({
                                id: `tag_${slug}`,
                                type: "channel",
                                name: query,
                                poster: "",
                                posterShape: "poster",
                                description: `${count} videos tagged "${query}"`,
                            });
                        }
                    }
                } catch (e) {}

                return { metas: tagMetas };
            }
            return { metas: [] };
        }

        // ── Video Search catalog (movie type, search-only) ──
        if (args.id === "video_search" && args.type === "movie") {
            if (args.extra?.search) {
                const query = args.extra.search;
                const searchUrl = `${BASE_URL}/search/?q=${encodeURIComponent(query)}`;
                const html = await cachedFetch(searchUrl);
                const videos = extractVideoCards(html);
                return { metas: videos.map(v => videoToMetaPreview(v)) };
            }
            return { metas: [] };
        }

        // ── Categories catalog ──
        if (args.id === "categories" && args.type === "movie") {
            let categorySlug = "";
            if (args.extra?.genre) {
                const genreKey = args.extra.genre.toLowerCase();
                categorySlug = CATEGORY_SLUG_MAP[genreKey] || genreKey;
            }

            if (categorySlug) {
                const catUrl = page > 1
                    ? `${BASE_URL}/categories/${categorySlug}/${page}/`
                    : `${BASE_URL}/categories/${categorySlug}/`;
                const html = await cachedFetch(catUrl);
                const videos = extractVideoCards(html);
                return { metas: videos.map(v => videoToMetaPreview(v)) };
            } else {
                const catHtml = await cachedFetch(`${BASE_URL}/categories/`);
                const $ = cheerio.load(catHtml);
                const metas = [];
                $(".categories-thumbs .card.item").each((_, el) => {
                    const $el = $(el);
                    const linkEl = $el.find("a").first();
                    const href = linkEl.attr("href") || "";
                    const slugMatch = href.match(/\/categories\/([^/]+)\/?/);
                    if (!slugMatch) return;
                    const slug = slugMatch[1];
                    const name = $el.find(".cat-title").text().trim() || slug;
                    const img = $el.find("img").first();
                    const poster = fixUrl(img.attr("src") || "");
                    metas.push({
                        id: `cat_${slug}`,
                        type: "movie",
                        name: name,
                        poster: poster,
                        posterShape: "landscape",
                        description: `Browse ${name} videos`,
                    });
                });
                return { metas };
            }
        }

        // ── Latest videos catalog ──
        if (args.id === "latest" && args.type === "movie") {
            const url = page > 1
                ? `${BASE_URL}/latest-updates/${page}/`
                : `${BASE_URL}/latest-updates/`;
            const html = await cachedFetch(url);
            const videos = extractVideoCards(html);
            return { metas: videos.map(v => videoToMetaPreview(v)) };
        }

        // ── Top rated catalog ──
        if (args.id === "top_rated" && args.type === "movie") {
            const url = page > 1
                ? `${BASE_URL}/top-rated/${page}/`
                : `${BASE_URL}/top-rated/`;
            const html = await cachedFetch(url);
            const videos = extractVideoCards(html);
            return { metas: videos.map(v => videoToMetaPreview(v)) };
        }

        // ── Most popular catalog ──
        if (args.id === "most_popular" && args.type === "movie") {
            const url = page > 1
                ? `${BASE_URL}/most-popular/${page}/`
                : `${BASE_URL}/most-popular/`;
            const html = await cachedFetch(url);
            const videos = extractVideoCards(html);
            return { metas: videos.map(v => videoToMetaPreview(v)) };
        }

    } catch (err) {
        console.error("Catalog error:", err.message);
    }

    return { metas: [] };
});

// ─── META HANDLER ───────────────────────────────────────────────────

builder.defineMetaHandler(async (args) => {
    const { id, type } = args;

    try {
        // ── Model meta (channel type) ──
        if (type === "channel" && id.startsWith("model_")) {
            const slug = id.replace("model_", "");
            // Sort by newest first using ?sort_by=post_date
            const modelUrl = `${BASE_URL}/models/${slug}/?sort_by=post_date`;
            const html = await cachedFetch(modelUrl);
            const $ = cheerio.load(html);

            const name = $(".viewlist-headline .title").first().text().trim() || slug.replace(/-/g, " ");
            const desc = $(".viewlist-description").first().text().trim();
            const stats = $(".viewlist-headline .statistic-list .item").map((_, el) => $(el).text().trim()).get();
            const videoCount = stats[0] || "";
            const rating = stats[1] || "";

            // Try to find model poster from the page
            let modelPoster = "";
            // Check header/about section for model image
            $(".about-hold img, .viewlist-headline img, .model-info img, .posted img").each((_, el) => {
                const src = $(el).attr("src") || "";
                if (src && !modelPoster) {
                    modelPoster = fixUrl(src);
                }
            });

            // If no poster found on page, try constructing CDN URL
            if (!modelPoster) {
                // Look for model images in video cards (model avatars)
                $(".card-model-avatar img").each((_, el) => {
                    const src = $(el).attr("src") || "";
                    const alt = $(el).attr("alt") || "";
                    if (src && (alt.toLowerCase().includes(name.toLowerCase()) || !modelPoster)) {
                        modelPoster = fixUrl(src);
                    }
                });
            }

            // Extract ALL videos from this model's pages (sorted by date)
            const videos = [];
            const seenIds = new Set();

            // Fetch up to 5 pages of videos
            for (let p = 1; p <= 5; p++) {
                try {
                    const pUrl = p > 1
                        ? `${BASE_URL}/models/${slug}/${p}/?sort_by=post_date`
                        : `${BASE_URL}/models/${slug}/?sort_by=post_date`;
                    const pHtml = await cachedFetch(pUrl);
                    const p$ = cheerio.load(pHtml);

                    let pageHasVideos = false;
                    p$(".card.item").each((_, el) => {
                        const card = parseVideoCard(p$(el), p$);
                        if (card && !seenIds.has(card.videoId)) {
                            seenIds.add(card.videoId);
                            const dirPrefix = Math.floor(parseInt(card.videoId) / 1000) * 1000;
                            videos.push({
                                id: `video_${card.videoId}`,
                                title: card.title,
                                released: videoIdToDate(card.videoId),
                                thumbnail: card.poster || `${CDN_STATIC}/contents/videos_screenshots/${dirPrefix}/${card.videoId}/672x378/1.jpg`,
                                overview: `${card.duration || ""}${card.isHD ? " HD" : ""}${card.views ? " | " + card.views : ""}`,
                            });
                            pageHasVideos = true;
                        }
                    });

                    if (!pageHasVideos) break;
                } catch (e) { break; }
            }

            const meta = {
                id: id,
                type: "channel",
                name: name,
                poster: modelPoster,
                posterShape: "poster",
                background: modelPoster,
                description: desc || `${name}${videoCount ? " — " + videoCount : ""}${rating ? " | Rating: " + rating : ""}`,
                releaseInfo: videoCount,
                genres: ["Model"],
                videos: videos,
                links: [],
            };

            return { meta };
        }

        // ── Tag meta (channel type) ──
        if (type === "channel" && id.startsWith("tag_")) {
            const slug = id.replace("tag_", "");
            const tagUrl = `${BASE_URL}/tags/${slug}/`;
            const html = await cachedFetch(tagUrl);
            const $ = cheerio.load(html);

            // Get tag name from page title
            const tagName = $("title").first().text().replace(/-.*/g, "").trim() || slug.replace(/-/g, " ");

            // Extract videos from tag page
            const videos = [];
            const seenIds = new Set();

            // Fetch up to 3 pages
            for (let p = 1; p <= 3; p++) {
                try {
                    const pUrl = p > 1
                        ? `${BASE_URL}/tags/${slug}/${p}/`
                        : `${BASE_URL}/tags/${slug}/`;
                    const pHtml = await cachedFetch(pUrl);
                    const pVideos = extractVideoCards(pHtml);
                    if (pVideos.length === 0) break;

                    for (const card of pVideos) {
                        if (!seenIds.has(card.videoId)) {
                            seenIds.add(card.videoId);
                            const dirPrefix = Math.floor(parseInt(card.videoId) / 1000) * 1000;
                            videos.push({
                                id: `video_${card.videoId}`,
                                title: card.title,
                                released: videoIdToDate(card.videoId),
                                thumbnail: card.poster || `${CDN_STATIC}/contents/videos_screenshots/${dirPrefix}/${card.videoId}/672x378/1.jpg`,
                                overview: `${card.duration || ""}${card.isHD ? " HD" : ""}${card.views ? " | " + card.views : ""}`,
                            });
                        }
                    }
                } catch (e) { break; }
            }

            const meta = {
                id: id,
                type: "channel",
                name: tagName,
                poster: "",
                posterShape: "poster",
                description: `Browse "${tagName}" tag on W1MP — ${videos.length} videos`,
                genres: ["Tag"],
                videos: videos,
                links: [],
            };

            return { meta };
        }

        // ── Category meta (channel type) ──
        if (type === "channel" && id.startsWith("cat_")) {
            const slug = id.replace("cat_", "");
            const catUrl = `${BASE_URL}/categories/${slug}/`;
            const html = await cachedFetch(catUrl);
            const $ = cheerio.load(html);

            const catName = $("title").first().text().replace(/-.*/g, "").trim() || slug.replace(/-/g, " ");

            const videos = [];
            const seenIds = new Set();

            for (let p = 1; p <= 3; p++) {
                try {
                    const pUrl = p > 1
                        ? `${BASE_URL}/categories/${slug}/${p}/`
                        : `${BASE_URL}/categories/${slug}/`;
                    const pHtml = await cachedFetch(pUrl);
                    const pVideos = extractVideoCards(pHtml);
                    if (pVideos.length === 0) break;

                    for (const card of pVideos) {
                        if (!seenIds.has(card.videoId)) {
                            seenIds.add(card.videoId);
                            const dirPrefix = Math.floor(parseInt(card.videoId) / 1000) * 1000;
                            videos.push({
                                id: `video_${card.videoId}`,
                                title: card.title,
                                released: videoIdToDate(card.videoId),
                                thumbnail: card.poster || `${CDN_STATIC}/contents/videos_screenshots/${dirPrefix}/${card.videoId}/672x378/1.jpg`,
                                overview: `${card.duration || ""}${card.isHD ? " HD" : ""}${card.views ? " | " + card.views : ""}`,
                            });
                        }
                    }
                } catch (e) { break; }
            }

            const meta = {
                id: id,
                type: "channel",
                name: catName,
                poster: "",
                posterShape: "landscape",
                description: `Browse "${catName}" category on W1MP — ${videos.length} videos`,
                genres: ["Category"],
                videos: videos,
                links: [],
            };

            return { meta };
        }

        // ── Video meta (movie type) ──
        if (type === "movie" && id.startsWith("video_")) {
            const videoId = id.replace("video_", "");

            // Step 1: Fetch embed page for basic info + canonical URL
            const embedUrl = `${BASE_URL}/embed/${videoId}/`;
            const embedHtml = await cachedFetch(embedUrl);
            const e$ = cheerio.load(embedHtml);

            const title = e$("meta[property='og:title']").attr("content") || e$("title").first().text().trim() || `Video ${videoId}`;
            const embedPoster = e$("meta[property='og:image']").attr("content") || "";
            const description = e$("meta[property='og:description']").attr("content") || "";

            // Build links array — start with what we have from embed
            const links = [];

            // Step 2: Try to get the full video page for tags/models/categories
            const canonicalUrl = e$("link[rel='canonical']").attr("href") || "";
            if (canonicalUrl) {
                try {
                    const fullHtml = await cachedFetch(canonicalUrl);
                    const pageData = extractVideoPageLinks(fullHtml);

                    // Add model links (yellow tags — clickable, navigate to model page)
                    for (const model of pageData.models) {
                        links.push({
                            name: model.name,
                            category: "Models",
                            url: `stremio:///detail/channel/model_${model.slug}`,
                        });
                    }

                    // Add category links (gray tags — clickable, navigate to category page)
                    for (const cat of pageData.categories) {
                        links.push({
                            name: cat.name,
                            category: "Categories",
                            url: `stremio:///detail/channel/cat_${cat.slug}`,
                        });
                    }

                    // Add tag links (first 5 gray tags — clickable, navigate to tag page)
                    const topTags = pageData.tags.slice(0, 5);
                    for (const tag of topTags) {
                        links.push({
                            name: tag.name,
                            category: "Tags",
                            url: `stremio:///detail/channel/tag_${tag.slug}`,
                        });
                    }
                } catch (e) {
                    console.error("Full page fetch failed:", e.message);
                }
            }

            const meta = {
                id: id,
                type: "movie",
                name: title,
                poster: fixUrl(embedPoster),
                posterShape: "landscape",
                background: fixUrl(embedPoster),
                description: description || title,
                releaseInfo: "",
                genres: [],
                cast: [],
                links: links,
            };

            return { meta };
        }

        // ── Category catalog placeholder (movie type) ──
        if (type === "movie" && id.startsWith("cat_")) {
            const slug = id.replace("cat_", "");
            const catUrl = `${BASE_URL}/categories/${slug}/`;
            const html = await cachedFetch(catUrl);
            const videos = extractVideoCards(html);

            const meta = {
                id: id,
                type: "movie",
                name: slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
                poster: "",
                posterShape: "landscape",
                description: `Browse ${slug} videos`,
                genres: [slug],
                videos: videos.slice(0, 100).map(v => ({
                    id: `video_${v.videoId}`,
                    title: v.title,
                    released: videoIdToDate(v.videoId),
                    thumbnail: v.poster,
                })),
                links: [],
            };

            return { meta };
        }

    } catch (err) {
        console.error("Meta error:", err.message);
    }

    return { meta: {} };
});

// ─── STREAM HANDLER ─────────────────────────────────────────────────

builder.defineStreamHandler(async (args) => {
    const { id, type } = args;

    try {
        if (id.startsWith("video_")) {
            const videoId = id.replace("video_", "");
            const streams = [];

            // Use embed URL — /video/{id}/ without slug returns 404 on KVS sites
            const embedUrl = `${BASE_URL}/embed/${videoId}/`;
            const html = await cachedFetch(embedUrl);
            const $ = cheerio.load(html);

            // Extract MP4 from <video><source> tag
            $("video source").each((_, el) => {
                const src = $(el).attr("src") || "";
                if (src) {
                    streams.push({
                        name: "W1MP",
                        title: "Direct MP4",
                        url: fixUrl(src),
                        behaviorHints: { notWebReady: false },
                    });
                }
            });

            return { streams };
        }

        // Channel types don't have streams — user clicks a video from the list
        if (id.startsWith("model_") || id.startsWith("tag_") || id.startsWith("cat_")) {
            return { streams: [] };
        }
    } catch (err) {
        console.error("Stream error:", err.message);
    }

    return { streams: [] };
});

// ─── Helper: video card to meta preview ──────────────────────────────

function videoToMetaPreview(v) {
    const dirPrefix = Math.floor(parseInt(v.videoId) / 1000) * 1000;
    const poster = v.poster || `${CDN_STATIC}/contents/videos_screenshots/${dirPrefix}/${v.videoId}/672x378/1.jpg`;
    return {
        id: `video_${v.videoId}`,
        type: "movie",
        name: v.title,
        poster: poster,
        posterShape: "landscape",
        description: `${v.duration || ""}${v.isHD ? " HD" : ""}${v.modelName ? " | " + v.modelName : ""}${v.views ? " | " + v.views : ""}`,
        releaseInfo: "",
    };
}

module.exports = builder.getInterface();
