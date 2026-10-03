const REQUEST_TIMEOUT_MS = 15000;
const PLAYER_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const PLAYER_CLIENT_VERSION = '20.10.38';
const SEARCH_CLIENT_VERSION = '2.20260114.08.00';

function getMappings() {
    if (!window._yttv) return null;
    const mapped = Object.values(window._yttv).find((value) => value && value.mappings);
    return mapped ? mapped.mappings : null;
}

function unwrapMapping(entry) {
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
        return entry.value;
    }
    return entry;
}

function getInnerTubeClient() {
    const mappings = getMappings();
    if (!mappings) return null;
    const client = unwrapMapping(mappings.get('KabukiInnerTubeClient'));
    return client && typeof client.fetch === 'function' ? client : null;
}

async function getIdentity() {
    const mappings = getMappings();
    const identityService = unwrapMapping(mappings && mappings.get('CurrentIdentityService'));
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

async function resolveAnonymousVisitorData() {
    try {
        const identity = await getIdentity();
        const candidates = [
            identity && identity.visitorData,
            identity && identity.context && identity.context.client && identity.context.client.visitorData,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.length > 8) return candidate;
        }
    } catch (_) {}

    try {
        if (window.ytcfg && typeof window.ytcfg.get === 'function') {
            const context = window.ytcfg.get('INNERTUBE_CONTEXT');
            const candidates = [
                window.ytcfg.get('VISITOR_DATA'),
                context && context.client && context.client.visitorData,
            ];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.length > 8) return candidate;
            }
        }
    } catch (_) {}
    return undefined;
}

async function directPlayerFetch(videoId) {
    const url = 'https://www.youtube.com/youtubei/v1/player?key=' + PLAYER_API_KEY + '&prettyPrint=false';
    const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
    };
    const visitorData = await resolveAnonymousVisitorData();
    const client = {
        clientName: 'ANDROID',
        clientVersion: PLAYER_CLIENT_VERSION,
        androidSdkVersion: 30,
        hl: 'fr',
        gl: 'FR',
        userAgent: 'com.google.android.youtube/' + PLAYER_CLIENT_VERSION + ' (Linux; U; Android 11) gzip',
    };
    if (visitorData) client.visitorData = visitorData;
    const body = JSON.stringify({
        context: {
            client,
            request: { useSsl: true },
        },
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
    });

    const desktopTransport = window.musicFlowTizenTubeTransport;
    if (desktopTransport && typeof desktopTransport.request === 'function') {
        const transported = await desktopTransport.request({
            url,
            method: 'POST',
            headers,
            body,
        });
        if (!transported || transported.ok !== true) {
            throw new Error('Player transport HTTP ' + String(transported && transported.status || 0));
        }
        try {
            return JSON.parse(String(transported.body || ''));
        } catch (_) {
            throw new Error('Player transport JSON invalide');
        }
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        body,
    });

    if (!response.ok) {
        throw new Error('Player HTTP ' + response.status);
    }
    return response.json();
}

async function resolvePlayerResponse(videoId, action) {
    try {
        const sessionResponse = await innerTubeFetch('/youtubei/v1/player', {
            videoId,
            racyCheckOk: true,
            contentCheckOk: true,
        });
        if (action === 'metadata' || action === 'prefetch' || selectStream(sessionResponse, action)) {
            return sessionResponse;
        }
    } catch (_) {
        // The YouTube TV client can be unavailable during bootstrap. The Android player request below
        // remains the provider-agnostic fallback used by desktop and other installed surfaces.
    }
    return directPlayerFetch(videoId);
}

function getRuntimeCommandResolver() {
    if (!window._yttv) return null;
    for (const key in window._yttv) {
        const resolver = window._yttv[key] && window._yttv[key].instance && window._yttv[key].instance.resolveCommand;
        if (typeof resolver === 'function') return resolver;
    }
    return null;
}

function runtimeVideoElement() {
    return document.querySelector('video');
}

function runtimeVideoId() {
    try {
        const player = document.querySelector('.html5-video-player');
        const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
        return String(data && (data.video_id || data.videoId) || '');
    } catch (_) {
        return '';
    }
}

function runtimeState() {
    const video = runtimeVideoElement();
    return {
        ready: Boolean(video),
        videoId: runtimeVideoId(),
        currentTime: Number(video && video.currentTime || 0),
        duration: Number(video && video.duration || 0),
        paused: video ? Boolean(video.paused) : true,
        ended: video ? Boolean(video.ended) : false,
        volume: video ? Number(video.volume || 0) : 0,
    };
}

async function waitForRuntimeCommandResolver() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
        if (getRuntimeCommandResolver()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Runtime TizenTube TV indisponible');
}

async function waitForRuntimeVideo(videoId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
        const video = runtimeVideoElement();
        const activeVideoId = runtimeVideoId();
        if (video && (activeVideoId === videoId || (!activeVideoId && video.readyState > 0))) {
            return video;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Lecteur TizenTube TV indisponible');
}

async function playInRuntime(videoId) {
    await waitForRuntimeCommandResolver();
    const resolver = getRuntimeCommandResolver();
    if (!resolver) throw new Error('Runtime TizenTube TV indisponible');
    resolver({ watchEndpoint: { videoId } });
    const video = await waitForRuntimeVideo(videoId);
    try {
        await video.play();
    } catch (_) {
        // Android/iOS configure the embedded WebView for autoplay. If WebKit still defers
        // playback, MusicFlow can retry with runtimeControl('play') from the user gesture.
    }
    return runtimeState();
}

async function controlRuntime(command, value, videoId) {
    if (command === 'load') {
        if (!videoId) throw new Error('videoId TizenTube manquant');
        return playInRuntime(videoId);
    }

    if (command === 'state') {
        return runtimeState();
    }

    const video = runtimeVideoElement();
    if (!video) throw new Error('Lecteur TizenTube TV indisponible');

    if (command === 'play') {
        await video.play();
    } else if (command === 'pause') {
        video.pause();
    } else if (command === 'seek') {
        const target = Number(value);
        if (!Number.isFinite(target)) throw new Error('Position TizenTube invalide');
        video.currentTime = Math.max(0, Math.min(Number(video.duration || target), target));
    } else if (command === 'volume') {
        const target = Number(value);
        if (!Number.isFinite(target)) throw new Error('Volume TizenTube invalide');
        video.volume = Math.max(0, Math.min(1, target));
    } else {
        throw new Error('Commande TizenTube native non autorisée');
    }

    return runtimeState();
}

async function directSearchFetch(query) {
    const response = await fetch('https://www.youtube.com/youtubei/v1/search?key=' + PLAYER_API_KEY + '&prettyPrint=false', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
        },
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({
            context: {
                client: {
                    clientName: 'WEB',
                    clientVersion: SEARCH_CLIENT_VERSION,
                    hl: 'fr',
                    gl: 'FR',
                },
                request: { useSsl: true },
            },
            query: String(query || ''),
        }),
    });
    if (!response.ok) throw new Error('Recherche HTTP ' + response.status);
    return response.json();
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
    if (lockup && /^[A-Za-z0-9_-]{11}$/.test(String(lockup.contentId)) && !seen.has(lockup.contentId)) {
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
    if (muxed[0]) return muxed[0];
    if (typeof streamingData.hlsManifestUrl === 'string' && streamingData.hlsManifestUrl.startsWith('http')) {
        return { url: streamingData.hlsManifestUrl, mimeType: 'application/x-mpegURL', protocol: 'hls' };
    }
    return null;
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

    if (job.action === 'control') {
        const runtime = await controlRuntime(job.command, job.value, extractVideoId(job.videoId || job.url));
        return { ok: true, source: 'tizentube-runtime', playbackKind: 'native', runtime };
    }

    if (job.action === 'search') {
        let response;
        try {
            response = await innerTubeFetch('/youtubei/v1/search', { query: String(job.query || '') });
        } catch (error) {
            if (!/KabukiInnerTubeClient indisponible/i.test(String(error && error.message || error))) throw error;
            response = await directSearchFetch(job.query);
        }
        const videos = [];
        collectSearchVideos(response, videos, new Set());
        const max = Math.max(1, Math.min(30, Number(job.max || 10)));
        return { ok: true, source: 'tizentube', videos: videos.slice(0, max) };
    }

    const videoId = extractVideoId(job.videoId || job.url);
    if (!videoId) throw new Error('URL/ID YouTube manquant');

    let response;
    try {
        response = await resolvePlayerResponse(videoId, job.action);
    } catch (error) {
        if (job.action === 'video') {
            return {
                ok: true,
                source: 'tizentube-runtime',
                videoUrl: `tizentube://runtime/${videoId}`,
                streamType: 'video',
                playbackKind: 'native',
            };
        }
        throw error;
    }

    if (job.action === 'metadata') {
        return { ok: true, source: 'tizentube', video: extractVideoMetadata(response, videoId) };
    }

    if (job.action === 'prefetch') {
        return { ok: true, source: 'tizentube', prefetched: true };
    }

    const format = selectStream(response, job.action);
    if (!format || !format.url) {
        if (job.action === 'video') {
            return {
                ok: true,
                source: 'tizentube-runtime',
                videoUrl: `tizentube://runtime/${videoId}`,
                streamType: 'video',
                playbackKind: 'native',
            };
        }
        throw new Error('TizenTube n’a retourné aucun flux direct non-DRM exploitable');
    }

    if (job.action === 'stream') {
        return { ok: true, source: 'tizentube', audioUrl: format.url, streamType: 'audio' };
    }
    return { ok: true, source: 'tizentube', videoUrl: format.url, streamType: 'video', playbackKind: 'stream' };
}

window.TizenTubeMusicFlow = Object.freeze({
    async execute(job) {
        try {
            return await executeJob(job);
        } catch (error) {
            return {
                ok: false,
                source: 'tizentube',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
    isReady() {
        return typeof window.fetch === 'function';
    },
});
