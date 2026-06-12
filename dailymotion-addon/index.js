const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ─── Dailymotion API Configuration ────────────────────────────────────────────
const DM_API_BASE = 'https://api.dailymotion.com';
const DM_SEARCH_LIMIT = 60;
const DM_PAGE_LIMIT = 20;

// Fields for catalog listings
const DM_LIST_FIELDS = 'id,title,thumbnail_360_url,owner.id,owner.username,channel,description,duration,created_time';
// Fields for search listings (higher quality posters)
const DM_SEARCH_FIELDS = 'id,title,thumbnail_720_url,owner.id,owner.username,channel,description,duration,created_time';
// Fields for meta detail
const DM_DETAIL_FIELDS = 'id,title,thumbnail_720_url,thumbnail_360_url,owner.id,owner.username,owner.screenname,channel,description,duration,created_time,views_total,url';
// Fields for owner channel meta
const DM_OWNER_FIELDS = 'id,username,screenname,avatar_360_url,description,videos_total';
// Fields for owner's video list
const DM_OWNER_VIDEO_FIELDS = 'id,title,thumbnail_360_url,duration,created_time';

// ─── Dailymotion Category Definitions ─────────────────────────────────────────
const DM_CATEGORIES = {
  news:       { name: 'News & Politics',     icon: '📰' },
  sport:      { name: 'Sports',              icon: '⚽' },
  music:      { name: 'Music',               icon: '🎵' },
  tech:       { name: 'Tech',                icon: '💻' },
  fun:        { name: 'Comedy & Entertainment', icon: '🎬' },
  lifestyle:  { name: 'Lifestyle & How-to',  icon: '🌿' },
  videogames: { name: 'Gaming',              icon: '🎮' },
  auto:       { name: 'Cars & Auto',         icon: '🚗' },
  travel:     { name: 'Travel',              icon: '✈️' },
  creation:   { name: 'Creative',            icon: '🎨' },
  school:     { name: 'Education',           icon: '📚' },
  shortfilms: { name: 'Movies',              icon: '🎞️' },
  tv:         { name: 'TV Shows',            icon: '📺' },
  kids:       { name: 'Kids',                icon: '🧸' },
  animals:    { name: 'Animals',             icon: '🐾' },
  people:     { name: 'Celeb & People',      icon: '🌟' },
  webcam:     { name: 'Webcam & Live',       icon: '📡' }
};

// ─── Stremio Addon Manifest ───────────────────────────────────────────────────
const SEARCH_EXTRA = [{ name: 'search', isRequired: false }];

const manifest = {
  id: 'community.dailymotion.addon',
  version: '1.4.0',
  name: 'Dailymotion',
  description: 'Watch videos from Dailymotion directly in Stremio — search, browse by category, trending, or featured. Navigate to creator channels.',
  logo: 'https://static1.dmcdn.net/images/dailymotion-logo-og.png/h:250,q:80',
  types: ['channel'],
  idPrefixes: ['dm_', 'dm_owner_'],
  catalogs: [
    // ── Main catalogs (searchable) ──
    {
      type: 'channel',
      id: 'dailymotion_featured',
      name: 'Dailymotion Featured',
      extra: SEARCH_EXTRA
    },
    {
      type: 'channel',
      id: 'dailymotion_trending',
      name: 'Dailymotion Trending',
      extra: SEARCH_EXTRA
    },
    // ── Category catalogs (searchable) ──
    ...Object.entries(DM_CATEGORIES).map(([key, cat]) => ({
      type: 'channel',
      id: `dailymotion_${key}`,
      name: `${cat.icon} ${cat.name}`,
      extra: SEARCH_EXTRA
    }))
  ],
  resources: [
    'catalog',
    'meta',
    'stream'
  ]
};

// ─── Helper: Determine catalog kind from ID ───────────────────────────────────
function resolveCatalog(id) {
  if (id === 'dailymotion_featured')  return { sort: null,       channel: null };
  if (id === 'dailymotion_trending')  return { sort: 'trending', channel: null };

  const categoryKey = id.replace('dailymotion_', '');
  if (DM_CATEGORIES[categoryKey]) {
    return { sort: 'recent', channel: categoryKey };
  }

  return null;
}

// ─── Helper: Fetch video list from Dailymotion API ────────────────────────────
async function fetchDailymotionVideos({ sort, channel, page = 1, search, limit }) {
  const url = new URL(`${DM_API_BASE}/videos`);
  url.searchParams.set('fields', search ? DM_SEARCH_FIELDS : DM_LIST_FIELDS);
  url.searchParams.set('limit', limit || DM_PAGE_LIMIT);
  url.searchParams.set('page', page);

  if (sort)    url.searchParams.set('sort', sort);
  if (channel) url.searchParams.set('channel', channel);
  if (search)  url.searchParams.set('search', search);

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion API returned ${response.status}`);
  }

  const data = await response.json();
  return data.list || [];
}

// ─── Helper: Search Dailymotion users ─────────────────────────────────────────
async function fetchDailymotionUsers(query) {
  const url = `${DM_API_BASE}/users?search=${encodeURIComponent(query)}&fields=id,username,screenname,avatar_360_url,description,videos_total&limit=10`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion users API returned ${response.status}`);
  }

  const data = await response.json();
  return data.list || [];
}

// ─── Helper: Fetch single video details ───────────────────────────────────────
async function fetchDailymotionVideo(videoId) {
  const url = `${DM_API_BASE}/video/${videoId}?fields=${DM_DETAIL_FIELDS}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion API returned ${response.status}`);
  }

  return await response.json();
}

// ─── Helper: Fetch owner/user info ────────────────────────────────────────────
async function fetchDailymotionOwner(ownerId) {
  const url = `${DM_API_BASE}/user/${ownerId}?fields=${DM_OWNER_FIELDS}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion user API returned ${response.status}`);
  }

  return await response.json();
}

// ─── Helper: Fetch owner's latest videos ──────────────────────────────────────
async function fetchDailymotionOwnerVideos(ownerId) {
  const url = `${DM_API_BASE}/user/${ownerId}/videos?fields=${DM_OWNER_VIDEO_FIELDS}&limit=${DM_PAGE_LIMIT}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion user videos API returned ${response.status}`);
  }

  const data = await response.json();
  return data.list || [];
}

// ─── Helper: Parse HLS master manifest to extract per-resolution streams ──────
function parseHLSManifest(manifestText, baseUrl) {
  const renditions = [];
  const lines = manifestText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // Extract RESOLUTION from the tag (e.g., RESOLUTION=1920x1080)
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      const width = resMatch ? parseInt(resMatch[1]) : 0;
      const height = resMatch ? parseInt(resMatch[2]) : 0;
      const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;

      // The next non-comment, non-empty line is the URL
      let streamUrl = '';
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          streamUrl = nextLine;
          break;
        }
      }

      if (streamUrl && height > 0) {
        // Resolve relative URLs
        if (!streamUrl.startsWith('http')) {
          const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
          streamUrl = base + streamUrl;
        }

        // Map height to quality label
        let label;
        if (height >= 1080)      label = '1080p';
        else if (height >= 720)  label = '720p';
        else if (height >= 480)  label = '480p';
        else if (height >= 380)  label = '380p';
        else if (height >= 240)  label = '240p';
        else                     label = `${height}p`;

        renditions.push({ height, label, bandwidth, url: streamUrl });
      }
    }
  }

  // Sort by resolution descending (highest quality first)
  renditions.sort((a, b) => b.height - a.height);
  return renditions;
}

// ─── Helper: Fetch ALL stream qualities from Dailymotion player metadata ──────
async function fetchDailymotionStreams(videoId) {
  const streams = [];

  try {
    const url = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return streams;

    const data = await response.json();

    // Step 1: Check for direct per-resolution stream URLs in qualities object
    if (data.qualities) {
      const qualityOrder = ['1080', '720', '480', '380', '240'];

      for (const q of qualityOrder) {
        const quality = data.qualities[q];
        if (!quality || quality.length === 0) continue;

        const stream = quality.find(s => s.type === 'video/mp4')
                   || quality[0];

        if (stream && stream.url) {
          streams.push({
            name: 'Dailymotion',
            title: `${q}p MP4`,
            url: stream.url
          });
        }
      }
    }

    // Step 2: If no direct URLs, use the HLS auto master playlist
    // Parse stream_formats from player metadata to determine available resolutions
    // and return each as a separate labeled card pointing to the same master URL
    // (Stremio's HLS player will auto-select the right rendition)
    if (streams.length === 0 && data.qualities?.auto?.length > 0) {
      const hlsStream = data.qualities.auto.find(s => s.type === 'application/x-mpegURL')
                     || data.qualities.auto[0];

      if (hlsStream && hlsStream.url) {
        // Extract available resolutions from stream_formats (e.g. { '380': 'fMP4', '480': 'fMP4', '720': 'fMP4', '1080': 'fMP4' })
        const streamFormats = data.stream_formats || {};
        const availableResolutions = Object.keys(streamFormats)
          .map(k => parseInt(k))
          .filter(k => !isNaN(k))
          .sort((a, b) => b - a);  // high → low

        if (availableResolutions.length > 0) {
          // Return each available resolution as a separate stream card
          // All point to the same HLS master URL — Stremio's player auto-negotiates
          for (const res of availableResolutions) {
            streams.push({
              name: 'Dailymotion',
              title: `${res}p`,
              url: hlsStream.url
            });
          }
        } else {
          // No stream_formats info — return as HLS Auto
          streams.push({
            name: 'Dailymotion',
            title: 'HLS Auto',
            url: hlsStream.url
          });
        }
      }
    }
  } catch (err) {
    console.error(`[stream] Player metadata fetch failed for ${videoId}:`, err.message);
  }

  return streams;
}

// ─── Helper: Map video → Stremio Meta (catalog list format) ──────────────────
function mapToStremioMeta(video) {
  const meta = {
    id: `dm_${video.id}`,
    name: video.title || 'Untitled',
    poster: video.thumbnail_720_url || video.thumbnail_360_url || '',
    type: 'channel'
  };

  if (video.channel && DM_CATEGORIES[video.channel]) {
    meta.description = `Category: ${DM_CATEGORIES[video.channel].name}`;
  }

  return meta;
}

// ─── Helper: Map Dailymotion user → Stremio Meta (creator card) ──────────────
function mapUserToStremioMeta(user) {
  const name = user.screenname || user.username || 'Dailymotion Creator';
  const videosTotal = user.videos_total || 0;

  return {
    id: `dm_owner_${user.id}`,
    name: `${name} (Channel)`,
    poster: user.avatar_360_url || '',
    type: 'channel',
    description: `Creator — ${videosTotal} videos`
  };
}

// ─── Helper: Map video → Stremio Meta (detailed format with links) ───────────
function mapToDetailedMeta(video) {
  const channelName = video.channel && DM_CATEGORIES[video.channel]
    ? DM_CATEGORIES[video.channel].name
    : (video.channel || 'Unknown');

  const ownerName = video['owner.screenname'] || video['owner.username'] || 'Dailymotion User';
  const ownerId = video['owner.id'] || '';
  const durationMin = video.duration ? Math.floor(video.duration / 60) : null;
  const durationSec = video.duration ? video.duration % 60 : null;
  const durationStr = durationMin !== null ? `${durationMin}:${String(durationSec).padStart(2, '0')}` : '';

  const dateStr = video.created_time
    ? new Date(video.created_time * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';

  const viewsStr = video.views_total ? `${Number(video.views_total).toLocaleString()} views` : '';

  const descParts = [];
  if (video.description) descParts.push(video.description);
  descParts.push('');
  descParts.push(`📂 Category: ${channelName}`);
  if (durationStr) descParts.push(`⏱ Duration: ${durationStr}`);
  if (dateStr)     descParts.push(`📅 ${dateStr}`);
  if (viewsStr)    descParts.push(`👁 ${viewsStr}`);
  descParts.push(`👤 ${ownerName}`);

  const meta = {
    id: `dm_${video.id}`,
    name: video.title || 'Untitled',
    poster: video.thumbnail_720_url || video.thumbnail_360_url || '',
    type: 'channel',
    description: descParts.join('\n'),
    runtime: durationStr || ''
  };

  // Deep-link to creator's channel page
  if (ownerId) {
    meta.links = [
      {
        name: ownerName,
        category: 'owner',
        url: `stremio:///detail/channel/dm_owner_${ownerId}`
      }
    ];
  }

  return meta;
}

// ─── Helper: Build owner channel meta with videos as episodes ─────────────────
function buildOwnerChannelMeta(owner, videos) {
  const ownerName = owner.screenname || owner.username || 'Dailymotion Channel';
  const ownerAvatar = owner.avatar_360_url || '';
  const videosTotal = owner.videos_total || 0;

  const descParts = [];
  if (owner.description) descParts.push(owner.description);
  descParts.push('');
  descParts.push(`👤 ${owner.username}`);
  descParts.push(`📹 ${videosTotal} videos`);

  const meta = {
    id: `dm_owner_${owner.id}`,
    name: ownerName,
    poster: ownerAvatar,
    type: 'channel',
    description: descParts.join('\n'),
    videos: videos.map((video, index) => {
      const durationMin = video.duration ? Math.floor(video.duration / 60) : 0;
      const durationSec = video.duration ? video.duration % 60 : 0;
      const durationStr = `${durationMin}:${String(durationSec).padStart(2, '0')}`;

      const dateStr = video.created_time
        ? new Date(video.created_time * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '';

      return {
        id: `dm_${video.id}`,
        name: video.title || 'Untitled',
        poster: video.thumbnail_360_url || '',
        released: video.created_time ? new Date(video.created_time * 1000).toISOString() : undefined,
        overview: `${durationStr} — ${dateStr}`,
        episode: index + 1,
        season: 1
      };
    })
  };

  return meta;
}

// ─── Graceful JSON response helper ────────────────────────────────────────────
function jsonResponse(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data));
}

function errorFallback(res, label, err) {
  console.error(`[${label}] ${err.message}`);
  jsonResponse(res, { metas: [] });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Root: serve the manifest
app.get('/', (req, res) => jsonResponse(res, manifest));

// Manifest route
app.get('/manifest.json', (req, res) => jsonResponse(res, manifest));

// ─── Catalog handler — with search support ────────────────────────────────────
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  if (type !== 'channel') {
    return res.status(404).json({ error: 'Type not found' });
  }

  const catalogConfig = resolveCatalog(id);
  if (!catalogConfig) {
    return res.status(404).json({ error: 'Catalog not found' });
  }

  const page = parseInt(req.query.page) || 1;
  const searchQuery = req.query.search || null;

  try {
    // ── SEARCH MODE: intercept extra.search ──
    if (searchQuery) {
      // Fetch videos + creator profiles in parallel
      const [videos, users] = await Promise.all([
        fetchDailymotionVideos({
          search: searchQuery,
          limit: DM_SEARCH_LIMIT,
          page: 1,
          sort: 'relevance',
          channel: null
        }),
        fetchDailymotionUsers(searchQuery).catch(() => [])
      ]);

      // Deduplicate videos by ID to prevent repeating loops
      const seenIds = new Set();
      const videoMetas = [];
      for (const video of videos) {
        if (!seenIds.has(video.id)) {
          seenIds.add(video.id);
          videoMetas.push(mapToStremioMeta(video));
        }
      }

      // Inject matching creator profiles into the grid (w1mp-style)
      const userMetas = users.map(mapUserToStremioMeta);

      // Creators first, then videos
      const metas = [...userMetas, ...videoMetas];
      jsonResponse(res, { metas });
      return;
    }

    // ── BROWSE MODE: normal catalog ──
    const videos = await fetchDailymotionVideos({
      sort: catalogConfig.sort,
      channel: catalogConfig.channel,
      page
    });
    const metas = videos.map(mapToStremioMeta);
    jsonResponse(res, { metas });
  } catch (err) {
    errorFallback(res, `catalog/${id}`, err);
  }
});

// ─── Meta handler — video detail or owner channel ─────────────────────────────
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  if (type !== 'channel') {
    return res.status(404).json({ error: 'Type not found' });
  }

  // ── Owner channel pattern: dm_owner_<ownerId> ──
  if (id.startsWith('dm_owner_')) {
    const ownerId = id.replace('dm_owner_', '');

    try {
      const [owner, videos] = await Promise.all([
        fetchDailymotionOwner(ownerId),
        fetchDailymotionOwnerVideos(ownerId)
      ]);
      const meta = buildOwnerChannelMeta(owner, videos);
      jsonResponse(res, { meta });
    } catch (err) {
      console.error(`[meta/owner] Error fetching owner ${ownerId}:`, err.message);
      jsonResponse(res, {
        meta: {
          id,
          name: 'Channel unavailable',
          type: 'channel',
          poster: '',
          description: 'Could not load this channel\'s videos.',
          videos: []
        }
      });
    }
    return;
  }

  // ── Single video pattern: dm_<videoId> ──
  if (id.startsWith('dm_')) {
    const videoId = id.replace('dm_', '');

    try {
      const video = await fetchDailymotionVideo(videoId);
      const meta = mapToDetailedMeta(video);
      jsonResponse(res, { meta });
    } catch (err) {
      console.error(`[meta] Error fetching ${id}:`, err.message);
      jsonResponse(res, {
        meta: {
          id,
          name: 'Video unavailable',
          type: 'channel',
          poster: ''
        }
      });
    }
    return;
  }

  return res.status(404).json({ error: 'Invalid ID format' });
});

// ─── Stream handler — multi-quality stream cards ─────────────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  if (type !== 'channel') {
    return res.status(404).json({ error: 'Type not found' });
  }

  // Owner channel IDs don't have streams — user clicks an episode
  if (id.startsWith('dm_owner_')) {
    jsonResponse(res, { streams: [] });
    return;
  }

  if (!id.startsWith('dm_')) {
    return res.status(404).json({ error: 'Invalid ID format' });
  }

  const videoId = id.replace('dm_', '');

  try {
    // Fetch all available qualities as separate stream cards
    const streams = await fetchDailymotionStreams(videoId);
    jsonResponse(res, { streams });
  } catch (err) {
    console.error(`[stream] Error resolving stream for ${id}:`, err.message);
    jsonResponse(res, { streams: [] });
  }
});

// ─── Server ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dailymotion Stremio Addon running on port ${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
