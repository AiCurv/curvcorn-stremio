const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ─── Dailymotion API Configuration ────────────────────────────────────────────
const DM_API_BASE = 'https://api.dailymotion.com';
const DM_PAGE_LIMIT = 20;

// Fields for catalog listings (lightweight)
const DM_LIST_FIELDS = 'id,title,thumbnail_360_url,owner.id,owner.username,channel,description,duration,created_time';
// Fields for meta detail (richer — includes owner.id for deep-linking)
const DM_DETAIL_FIELDS = 'id,title,thumbnail_720_url,thumbnail_360_url,owner.id,owner.username,owner.screenname,channel,description,duration,created_time,views_total,url';
// Fields for owner channel meta
const DM_OWNER_FIELDS = 'id,username,screenname,avatar_360_url,description,videos_total';
// Fields for owner's video list
const DM_OWNER_VIDEO_FIELDS = 'id,title,thumbnail_360_url,duration,created_time';

// ─── Dailymotion Category Definitions ─────────────────────────────────────────
// Maps directly to Dailymotion's real channel IDs from their API
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
const manifest = {
  id: 'community.dailymotion.addon',
  version: '1.3.0',
  name: 'Dailymotion',
  description: 'Watch videos from Dailymotion directly in Stremio — browse by category, trending, or featured. Navigate to creator channels.',
  logo: 'https://static1.dmcdn.net/images/dailymotion-logo-og.png/h:250,q:80',
  types: ['channel'],
  idPrefixes: ['dm_', 'dm_owner_'],
  catalogs: [
    // ── Main catalogs ──
    {
      type: 'channel',
      id: 'dailymotion_featured',
      name: 'Dailymotion Featured'
    },
    {
      type: 'channel',
      id: 'dailymotion_trending',
      name: 'Dailymotion Trending'
    },
    // ── Category catalogs ──
    ...Object.entries(DM_CATEGORIES).map(([key, cat]) => ({
      type: 'channel',
      id: `dailymotion_${key}`,
      name: `${cat.icon} ${cat.name}`
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

  // Category catalogs: dailymotion_news, dailymotion_sport, etc.
  const categoryKey = id.replace('dailymotion_', '');
  if (DM_CATEGORIES[categoryKey]) {
    // Use 'recent' for categories — 'trending' often returns empty for niche channels
    return { sort: 'recent', channel: categoryKey };
  }

  return null; // unknown catalog
}

// ─── Helper: Fetch video list from Dailymotion API ────────────────────────────
async function fetchDailymotionVideos({ sort, channel, page = 1 }) {
  const url = new URL(`${DM_API_BASE}/videos`);
  url.searchParams.set('fields', DM_LIST_FIELDS);
  url.searchParams.set('limit', DM_PAGE_LIMIT);
  url.searchParams.set('page', page);

  if (sort)    url.searchParams.set('sort', sort);
  if (channel) url.searchParams.set('channel', channel);

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Dailymotion API returned ${response.status}`);
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

// ─── Helper: Fetch owner/user info from Dailymotion API ──────────────────────
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

// ─── Helper: Fetch owner's latest videos from Dailymotion API ─────────────────
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

// ─── Helper: Fetch stream URL from Dailymotion player metadata ────────────────
async function fetchDailymotionStream(videoId) {
  try {
    const url = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return null;

    const data = await response.json();

    // Try to extract the best quality stream from the qualities object
    if (data.qualities) {
      // Prefer auto (master HLS), then 1080, 720, 480, 380, 240
      const qualityOrder = ['auto', '1080', '720', '480', '380', '240'];
      for (const q of qualityOrder) {
        const quality = data.qualities[q];
        if (quality && quality.length > 0) {
          // Find the first HLS or direct URL type
          const stream = quality.find(s => s.type === 'application/x-mpegURL')
                       || quality.find(s => s.type === 'video/mp4')
                       || quality[0];
          if (stream && stream.url) {
            return { url: stream.url, type: stream.type, quality: q };
          }
        }
      }
    }

    return null;
  } catch (err) {
    console.error(`[stream] Player metadata fetch failed for ${videoId}:`, err.message);
    return null;
  }
}

// ─── Helper: Map video → Stremio Meta (catalog list format) ──────────────────
function mapToStremioMeta(video) {
  const meta = {
    id: `dm_${video.id}`,
    name: video.title || 'Untitled',
    poster: video.thumbnail_360_url || '',
    type: 'channel'
  };

  // Append category name to description if available
  if (video.channel && DM_CATEGORIES[video.channel]) {
    meta.description = `Category: ${DM_CATEGORIES[video.channel].name}`;
  }

  return meta;
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

  // Add deep-link to creator's channel page in the links array
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

// Manifest route (alternative path Stremio uses)
app.get('/manifest.json', (req, res) => jsonResponse(res, manifest));

// ─── Catalog handler ──────────────────────────────────────────────────────────
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

  try {
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

// ─── Meta handler — detailed view for a single video or owner channel ─────────
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
      // Graceful fallback: return minimal meta so Stremio doesn't crash
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
      // Return a minimal meta so Stremio doesn't break
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

  // Invalid ID format
  return res.status(404).json({ error: 'Invalid ID format' });
});

// ─── Stream handler — provides a single clean HLS stream ──────────────────────
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  if (type !== 'channel') {
    return res.status(404).json({ error: 'Type not found' });
  }

  if (!id.startsWith('dm_')) {
    return res.status(404).json({ error: 'Invalid ID format' });
  }

  const videoId = id.replace('dm_', '');
  const streams = [];

  try {
    // Fetch clean internal stream from Dailymotion player metadata
    const streamInfo = await fetchDailymotionStream(videoId);

    if (streamInfo) {
      const isHLS = streamInfo.type === 'application/x-mpegURL';
      streams.push({
        title: `${isHLS ? 'HLS' : 'MP4'} ${streamInfo.quality !== 'auto' ? streamInfo.quality + 'p' : 'Auto'}`,
        url: streamInfo.url
      });
    }
  } catch (err) {
    console.error(`[stream] Error resolving stream for ${id}:`, err.message);
  }

  // If no stream was found, return empty streams — Stremio will show "No streams"
  jsonResponse(res, { streams });
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
