const dial = require("@patrickkfkan/peer-dial");
const express = require('express');
const cors = require('cors');
const uuid = require('uuid');
const app = express();

const corsOptions = {
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const MUSICFLOW_BRIDGE_TOKEN = String(process.env.MUSICFLOW_BRIDGE_TOKEN || '').trim();
const MUSICFLOW_REQUEST_TIMEOUT_MS = 16000;
const MUSICFLOW_ACTIONS = new Set(['search', 'metadata', 'stream', 'video', 'prefetch']);
const musicFlowJobs = [];
const musicFlowPending = new Map();

function isMusicFlowAuthorized(req) {
    if (!MUSICFLOW_BRIDGE_TOKEN) return true;
    return String(req.get('x-musicflow-token') || '') === MUSICFLOW_BRIDGE_TOKEN;
}

function removeMusicFlowJob(id) {
    const index = musicFlowJobs.findIndex(job => job.id === id);
    if (index !== -1) musicFlowJobs.splice(index, 1);
}

app.get('/musicflow/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'tizentube-musicflow-bridge',
        queueDepth: musicFlowJobs.length,
        pending: musicFlowPending.size,
        auth: MUSICFLOW_BRIDGE_TOKEN ? 'token' : 'open-lan',
    });
});

app.post('/musicflow/request', (req, res) => {
    if (!isMusicFlowAuthorized(req)) {
        return res.status(401).json({ ok: false, error: 'MusicFlow token invalide' });
    }

    const payload = req.body || {};
    const action = String(payload.action || '');
    if (!MUSICFLOW_ACTIONS.has(action)) {
        return res.status(400).json({ ok: false, error: 'Action MusicFlow invalide' });
    }
    if (action === 'search' && !String(payload.query || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Recherche MusicFlow vide' });
    }
    if (action !== 'search' && !String(payload.url || '').trim()) {
        return res.status(400).json({ ok: false, error: 'URL YouTube manquante' });
    }

    const id = uuid.v4();
    const job = {
        id,
        action,
        query: payload.query,
        max: payload.max,
        url: payload.url,
        createdAt: Date.now(),
    };

    const timer = setTimeout(() => {
        removeMusicFlowJob(id);
        const pending = musicFlowPending.get(id);
        musicFlowPending.delete(id);
        if (pending && !pending.res.headersSent) {
            pending.res.status(504).json({ ok: false, error: 'TizenTube n’a pas répondu à temps' });
        }
    }, MUSICFLOW_REQUEST_TIMEOUT_MS);

    musicFlowPending.set(id, { res, timer });
    musicFlowJobs.push(job);
});

app.get('/musicflow/jobs/next', (_req, res) => {
    while (musicFlowJobs.length) {
        const job = musicFlowJobs.shift();
        if (job && musicFlowPending.has(job.id)) return res.json(job);
    }
    return res.status(204).end();
});

app.post('/musicflow/jobs/:id/result', (req, res) => {
    const id = String(req.params.id || '');
    const pending = musicFlowPending.get(id);
    if (!pending) return res.status(404).json({ ok: false, error: 'Job MusicFlow expiré ou inconnu' });

    clearTimeout(pending.timer);
    musicFlowPending.delete(id);
    removeMusicFlowJob(id);
    if (!pending.res.headersSent) pending.res.status(200).json(req.body || { ok: false, error: 'Réponse vide' });
    return res.json({ ok: true });
});

const PORT = global.isTizenTube ? 8095 : 8085;
const apps = {
    "YouTube": {
        name: "YouTube",
        state: "stopped",
        allowStop: true,
        pid: null,
        additionalData: {},
        launch(launchData) {
            const tbPackageId = tizen.application.getAppInfo().packageId;
            tizen.application.launchAppControl(
                new tizen.ApplicationControl(
                    "http://tizen.org/appcontrol/operation/view",
                    null,
                    null,
                    null,
                    [
                        new tizen.ApplicationControlData("module", [JSON.stringify(
                            {
                                moduleName: 'pml13210/TizenTube-MusicFlow@main',
                                moduleType: 'gh',
                                args: launchData
                            }
                        )])
                    ]
                ), `${tbPackageId}.${global.isTizenTube ? 'TizenTubeStandalone' : 'TizenBrewStandalone'}`);
        }
    }
};

const dialServer = new dial.Server({
    expressApp: app,
    port: PORT,
    prefix: "/dial",
    manufacturer: 'Reis Can',
    modelName: 'TizenBrew',
    friendlyName: `TizenTube (${tizen.systeminfo.getCapability('http://tizen.org/system/model_name')})`,
    uuid: uuid.v5(tizen.systeminfo.getCapability('http://tizen.org/system/tizenid'), '4bcbc514-bdd6-4163-8215-316526fd1d9b'),
    delegate: {
        getApp(appName) {
            return apps[appName];
        },
        launchApp(appName, launchData, callback) {
            console.log(`Got request to launch ${appName} with launch data: ${launchData}`);
            const app = apps[appName];
            if (app) {
                const parsedData = launchData.split('&').reduce((acc, cur) => {
                    const parts = cur.split('=');
                    const key = parts[0];
                    const value = parts[1];
                
                    if (typeof value !== 'undefined') {
                        acc[key] = value;
                    } else {
                        acc[key] = '';
                    }
                
                    return acc;
                }, {});
                
                if (parsedData.yumi) {
                    app.additionalData = parsedData;
                    app.state = "running"
                    callback("");
                    return;
                }
                app.pid = "run";
                app.state = "starting";
                app.launch(launchData);
                app.state = "running";
            }
            callback(app.pid);
        },
        stopApp(appName, pid, callback) {
            console.log(`Got request to stop ${appName} with pid: ${pid}`);
            const app = apps[appName];
            if (app && app.pid === pid) {
                app.pid = null;
                app.state = "stopped";
                callback(true);
            } else {
                callback(false);
            }
        }
    }
});


setInterval(() => {
    tizen.application.getAppsContext((appsContext) => {
        const tbPackageId = tizen.application.getAppInfo().packageId;
        const app = appsContext.find(app => app.appId === `${tbPackageId}.${global.isTizenTube ? 'TizenTubeStandalone' : 'TizenBrewStandalone'}`);
        if (!app) {
            apps["YouTube"].state = "stopped";
            apps["YouTube"].pid = null;
            apps["YouTube"].additionalData = {};
        }
    });
}, 5000);

app.listen(PORT, () => {
    dialServer.start();
});