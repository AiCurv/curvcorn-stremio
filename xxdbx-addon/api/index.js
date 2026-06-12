const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const router = getRouter(addonInterface);

const BASE_URL = "https://xxdbx.com";
const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: "https://xxdbx.com/",
};

function fixUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return BASE_URL + url;
    return url;
}

// Extract MP4 URLs from a video page
function extractStreamUrls(html) {
    const $ = cheerio.load(html);
    const streams = {};
    $("video#p source").each((_, el) => {
        const src = $(el).attr("src") || "";
        const quality = $(el).attr("title") || "";
        if (src && quality) {
            streams[quality] = fixUrl(src);
        }
    });
    return streams;
}

// Stream proxy handler - fetches MP4 from Vercel's IP and pipes to client
async function handlePlayProxy(req, res) {
    // Path format: /play/{videoId}/{quality}.mp4
    const match = req.url.match(/\/play\/(\d+)\/([^/]+\.mp4)/);
    if (!match) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
            JSON.stringify({
                error: "Invalid play URL. Use /play/{videoId}/{quality}.mp4",
            })
        );
        return;
    }

    const videoId = match[1];
    const qualityFile = match[2];
    // Extract quality from filename: "720.mp4" -> "720p"
    const qualityMatch = qualityFile.match(/(\d+)p?\.mp4/);
    const quality = qualityMatch ? qualityMatch[1] + "p" : "720p";

    try {
        // 1. Fetch the video page fresh from xxdbx.com (from Vercel's IP)
        const detailUrl = `${BASE_URL}/view/${videoId}`;
        const pageRes = await fetch(detailUrl, {
            headers: HEADERS,
            timeout: 15000,
        });
        if (!pageRes.ok) {
            res.statusCode = 502;
            res.end(
                JSON.stringify({
                    error: `Failed to fetch video page: HTTP ${pageRes.status}`,
                })
            );
            return;
        }
        const html = await pageRes.text();

        // 2. Extract the MP4 URL for the requested quality
        const streams = extractStreamUrls(html);
        const mp4Url =
            streams[quality] ||
            streams["720p"] ||
            streams["1080p"] ||
            streams["360p"];

        if (!mp4Url) {
            res.statusCode = 404;
            res.end(
                JSON.stringify({
                    error: "No stream URL found",
                    available: Object.keys(streams),
                })
            );
            return;
        }

        // 3. Forward the request to the CDN (from Vercel's IP — matches the token!)
        const proxyHeaders = {
            "User-Agent": HEADERS["User-Agent"],
            Referer: "https://xxdbx.com/",
            Accept: "*/*",
        };

        // Forward range headers for seeking support
        if (req.headers.range) {
            proxyHeaders.Range = req.headers.range;
        }

        const mp4Res = await fetch(mp4Url, {
            headers: proxyHeaders,
            timeout: 30000,
        });

        if (!mp4Res.ok) {
            res.statusCode = 502;
            res.end(
                JSON.stringify({
                    error: `CDN returned HTTP ${mp4Res.status}`,
                    url: mp4Url,
                })
            );
            return;
        }

        // 4. Stream the response back to Stremio
        const contentType =
            mp4Res.headers.get("content-type") || "video/mp4";
        const contentLength = mp4Res.headers.get("content-length");
        const contentRange = mp4Res.headers.get("content-range");
        const acceptRanges = mp4Res.headers.get("accept-ranges");

        // Set appropriate status code (206 for partial content)
        res.statusCode = mp4Res.status;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Range");

        if (contentLength)
            res.setHeader("Content-Length", contentLength);
        if (contentRange)
            res.setHeader("Content-Range", contentRange);
        if (acceptRanges)
            res.setHeader("Accept-Ranges", acceptRanges);

        // Pipe the MP4 data back to the client
        mp4Res.body.pipe(res);
    } catch (err) {
        console.error("Play proxy error:", err.message);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
        }
    }
}

module.exports = function (req, res) {
    // Set CORS headers for all requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Range"
    );

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    // Handle /play/ proxy requests
    if (req.url.startsWith("/play/")) {
        return handlePlayProxy(req, res);
    }

    // All other requests go to the Stremio addon router
    router(req, res, function () {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
    });
};
