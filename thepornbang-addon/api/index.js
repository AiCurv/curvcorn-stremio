const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const https = require("https");

const router = getRouter(addonInterface);
const agent = new https.Agent({ keepAlive: true, timeout: 30000, maxSockets: 10 });
const BASE = "https://www.thepornbang.com";

const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Connection": "keep-alive",
};

const STREAM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "video/mp4,video/webm,video/*,*/*;q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Connection": "keep-alive",
};

module.exports = async function (req, res) {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // ── Stream Proxy: /stream-proxy/{videoSegment}/{quality} ──
    // Resolves the get_stream redirect on our server and returns
    // a 302 redirect to the actual CDN URL. This is needed because:
    // 1. The CDN URL contains the requester's IP in srcIp param
    // 2. If we resolve on our server, the CDN URL has our server's IP
    // 3. BUT: The CDN might not validate srcIp strictly
    // 4. This also works as a fallback if Stremio can't follow the
    //    initial thepornbang.com 302 redirect for any reason
    if (path.startsWith("/stream-proxy/")) {
        const parts = path.replace("/stream-proxy/", "").replace(/\/$/, "").split("/");
        const videoSegment = parts[0];
        const requestedQuality = parts[1] || "1080";
        const videoPageUrl = `${BASE}/video/${videoSegment}/`;

        try {
            // Step 1: Fetch the video page to extract stream URLs from flashvars
            // Also capture any session cookies the server sets
            const pageResponse = await fetch(videoPageUrl, {
                headers: FETCH_HEADERS,
                timeout: 15000,
                compress: false,
                agent,
            });
            const html = await pageResponse.text();

            // Extract cookies from the video page response for the stream request
            const cookies = [];
            const rawHeaders = pageResponse.headers.raw?.() || {};
            const setCookieHeaders = rawHeaders['set-cookie'] || [];
            for (const sc of setCookieHeaders) {
                const cookiePart = sc.split(';')[0]; // Take only name=value part
                if (cookiePart) cookies.push(cookiePart);
            }
            const cookieHeader = cookies.length > 0 ? cookies.join('; ') : undefined;

            // Step 2: Extract get_stream URLs from flashvars
            const streamUrls = [];
            const seen = new Set();

            // Pattern: video_url: 'https://www.thepornbang.com/get_stream/...'
            const flashvarsPattern = /video_(?:url|alt_url\d*)\s*:\s*'([^']*get_stream\/[^']+)'/gi;
            let match;
            while ((match = flashvarsPattern.exec(html)) !== null) {
                const sUrl = match[1];
                if (!seen.has(sUrl)) {
                    seen.add(sUrl);
                    streamUrls.push(sUrl);
                }
            }

            // Broader fallback
            if (streamUrls.length === 0) {
                const broadPattern = /['"](https?:\/\/[^'"]+\/get_stream\/\d+-\d+\.mp4\?[^'"]+)['"]/gi;
                while ((match = broadPattern.exec(html)) !== null) {
                    const sUrl = match[1];
                    if (!seen.has(sUrl)) {
                        seen.add(sUrl);
                        streamUrls.push(sUrl);
                    }
                }
            }

            // Relative URL fallback
            if (streamUrls.length === 0) {
                const relPattern = /['"](\/get_stream\/\d+-\d+\.mp4\?[^'"]+)['"]/gi;
                while ((match = relPattern.exec(html)) !== null) {
                    const sUrl = BASE + match[1];
                    if (!seen.has(sUrl)) {
                        seen.add(sUrl);
                        streamUrls.push(sUrl);
                    }
                }
            }

            if (streamUrls.length === 0) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "No stream URLs found" }));
                return;
            }

            // Step 3: Find the best matching quality URL
            let targetUrl = null;

            // Try exact quality match first
            for (const sUrl of streamUrls) {
                const qMatch = sUrl.match(/-(\d+)\.mp4/);
                if (qMatch && qMatch[1] === requestedQuality) {
                    targetUrl = sUrl;
                    break;
                }
            }

            // If no exact match, pick the highest quality available
            if (!targetUrl) {
                streamUrls.sort((a, b) => {
                    const qA = parseInt(a.match(/-(\d+)\.mp4/)?.[1] || "0");
                    const qB = parseInt(b.match(/-(\d+)\.mp4/)?.[1] || "0");
                    return qB - qA;
                });
                targetUrl = streamUrls[0];
            }

            // Step 4: Resolve the get_stream redirect to get the CDN URL
            // KEY INSIGHT: thepornbang.com /get_stream/ endpoint checks User-Agent:
            //   - Browser UA → returns 200 HTML (player page) - NO redirect
            //   - "Stremio" UA → returns 302 redirect to CDN (vkuser.net) ✓
            //   - Android stagefright UA → returns 302 redirect to CDN ✓
            //   - No UA → may return 200 or 302 depending on session
            // We use "Stremio" UA since it's proven to reliably get 302 redirects.
            const proxyHeaders = {
                "User-Agent": "Stremio",
                "Accept": "*/*",
                ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
            };
            const streamResponse = await fetch(targetUrl, {
                headers: proxyHeaders,
                timeout: 15000,
                compress: false,
                agent,
                redirect: "manual", // Don't follow redirects automatically
            });

            if (streamResponse.status === 301 || streamResponse.status === 302) {
                // Got the CDN redirect - pass it through to Stremio's player
                const cdnUrl = streamResponse.headers.get("location");
                if (cdnUrl) {
                    console.log(`Stream proxy: Resolved ${requestedQuality}p → CDN redirect`);
                    res.statusCode = 302;
                    res.setHeader("Location", cdnUrl);
                    res.setHeader("Content-Type", "video/mp4");
                    res.end();
                    return;
                }
            }

            // If the get_stream URL returned 200 (direct MP4, no redirect),
            // we can't proxy the full file through Vercel (size limits).
            // Instead, redirect to the get_stream URL directly and let
            // Stremio's player handle it.
            console.log(`Stream proxy: No CDN redirect, passing get_stream URL directly`);
            res.statusCode = 302;
            res.setHeader("Location", targetUrl);
            res.setHeader("Content-Type", "video/mp4");
            res.end();

        } catch (e) {
            console.error("Stream proxy error:", e.message);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── Debug endpoint: /debug-streams/{videoSegment} ──
    // Returns the extracted stream URLs as JSON for debugging
    if (path.startsWith("/debug-streams/")) {
        const videoSegment = path.replace("/debug-streams/", "").replace(/\/$/, "");
        const videoPageUrl = `${BASE}/video/${videoSegment}/`;

        try {
            const pageResponse = await fetch(videoPageUrl, {
                headers: FETCH_HEADERS,
                timeout: 15000,
                compress: false,
                agent,
            });
            const html = await pageResponse.text();

            const streamUrls = [];
            const seen = new Set();
            const flashvarsPattern = /video_(?:url|alt_url\d*)\s*:\s*'([^']*get_stream\/[^']+)'/gi;
            let match;
            while ((match = flashvarsPattern.exec(html)) !== null) {
                const sUrl = match[1];
                if (!seen.has(sUrl)) {
                    seen.add(sUrl);
                    streamUrls.push(sUrl);
                }
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ segment: videoSegment, streams: streamUrls, count: streamUrls.length }, null, 2));
        } catch (e) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Default: route to addon SDK router
    router(req, res, function () {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
    });
};
