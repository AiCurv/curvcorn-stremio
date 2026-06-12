const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");

const router = getRouter(addonInterface);

module.exports = function (req, res) {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    router(req, res, function () {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
    });
};
