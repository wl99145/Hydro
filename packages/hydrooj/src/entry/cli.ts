/* eslint-disable import/no-dynamic-require */
/* eslint-disable no-await-in-loop */
import cac from 'cac';
import { ObjectID } from 'mongodb';
import { validate } from '../lib/validator';
import options from '../options';
import db from '../service/db';
import {
    lib, model, script, service,
} from './common';

const argv = cac().parse();
const COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;
const ARR = /=>.*$/mg;
function parseParameters(fn: Function) {
    const code = fn.toString()
        .replace(COMMENTS, '')
        .replace(ARR, '');
    const result = code.slice(code.indexOf('(') + 1, code.indexOf(')'))
        .match(/([^,]+)/g)?.map((i) => i.trim());
    return result ?? [];
}

async function runScript(name: string, arg: any) {
    const s = global.Hydro.script[name];
    if (!s) return console.error('Script %s not found.', name);
    if (typeof s.validate === 'function') {
        arg = s.validate(arg);
    } else {
        console.warn('You are using the legacy script validation API, which will be dropped in the future.');
        validate(s.validate, arg);
    }
    return await s.run(arg, console.info);
}

async function cli() {
    const [, modelName, func, ...args] = argv.args as [string, string, string, ...any[]];
    if (modelName === 'script') {
        let arg: any;
        console.log(args.join(' '));
        try {
            arg = JSON.parse(args.join(' '));
        } catch (e) {
            return console.error('Invalid argument');
        }
        return await runScript(func, arg);
    }
    if (!global.Hydro.model[modelName]) {
        return console.error(`Model ${modelName} doesn't exist.`);
    }
    if (!func) {
        return console.log(Object.keys(global.Hydro.model[modelName]));
    }
    if (!global.Hydro.model[modelName][func]) {
        return console.error(`Function ${func} doesn't exist in model ${modelName}.`);
    }
    if (typeof global.Hydro.model[modelName][func] !== 'function') {
        return console.error(`${func} in model ${modelName} is not a function.`);
    }
    const parameterMin = global.Hydro.model[modelName][func].length;
    const parameters = parseParameters(global.Hydro.model[modelName][func]);
    const parameterMax = parameters.length;
    if (args.length > parameterMax) {
        console.error(`Too many arguments. Max ${parameterMax}`);
        return console.error(parameters.join(', '));
    }
    if (args.length < parameterMin) {
        console.error(`Too few arguments. Min ${parameterMin}`);
        return console.error(parameters.join(', '));
    }
    for (let i = 0; i < args.length; i++) {
        if ("'\"".includes(args[i][0]) && "'\"".includes(args[i][args[i].length - 1])) {
            args[i] = args[i].substr(1, args[i].length - 2);
        } else if (args[i].length === 24 && ObjectID.isValid(args[i])) {
            args[i] = new ObjectID(args[i]);
        } else if ((+args[i]).toString() === args[i]) {
            args[i] = +args[i];
        } else if (args[i].startsWith('~')) {
            args[i] = argv.options[args[i].substr(1)];
        }
    }
    let result = global.Hydro.model[modelName][func](...args);
    if (result instanceof Promise) result = await result;
    return console.log(result);
}

export async function load() {
    const pending = global.addons;
    const fail = [];
    require('../lib/i18n');
    require('../utils');
    require('../error');
    require('../options');
    const opts = options();
    await db.start(opts);
    await require('../settings').loadConfig();
    const storage = require('../service/storage');
    await storage.loadStorageService();
    require('../lib/index');
    await lib(pending, fail);
    const systemModel = require('../model/system');
    await systemModel.runConfig();
    await service(pending, fail);
    require('../model/index');
    await model(pending, fail);
    require('../script/index');
    await script(pending, fail, []);
    await cli();
}
