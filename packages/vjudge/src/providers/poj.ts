/* eslint-disable no-await-in-loop */
import { PassThrough } from 'stream';
import { JSDOM } from 'jsdom';
import * as superagent from 'superagent';
import proxy from 'superagent-proxy';
import { STATUS } from '@hydrooj/utils/lib/status';
import {
    htmlEncode, parseMemoryMB, parseTimeMS, sleep,
} from '@hydrooj/utils/lib/utils';
import { Logger } from 'hydrooj/src/logger';
import * as setting from 'hydrooj/src/model/setting';
import { IBasicProvider, RemoteAccount } from '../interface';
import { VERDICT } from '../verdict';

proxy(superagent as any);
const logger = new Logger('remote/poj');

/* langs
poj:
  display: POJ
  execute: /bin/echo Invalid
  domain:
  - poj
poj.0:
  display: G++
  monaco: cpp
  highlight: cpp astyle-c
  comment: //
poj.1:
  display: GCC
  monaco: c
  highlight: c astyle-c
  comment: //
poj.2:
  display: Java
  monaco: java
  highlight: java astyle-java
  comment: //
poj.3:
  display: Pascal
  monaco: pascal
  highlight: pascal
  comment: //
poj.4:
  display: C++
  monaco: cpp
  highlight: cpp astyle-c
  comment: //
poj.5:
  display: C
  monaco: c
  highlight: c astyle-c
  comment: //
poj.6:
  display: Fortran
  monaco: plain
  highlight: plain
*/

const langs = {
    default: 'en',
    'zh-CN': 'zh_CN',
    es: 'es',
    ja: 'ja',
};

export default class POJProvider implements IBasicProvider {
    constructor(public account: RemoteAccount, private save: (data: any) => Promise<void>) {
        if (account.cookie) this.cookie = account.cookie;
    }

    cookie: string[] = [];

    get(url: string) {
        logger.debug('get', url);
        if (!url.startsWith('http')) url = new URL(url, this.account.endpoint || 'http://poj.org').toString();
        const req = superagent.get(url).set('Cookie', this.cookie);
        if (this.account.proxy) return req.proxy(this.account.proxy);
        return req;
    }

    post(url: string) {
        logger.debug('post', url, this.cookie);
        if (!url.includes('//')) url = `${this.account.endpoint || 'http://poj.org'}${url}`;
        const req = superagent.post(url).set('Cookie', this.cookie).type('form');
        if (this.account.proxy) return req.proxy(this.account.proxy);
        return req;
    }

    async getCsrfToken(url: string) {
        const { header } = await this.get(url);
        if (header['set-cookie']) {
            await this.save({ cookie: header['set-cookie'] });
            this.cookie = header['set-cookie'];
        }
        return '';
    }

    get loggedIn() {
        return this.get('/submit?problem_id=1000').then(({ text: html }) => !html.includes('<form method=POST action=login>'));
    }

    async ensureLogin() {
        if (await this.loggedIn) return true;
        logger.info('retry login');
        await this.getCsrfToken('/');
        await this.post('/login')
            .set('referer', 'http://poj.org/')
            .send({
                user_id1: this.account.handle,
                password1: this.account.password,
                B1: 'login',
                url: '/',
            });
        return this.loggedIn;
    }

    async getProblem(id: string) {
        logger.info(id);
        const res = await this.get(`/problem?id=${id.split('P')[1]}`);
        const { window: { document } } = new JSDOM(res.text);
        const files = {};
        const main = document.querySelector('[background="images/table_back.jpg"]>tbody>tr>td');
        const languages = [...main.children[0].children[0].children]
            .map((i) => i.getAttribute('value'));
        const info = main.getElementsByClassName('plm')[0]
            .children[0].children[0].children[0];
        const time = info.children[0].innerHTML.split('</b> ')[1].toLowerCase().trim();
        const memory = info.children[2].innerHTML.split('</b> ')[1].toLowerCase().trim();
        const contents = {};
        const images = {};
        for (const lang of languages) {
            await sleep(1000);
            const { text } = await this.get(`/problem?id=${id.split('P')[1]}&lang=${lang}&change=true`);
            const { window: { document: page } } = new JSDOM(text);
            const content = page.querySelector('[background="images/table_back.jpg"]>tbody>tr>td');
            content.children[0].remove();
            content.children[0].remove();
            content.children[0].remove();
            content.querySelectorAll('img[src]').forEach((ele) => {
                const src = ele.getAttribute('src');
                if (images[src]) {
                    ele.setAttribute('src', `file://${images[src]}.png`);
                    return;
                }
                const file = new PassThrough();
                this.get(src).pipe(file);
                const fid = String.random(8);
                images[src] = fid;
                files[`${fid}.png`] = file;
                ele.setAttribute('src', `file://${fid}.png`);
            });
            let lastId = 0;
            let markNext = '';
            let html = '';
            for (const node of content.children) {
                if (node.className.includes('pst')) {
                    if (!node.innerHTML.startsWith('Sample ')) {
                        html += `<h2>${htmlEncode(node.innerHTML)}</h2>`;
                    } else if (node.innerHTML.startsWith('Sample Input')) {
                        lastId++;
                        markNext = 'input';
                    } else {
                        markNext = 'output';
                    }
                } else if (node.className.includes('sio')) {
                    html += `<pre><code class="language-${markNext}${lastId}">${htmlEncode(node.innerHTML)}</code></pre>`;
                } else if (node.className.includes('ptx')) {
                    for (const item of node.innerHTML.split('\n<br>\n<br>')) {
                        const p = page.createElement('p');
                        p.innerHTML = item.trim();
                        html += p.outerHTML;
                    }
                } else html += node.innerHTML;
            }
            contents[langs[lang]] = html;
        }
        return {
            title: main.getElementsByClassName('ptt')[0].innerHTML,
            data: {
                'config.yaml': Buffer.from(`time: ${time}\nmemory: ${memory}\ntype: remote_judge\nsubType: poj\ntarget: ${id}`),
            },
            files,
            tag: [],
            content: JSON.stringify(contents),
        };
    }

    async listProblem(page: number, resync = false) {
        if (resync && page > 1) return [];
        const { text } = await this.get(`/problemlist?volume=${page}`);
        const $dom = new JSDOM(text);
        return Array.from($dom.window.document.querySelectorAll('.a>tbody>tr[align="center"]'))
            .map((i) => `P${+i.children[0].innerHTML ? i.children[0].innerHTML : i.children[1].innerHTML}`);
    }

    async submitProblem(id: string, lang: string, code: string, info) {
        await this.ensureLogin();
        const language = lang.includes('poj.') ? lang.split('poj.')[1] : '0';
        const comment = setting.langs[lang].comment;
        if (comment) {
            const msg = `Hydro submission #${info.rid}@${new Date().getTime()}`;
            if (typeof comment === 'string') code = `${comment} ${msg}\n${code}`;
            else if (comment instanceof Array) code = `${comment[0]} ${msg} ${comment[1]}\n${code}`;
        }
        code = Buffer.from(code).toString('base64');
        const { text } = await this.post('/submit').send({
            problem_id: id.split('P')[1],
            language,
            source: code,
            submit: 'Submit',
            encoded: 1,
        });
        if (text.includes('Error Occurred')) {
            throw new Error(text.split('<li>')[1].split('</li>')[0]);
        }
        const { text: status } = await this.get(`/status?problem_id=${id.split('P')[1]}&user_id=${this.account.handle}&result=&language=${language}`);
        const $dom = new JSDOM(status);
        return $dom.window.document.querySelector('.a>tbody>tr[align="center"]>td').innerHTML;
    }

    // eslint-disable-next-line consistent-return
    async waitForSubmission(id: string, next, end) {
        let count = 0;
        // eslint-disable-next-line no-constant-condition
        while (count < 60) {
            count++;
            await sleep(3000);
            const { text } = await this.get(`/status?top=${+id + 1}`);
            const { window: { document } } = new JSDOM(text);
            const submission = document.querySelector('.a>tbody>tr[align="center"]');
            const status = VERDICT[submission.children[3].children[0].textContent.trim().toUpperCase()]
                || STATUS.STATUS_SYSTEM_ERROR;
            if (status === STATUS.STATUS_JUDGING) continue;
            if (status === STATUS.STATUS_COMPILE_ERROR) {
                const { text: info } = await this.get(`/showcompileinfo?solution_id=${id}`);
                const ceInfo = new JSDOM(info);
                await next({ compilerText: ceInfo.window.document.querySelector('pre>font').innerHTML });
                return await end({
                    status,
                    score: 0,
                    time: 0,
                    memory: 0,
                });
            }
            const memory = parseMemoryMB(submission.children[4].innerHTML.trim() || 0) * 1024;
            const time = parseTimeMS(submission.children[5].innerHTML.trim() || 0);
            return await end({
                status,
                score: status === STATUS.STATUS_ACCEPTED ? 100 : 0,
                time,
                memory,
            });
        }
    }
}
