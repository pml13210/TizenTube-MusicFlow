const POLL_INTERVAL_MS = 450;
const REQUEST_TIMEOUT_MS = 15000;
const SERVICE_PORTS = [8095, 8085];

let serviceBaseUrl = null;
let polling = false;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMappings() {
    if (!window._yttv) return null;
    const mapped = Object.values(window._yttv).find((value) => value && value.mappings);
    return mapped ? mapped.mappings : null;
}

function getInnerTubeClient() {
    const mappings = getMappings();
    if (!mappings) return null;
    return mappings.get('KabukiInnerTubeClient') || null;
}

async function getIdentity() {
    const mappings = getMappings();
    const identityService = mappings && mappings.get('CurrentIdentityService');
    if (!identityService || typeof identityService.get !== 'function') return undefined;
    try {
        return await identityService.get();
    } catch (_) {
        return undefined;
    }
}

function innerTubeFetch(path, payload = {}) {
    return new Promise(async (resolve, reject) => {
        const client = getInnerTubeClient();
        if (!client || typeof client.fetch !== 'function') {
            reject(new Error('KabukiInnerTubeClient indisponible'));
            return;
        }

        const identity = await getIdentity();
        const request = { path, payload };
        if (identity) request.identity = identity;

        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`InnerTube timeout sur ${path}`));
        }, REQUEST_TIMEOUT_MS);

        try {
            client.fetch(request).subscribe((response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(response);
            });
        } catch (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        }
    });
}

function textFromRuns(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.runs)) return value.runs.map((run) => run && run.text || '').join('');
    return '';
}

function durationToSeconds(label) {
    if (!label || typeof label !== 'string') return 0;
    const parts = label.split(':').map(Number);
    if (!parts.length || parts.some((value) => !Number.isFinite(value))) return 0;
    return parts.reduce((total, value) => total * 60 + value, 0);
}

function findThumbnail(node, videoId) {
    const candidates = [
        node && node.thumbnail && node.thumbnail.thumbnails,
        node && node.thumbnail && node.thumbnail.sources,
        node && node.contentImage && node.contentImage.thumbnailViewModel && node.contentImage.thumbnailViewModel.image && node.contentImage.thumbnailViewModel.image.sources,
        node && node.image && node.image.sources,
    ];
    for (const sources of candidates) {
        if (Array.isArray(sources) && sources.length) {
            const selected = sources[sources.length - 1];
            if (selected && selected.url) return selected.url;
        }
    }
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function collectSearchVideos(node, output, seen) {
    if (!node || typeof node !== 'object') return;

    const renderer = node.videoRenderer;
    if (renderer && renderer.videoId && !seen.has(renderer.videoId)) {
        const title = textFromRuns(renderer.title) || 'YouTube';
        const uploader = textFromRuns(renderer.ownerText) || textFromRuns(renderer.longBylineText) || 'YouTube';
        const duration = durationToSeconds(textFromRuns(renderer.lengthText));
        seen.add(renderer.videoId);
        output.push({
            id: renderer.videoId,
            title,
            duration,
            uploader,
            thumbnail: findThumbnail(renderer, renderer.videoId),
            url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
        });
    }

    const lockup = node.lockupViewModel;
    if (lockup && lockup.contentId && !seen.has(lockup.contentId)) {
        const metadata = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
        const title = textFromRuns(metadata && metadata.title) || 'YouTube';
        seen.add(lockup.contentId);
        output.push({
            id: lockup.contentId,
            title,
            duration: 0,
            uploader: 'YouTube',
            thumbnail: findThumbnail(lockup, lockup.contentId),
            url: `https://www.youtube.com/watch?v=${lockup.contentId}`,
        });
    }

    if (Array.isArray(node)) {
        node.forEach((item) => collectSearchVideos(item, output, seen));
        return;
    }

    Object.values(node).forEach((value) => collectSearchVideos(value, output, seen));
}

function extractVideoId(value) {
    if (!value) return '';
    try {
        const parsed = new URL(String(value));
        if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).split('/')[0];
        return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop() || '';
    } catch (_) {
        return String(value).trim();
    }
}

function findStreamingData(node, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (node.streamingData && typeof node.streamingData === 'object') return node.streamingData;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findStreamingData(item, seen);
            if (found) return found;
        }
        return null;
    }
    for (const value of Object.values(node)) {
        const found = findStreamingData(value, seen);
        if (found) return found;
    }
    return null;
}

function directFormats(formats) {
    return (Array.isArray(formats) ? formats : [])
        .filter((format) => format && typeof format.url === 'string' && format.url.startsWith('http'));
}

function bitrate(format) {
    return Number(format && (format.bitrate || format.averageBitrate || 0)) || 0;
}

function selectStream(response, action) {
    const streamingData = findStreamingData(response);
    if (!streamingData) return null;

    // `formats` are normally progressive/muxed streams suitable for one <video> URL.
    // `adaptiveFormats` are split audio/video streams; MusicFlow can use audio-only directly,
    // but does not combine a separate video track with a separate audio track here.
    const muxed = directFormats(streamingData.formats)
        .filter((format) => String(format.mimeType || '').startsWith('video/'))
        .sort((a, b) => Number(b.height || 0) - Number(a.height || 0) || bitrate(b) - bitrate(a));
    const adaptive = directFormats(streamingData.adaptiveFormats);
    const audioOnly = adaptive
        .filter((format) => String(format.mimeType || '').startsWith('audio/'))
        .sort((a, b) => bitrate(b) - bitrate(a));

    if (action === 'stream') return audioOnly[0] || muxed[0] || null;
    return muxed[0] || null;
}

function extractVideoMetadata(response, videoId) {
    const details = response && (response.videoDetails || response.playerResponse && response.playerResponse.videoDetails) || {};
    const micro = response && response.microformat && response.microformat.playerMicroformatRenderer || {};
    return {
        id: details.videoId || videoId,
        title: details.title || 'YouTube',
        duration: Number(details.lengthSeconds || 0),
        uploader: details.author || 'YouTube',
        thumbnail: details.thumbnail && Array.isArray(details.thumbnail.thumbnails) && details.thumbnail.thumbnails.length
            ? details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1].url
            : micro.thumbnail && Array.isArray(micro.thumbnail.thumbnails) && micro.thumbnail.thumbnails.length
                ? micro.thumbnail.thumbnails[micro.thumbnail.thumbnails.length - 1].url
                : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${details.videoId || videoId}`,
    };
}

async function executeJob(job) {
    if (!job || !job.action) throw new Error('Job MusicFlow invalide');

    if (job.action === 'search') {
        const response = await innerTubeFetch('/youtubei/v1/search', { query: String(job.query || '') });
        const videos = [];
        collectSearchVideos(response, videos, new Set());
        const max = Math.max(1, Math.min(30, Number(job.max || 10)));
        return { ok: true, source: 'tizentube', videos: videos.slice(0, max) };
    }

    const videoId = extractVideoId(job.url);
    if (!videoId) throw new Error('URL/ID YouTube manquant');
    const response = await innerTubeFetch('/youtubei/v1/player', {
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
    });

    if (job.action === 'metadata') {
        return { ok: true, source: 'tizentube', video: extractVideoMetadata(response, videoId) };
    }

    if (job.action === 'prefetch') {
        return { ok: true, source: 'tizentube', prefetched: true };
    }

    const format = selectStream(response, job.action);
    if (!format || !format.url) {
        throw new Error('TizenTube n’a retourné aucun flux direct non-DRM exploitable');
    }

    if (job.action === 'stream') {
        return { ok: true, source: 'tizentube', audioUrl: format.url, streamType: 'audio' };
    }
    return { ok: true, source: 'tizentube', videoUrl: format.url, streamType: 'video' };
}

async function detectService() {
    if (serviceBaseUrl) return serviceBaseUrl;
    for (const port of SERVICE_PORTS) {
        const candidate = `http://127.0.0.1:${port}/musicflow`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1200);
            const response = await fetch(`${candidate}/health`, { cache: 'no-store', signal: controller.signal });
            clearTimeout(timer);
            if (response.ok) {
                serviceBaseUrl = candidate;
                return candidate;
            }
        } catch (_) {
            // Try the next known TizenTube/TizenBrew port.
        }
    }
    return null;
}

async function submitResult(base, id, result) {
    await fetch(`${base}/jobs/${encodeURIComponent(id)}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
    });
}

async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
        const base = await detectService();
        if (!base) return;
        const response = await fetch(`${base}/jobs/next`, { cache: 'no-store' });
        if (response.status === 204) return;
        if (!response.ok) throw new Error(`Bridge local ${response.status}`);
        const job = await response.json();
        try {
            const result = await executeJob(job);
            await submitResult(base, job.id, result);
        } catch (error) {
            await submitResult(base, job.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    } catch (_) {
        serviceBaseUrl = null;
    } finally {
        polling = false;
    }
}

async function startMusicFlowBridge() {
    while (true) {
        await pollOnce();
        await delay(POLL_INTERVAL_MS);
    }
}

startMusicFlowBridge();
