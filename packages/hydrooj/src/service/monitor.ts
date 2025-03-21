import crypto from 'crypto';
import { dump } from 'js-yaml';
import superagent from 'superagent';
import type { StatusUpdate } from '@hydrooj/utils/lib/sysinfo';
import * as sysinfo from '@hydrooj/utils/lib/sysinfo';
import { Logger } from '../logger';
import * as bus from './bus';
import db from './db';

const coll = db.collection('status');
const logger = new Logger('monitor');

function crypt(str: string) {
    const cipher = crypto.createCipheriv('des-ecb', 'hydro-oj', ''); // lgtm [js/hardcoded-credentials]
    let encrypted = cipher.update(str, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

export async function feedback(): Promise<[string, StatusUpdate]> {
    const {
        system, domain, document, user, record,
    } = global.Hydro.model;
    const version = require('hydrooj/package.json').version;
    const [mid, $update, inf] = await sysinfo.update();
    const [installId, name, url] = system.getMany(['installid', 'server.name', 'server.url']);
    const [domainCount, userCount, problemCount, discussionCount, recordCount] = await Promise.all([
        domain.getMulti().count(),
        user.getMulti().count(),
        document.coll.find({ docType: document.TYPE_PROBLEM }).count(),
        document.coll.find({ docType: document.TYPE_DISCUSSION }).count(),
        record.coll.find().count(),
    ]);
    const info: Record<string, any> = {
        mid: mid.toString(),
        version,
        name,
        url,
        domainCount,
        userCount,
        problemCount,
        discussionCount,
        recordCount,
        addons: global.addons,
        memory: inf.memory,
        osinfo: inf.osinfo,
        cpu: inf.cpu,
    };
    try {
        let host = system.get('hydrojudge.sandbox_host') || 'http://localhost:5050/';
        if (!host.endsWith('/')) host += '/';
        const res = await superagent.get(`${host}version`);
        info.sandbox = res.body;
    } catch (e) { }
    try {
        const status = await db.db.admin().serverStatus();
        info.dbVersion = status.version;
    } catch (e) { }
    const payload = crypt(dump(info, {
        replacer: (key, value) => {
            if (typeof value === 'function') return '';
            return value;
        },
    }));
    if (process.env.CI) return [mid, $update];
    superagent.post(`${system.get('server.center')}/report`)
        .send({ installId, payload })
        .then((res) => {
            if (res.body.updateUrl?.startsWith('https://')) system.set('server.center', res.body.updateUrl);
            if (res.body.notification) global.Hydro.model.message.sendNotification(res.body.notification);
        })
        .catch(() => logger.debug('Cannot connect to hydro center.'));
    return [mid, $update];
}

export async function update() {
    const [mid, $update] = await feedback();
    const $set = {
        ...$update,
        updateAt: new Date(),
        reqCount: 0,
    };
    await bus.serial('monitor/update', 'server', $set);
    await coll.updateOne(
        { mid, type: 'server' },
        { $set },
        { upsert: true },
    );
}

export async function updateJudge(args) {
    const $set = { ...args, updateAt: new Date() };
    await bus.serial('monitor/update', 'judge', $set);
    return await coll.updateOne(
        { mid: args.mid, type: 'judge' },
        { $set },
        { upsert: true },
    );
}

if (process.env.NODE_APP_INSTANCE === '0') {
    bus.on('app/started', async () => {
        sysinfo.get().then((info) => {
            coll.updateOne(
                { mid: info.mid, type: 'server' },
                { $set: { ...info, updateAt: new Date(), type: 'server' } },
                { upsert: true },
            );
            feedback();
            setInterval(update, 1800 * 1000);
        });
    });
}

global.Hydro.service.monitor = { feedback, update, updateJudge };
