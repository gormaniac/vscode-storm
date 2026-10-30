// Storm for VS Code: lint, completion and hover docs from a Storm language server (server/stormls.py).
//
// The server is a Python process speaking JSON lines on stdio. It checks Storm against a temporary
// in-process Cortex (the Synapse core model and built-in commands) or, after "Storm: Connect to
// Cortex", against a real Cortex over telepath. Highlighting is the TextMate grammar and needs none
// of this. There are no npm dependencies: only the vscode API and Node built-ins.

const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

const LANG = 'storm';
const SECRET_CORTEX = 'storm.cortexUrl';
const MAX_ITEMS = 60;

const UNIVERSAL = [
    ['.created', 'The time the node was created in the Cortex.'],
    ['.seen', 'The time interval the node was observed.'],
];

const KEYWORDS = ['if', 'elif', 'else', 'for', 'while', 'switch', 'try', 'catch', 'break', 'continue',
    'return', 'emit', 'stop', 'function', 'init', 'fini', 'empty', 'and', 'or', 'not', 'in', 'as',
    'true', 'false', 'null', 'yield', 'reverse'];

// ---------------------------------------------------------------------- the language server

class Server {

    constructor(context, output) {
        this.context = context;
        this.output = output;
        this.proc = null;
        this.seq = 0;
        this.pending = new Map();
        this.ready = null;
        this.info = null;
        this.cache = {};
        this.restarts = 0;
        this.stopping = false;
        this.onState = new vscode.EventEmitter();
    }

    // ready is set at once, so requests made while the server starts wait for it
    start() {
        this.ready = this._start();
        this.ready.catch((err) => this.onState.fire({state: 'error', mesg: err.message}));
        return this.ready;
    }

    async _start() {
        this.stopping = false;
        const cfg = vscode.workspace.getConfiguration('storm');
        const python = cfg.get('pythonPath') || 'python3';
        const script = path.join(this.context.extensionPath, 'server', 'stormls.py');
        const args = [script];
        const cortex = await this.context.secrets.get(SECRET_CORTEX);
        if (cortex) args.push('--cortex', cortex);

        this.cache = {};
        this.info = null;
        this.onState.fire({state: 'starting', remote: !!cortex});
        this.output.appendLine(`starting: ${python} ${script}${cortex ? ' --cortex <url>' : ''}`);

        const proc = cp.spawn(python, args, {stdio: ['pipe', 'pipe', 'pipe']});
        this.proc = proc;

        return new Promise((resolve, reject) => {
            let buf = '';
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.trim()) continue;
                    let mesg;
                    try { mesg = JSON.parse(line); } catch (e) { this.output.appendLine(line); continue; }
                    if (mesg.event === 'ready') {
                        this.info = mesg;
                        this.restarts = 0;
                        this.onState.fire({state: 'ready', ...mesg});
                        resolve(mesg);
                        continue;
                    }
                    const req = this.pending.get(mesg.id);
                    if (!req) continue;
                    this.pending.delete(mesg.id);
                    if (mesg.error) req.reject(Object.assign(new Error(mesg.error.mesg), {code: mesg.error.code}));
                    else req.resolve(mesg.result);
                }
            });
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (chunk) => this.output.append(chunk));
            proc.on('error', (err) => {
                this.output.appendLine(`could not start ${python}: ${err.message}`);
                reject(err);
            });
            proc.on('exit', (code, signal) => {
                if (this.proc !== proc) return;
                this.proc = null;
                for (const req of this.pending.values()) req.reject(new Error('The Storm language server exited.'));
                this.pending.clear();
                const err = new Error(`The Storm language server exited (${signal || code}). See the Storm output.`);
                reject(err);
                if (this.stopping) return;
                this.onState.fire({state: 'error', mesg: err.message});
                // a crash after it was running restarts it, a few times
                if (this.info && this.restarts < 3) {
                    this.restarts++;
                    setTimeout(() => this.start().catch(() => {}), 1000 * this.restarts);
                }
            });
        });
    }

    stop() {
        this.stopping = true;
        const proc = this.proc;
        this.proc = null;
        if (proc) proc.kill();
        for (const req of this.pending.values()) req.reject(new Error('The Storm language server stopped.'));
        this.pending.clear();
    }

    async restart() {
        this.stop();
        return this.start();
    }

    async request(op, params = {}) {
        await this.ready;
        if (!this.proc) throw new Error('The Storm language server is not running.');
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.proc.stdin.write(JSON.stringify({id, op, ...params}) + '\n');
        });
    }

    // docs and model are fetched once per server start
    cached(op) {
        if (!this.cache[op]) {
            this.cache[op] = this.request(op).catch((err) => { delete this.cache[op]; throw err; });
        }
        return this.cache[op];
    }

    async docs() {
        const d = await this.cached('docs');
        if (!d.libMap) d.libMap = new Map(d.libs.map(l => [l.path, l]));
        return d;
    }

    model() {
        return this.cached('model');
    }
}

// ---------------------------------------------------------------------- offsets

// the server counts code points (Python), VS Code counts UTF-16 code units
function utf16Offset(text, offs) {
    if (!/[\uD800-\uDFFF]/.test(text)) return offs;
    let units = 0;
    let points = 0;
    while (points < offs && units < text.length) {
        const code = text.charCodeAt(units);
        units += code >= 0xD800 && code <= 0xDBFF ? 2 : 1;
        points++;
    }
    return units;
}

// ---------------------------------------------------------------------- diagnostics

const SEVERITY = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
};

class Linter {

    constructor(server) {
        this.server = server;
        this.collection = vscode.languages.createDiagnosticCollection(LANG);
        this.timers = new Map();
    }

    schedule(doc, wait) {
        if (doc.languageId !== LANG) return;
        const cfg = vscode.workspace.getConfiguration('storm', doc);
        if (!cfg.get('lint.enabled')) { this.collection.delete(doc.uri); return; }
        const key = doc.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => this.lint(doc), wait ?? cfg.get('lint.delay')));
    }

    async lint(doc) {
        const key = doc.uri.toString();
        this.timers.delete(key);
        const version = doc.version;
        const text = doc.getText();
        let findings;
        try {
            findings = await this.server.request('lint', {text});
        } catch (err) {
            return;
        }
        // the text changed while the server was linting: a newer lint is coming
        if (doc.isClosed || doc.version !== version) return;

        const diags = findings.map((f) => {
            const start = doc.positionAt(utf16Offset(text, f.offs));
            const end = doc.positionAt(utf16Offset(text, Math.max(f.end, f.offs + 1)));
            const diag = new vscode.Diagnostic(new vscode.Range(start, end), f.mesg, SEVERITY[f.severity] ?? vscode.DiagnosticSeverity.Warning);
            diag.code = f.name ? `${f.rule} ${f.name}` : f.rule;
            diag.source = 'storm';
            return diag;
        });
        this.collection.set(doc.uri, diags);
    }

    forget(doc) {
        clearTimeout(this.timers.get(doc.uri.toString()));
        this.timers.delete(doc.uri.toString());
        this.collection.delete(doc.uri);
    }

    lintAll() {
        for (const doc of vscode.workspace.textDocuments) this.schedule(doc, 0);
    }
}

// ---------------------------------------------------------------------- completion and hover

// true if offs is inside a string or a comment (on its line)
function inStringOrComment(text, offs) {
    const line = text.slice(text.lastIndexOf('\n', offs - 1) + 1, offs);
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\' && quote === '"') i++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') {
            quote = c;
        } else if (c === '/' && line[i + 1] === '/') {
            return true;
        }
    }
    return quote !== null;
}

function longestForm(model, name) {
    while (name && !model.forms[name]) name = name.includes(':') ? name.slice(0, name.lastIndexOf(':')) : '';
    return name || null;
}

// the forms a query mentions (to complete relative props)
function formsIn(model, text) {
    const found = new Set();
    for (const match of text.matchAll(/[a-z_][a-z0-9_]*(?::[a-z0-9_]+)+/g)) {
        const form = longestForm(model, match[0]);
        if (form) found.add(form);
    }
    return [...found];
}

function typeName(type) {
    return Array.isArray(type) ? type[0] : (type || '');
}

const KIND = {
    form: vscode.CompletionItemKind.Class,
    prop: vscode.CompletionItemKind.Property,
    cmd: vscode.CompletionItemKind.Function,
    lib: vscode.CompletionItemKind.Module,
    fn: vscode.CompletionItemKind.Method,
    tag: vscode.CompletionItemKind.Constant,
    kw: vscode.CompletionItemKind.Keyword,
};

function item(label, kind, detail, doc, insert, sortText) {
    const ci = new vscode.CompletionItem(label, KIND[kind]);
    ci.detail = detail || undefined;
    if (doc) ci.documentation = new vscode.MarkdownString(doc);
    if (insert) ci.insertText = insert;
    if (sortText) ci.sortText = sortText;
    return ci;
}

class Completion {

    constructor(server) {
        this.server = server;
    }

    async provideCompletionItems(doc, pos, token, ctx) {
        const text = doc.getText();
        const offs = doc.offsetAt(pos);
        if (inStringOrComment(text, offs)) return null;
        const before = text.slice(0, offs);
        const explicit = ctx.triggerKind === vscode.CompletionTriggerKind.Invoke;
        const range = (len) => new vscode.Range(doc.positionAt(offs - len), pos);
        let m;

        try {
            // $lib.path.member
            if ((m = before.match(/\$lib((?:\.\w+)*)\.(\w*)$/))) {
                const docs = await this.server.docs();
                const lpath = '$lib' + m[1];
                const items = [];
                for (const [p, lib] of docs.libMap) {
                    if (!p.startsWith(lpath + '.')) continue;
                    const rest = p.slice(lpath.length + 1);
                    if (!rest.includes('.')) items.push(item(rest, 'lib', 'library', lib.doc));
                }
                for (const mem of docs.libMap.get(lpath)?.members || []) {
                    const fn = mem.type === 'function';
                    const ci = item(mem.name, fn ? 'fn' : 'prop', mem.sig || mem.type, mem.doc,
                        fn ? new vscode.SnippetString(`${mem.name}($0)`) : undefined);
                    items.push(ci);
                }
                items.forEach(i => { i.range = range(m[2].length); });
                return items;
            }

            // #tag
            if ((m = before.match(/#([\w.]*)$/))) {
                const partial = m[1];
                const tags = await this.server.request('tags', {prefix: partial.replace(/\.$/, '')});
                return tags.filter(t => t.startsWith(partial)).map(t => {
                    const ci = item(t, 'tag', 'tag');
                    ci.range = range(partial.length);
                    return ci;
                });
            }

            // a command after a pipe (possibly on an earlier line)
            if ((m = before.match(/\|\s*([\w.]*)$/))) {
                const docs = await this.server.docs();
                return new vscode.CompletionList(docs.commands.map(c => {
                    const ci = item(c.name, 'cmd', c.pkg ? `command (${c.pkg})` : 'command', c.doc, `${c.name} `);
                    ci.range = range(m[1].length);
                    return ci;
                }), false);
            }

            // a relative prop of the forms in the query, or a universal prop
            if ((m = before.match(/(?:^|[\s(\[{+\-=<>])([:.][\w:]*)$/))) {
                const partial = m[1];
                const items = [];
                if (partial.startsWith('.')) {
                    for (const [name, d] of UNIVERSAL) items.push(item(name, 'prop', 'universal', d));
                } else {
                    const model = await this.server.model();
                    const seen = new Set();
                    for (const form of formsIn(model, text)) {
                        for (const pdef of model.forms[form].props) {
                            if (pdef.name.startsWith('.') || seen.has(pdef.name)) continue;
                            seen.add(pdef.name);
                            items.push(item(`:${pdef.name}`, 'prop', `${form} · ${typeName(pdef.type)}`, pdef.doc));
                        }
                    }
                }
                items.forEach(i => { i.range = range(partial.length); });
                return items;
            }

            // a form, form:prop or keyword
            if ((m = before.match(/(?:^|[^\w$:#.\-])([a-z_][\w]*(?::[\w]*)*)$/))) {
                const partial = m[1];
                if (partial.length < 2 && !explicit) return null;
                const model = await this.server.model();
                const items = [];
                const colon = partial.lastIndexOf(':');
                const form = colon > 0 ? longestForm(model, partial.slice(0, colon)) : null;
                if (form) {
                    for (const pdef of model.forms[form].props) {
                        const full = `${form}:${pdef.name}`.replace(':.', '.');
                        items.push(item(full, 'prop', typeName(pdef.type), pdef.doc));
                    }
                }
                for (const [name, fdef] of Object.entries(model.forms)) {
                    if (name.startsWith(partial.split(':')[0])) items.push(item(name, 'form', 'form', fdef.doc));
                }
                if (!partial.includes(':')) {
                    for (const kw of KEYWORDS) if (kw.startsWith(partial)) items.push(item(kw, 'kw', 'keyword'));
                }
                items.forEach(i => { i.range = range(partial.length); });
                return items.slice(0, 2000);
            }
        } catch (err) {
            return null;
        }

        // nothing typed: keywords on an explicit request
        if (explicit) return KEYWORDS.map(kw => item(kw, 'kw', 'keyword'));
        return null;
    }
}

// the word at an offset, for hover docs
function wordAt(text, offs) {
    const isWord = (c) => c && /[\w:.$#]/.test(c);
    if (!isWord(text[offs])) return null;
    let start = offs;
    let end = offs;
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length && isWord(text[end])) end++;
    return {start, end, word: text.slice(start, end)};
}

function hoverMd(title, detail, doc) {
    const md = new vscode.MarkdownString();
    md.appendCodeblock(title + (detail ? `  ${detail}` : ''), LANG);
    if (doc) md.appendMarkdown(doc);
    return md;
}

class Hover {

    constructor(server) {
        this.server = server;
    }

    async provideHover(doc, pos) {
        const text = doc.getText();
        const offs = doc.offsetAt(pos);
        if (inStringOrComment(text, offs)) return null;
        const at = wordAt(text, offs);
        if (!at) return null;
        const range = new vscode.Range(doc.positionAt(at.start), doc.positionAt(at.end));
        const word = at.word.replace(/[.:]+$/, '');

        try {
            if (word.startsWith('$lib')) {
                const docs = await this.server.docs();
                // the path up to the hovered segment
                let end = word.indexOf('.', offs - at.start);
                if (end === -1) end = word.length;
                const lpath = word.slice(0, end);
                const lib = docs.libMap.get(lpath);
                if (lib) return new vscode.Hover(hoverMd(lpath, 'library', lib.doc), range);
                const dot = lpath.lastIndexOf('.');
                const mem = docs.libMap.get(lpath.slice(0, dot))?.members.find(x => x.name === lpath.slice(dot + 1));
                return mem ? new vscode.Hover(hoverMd(mem.sig ? `${lpath.slice(0, dot)}.${mem.sig}` : lpath, mem.sig ? '' : mem.type, mem.doc), range) : null;
            }

            // a command (the word right after a pipe)
            if (/\|\s*$/.test(text.slice(0, at.start))) {
                const docs = await this.server.docs();
                const cmd = docs.commands.find(c => c.name === word);
                return cmd ? new vscode.Hover(hoverMd(cmd.name, cmd.pkg ? `command from ${cmd.pkg}` : 'command', cmd.doc), range) : null;
            }

            if (word.startsWith('.')) {
                const univ = UNIVERSAL.find(([n]) => n === word);
                return univ ? new vscode.Hover(hoverMd(univ[0], 'universal prop', univ[1]), range) : null;
            }

            const model = await this.server.model();
            if (word.startsWith(':')) {
                const name = word.slice(1);
                for (const form of formsIn(model, text)) {
                    const pdef = model.forms[form].props.find(p => p.name === name);
                    if (pdef) return new vscode.Hover(hoverMd(`${form}:${name}`, typeName(pdef.type), pdef.doc), range);
                }
                return null;
            }

            if (model.forms[word]) return new vscode.Hover(hoverMd(word, 'form', model.forms[word].doc), range);
            const form = longestForm(model, word);
            if (form) {
                const pdef = model.forms[form].props.find(p => p.name === word.slice(form.length + 1));
                if (pdef) return new vscode.Hover(hoverMd(word, typeName(pdef.type), pdef.doc), range);
            }
        } catch (err) {
            return null;
        }
        return null;
    }
}

// ---------------------------------------------------------------------- activation

function activate(context) {
    const output = vscode.window.createOutputChannel('Storm');
    const server = new Server(context, output);
    const linter = new Linter(server);

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'storm.menu';
    server.onState.event((s) => {
        if (s.state === 'starting') {
            status.text = '$(sync~spin) Storm';
            status.tooltip = `Starting the Storm language server (${s.remote ? 'Cortex' : 'temporary Cortex'})`;
        } else if (s.state === 'ready') {
            status.text = s.cortex === 'remote' ? '$(database) Storm: Cortex' : '$(check) Storm';
            status.tooltip = `Storm language server ready: Synapse ${s.synapse}, ${s.cortex === 'remote' ? 'connected to a Cortex' : 'temporary Cortex (core model)'}`;
            linter.lintAll();
        } else if (s.state === 'error') {
            status.text = '$(error) Storm';
            status.tooltip = s.mesg;
        }
        status.show();
    });

    const start = () => server.start().catch(async (err) => {
        const pick = await vscode.window.showErrorMessage(
            `Storm: the language server did not start (${err.message}). It needs a Python with synapse installed.`,
            'Set Python Path', 'Show Output');
        if (pick === 'Set Python Path') vscode.commands.executeCommand('workbench.action.openSettings', 'storm.pythonPath');
        if (pick === 'Show Output') output.show();
    });

    const selector = [{language: LANG}];
    context.subscriptions.push(
        output, status, linter.collection,
        {dispose: () => server.stop()},
        vscode.languages.registerCompletionItemProvider(selector, new Completion(server), ':', '.', '#', '|', '$'),
        vscode.languages.registerHoverProvider(selector, new Hover(server)),
        vscode.workspace.onDidOpenTextDocument((doc) => linter.schedule(doc, 0)),
        vscode.workspace.onDidChangeTextDocument((e) => linter.schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => linter.forget(doc)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('storm.pythonPath')) server.restart().catch(() => {});
            else if (e.affectsConfiguration('storm.lint')) linter.lintAll();
        }),
        vscode.commands.registerCommand('storm.restartServer', () => { server.stop(); return start(); }),
        vscode.commands.registerCommand('storm.showOutput', () => output.show()),
        vscode.commands.registerCommand('storm.connectCortex', async () => {
            const url = await vscode.window.showInputBox({
                title: 'Connect to a Cortex',
                prompt: 'A telepath URL, e.g. aha://cortex... or ssl://user@host:27492. It is kept in VS Code secret storage.',
                placeHolder: 'aha://cortex...',
                password: false,
                ignoreFocusOut: true,
            });
            if (!url) return;
            await context.secrets.store(SECRET_CORTEX, url.trim());
            server.stop();
            return start();
        }),
        vscode.commands.registerCommand('storm.useTempCortex', async () => {
            await context.secrets.delete(SECRET_CORTEX);
            server.stop();
            return start();
        }),
        vscode.commands.registerCommand('storm.menu', async () => {
            const remote = !!(await context.secrets.get(SECRET_CORTEX));
            const picks = [
                {label: '$(plug) Connect to Cortex...', command: 'storm.connectCortex'},
                remote ? {label: '$(beaker) Use a temporary Cortex (core model only)', command: 'storm.useTempCortex'} : null,
                {label: '$(refresh) Restart language server', command: 'storm.restartServer'},
                {label: '$(output) Show output', command: 'storm.showOutput'},
            ].filter(Boolean);
            const pick = await vscode.window.showQuickPick(picks, {title: status.tooltip});
            if (pick) vscode.commands.executeCommand(pick.command);
        }),
    );

    start();
}

function deactivate() {}

module.exports = {activate, deactivate};
