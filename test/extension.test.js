// Extension tests without VS Code: a small stand-in for the vscode module drives the real
// providers against the real language server.
//
//     STORM_PYTHON=/path/to/python ./test/node test/extension.test.js
//
// STORM_PYTHON must have synapse installed (default: python3).

const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ------------------------------------------------------------------ a stand-in vscode module

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class EventEmitter {
    constructor() { this.handlers = []; this.event = (fn) => { this.handlers.push(fn); return {dispose() {}}; }; }
    fire(e) { this.handlers.forEach(fn => fn(e)); }
}
class Doc {
    constructor(text, uri = 'untitled:test.storm') {
        this.text = text; this.version = 1; this.languageId = 'storm'; this.isClosed = false;
        this.uri = {toString: () => uri};
    }
    getText() { return this.text; }
    offsetAt(pos) {
        const lines = this.text.split('\n');
        let offs = 0;
        for (let i = 0; i < pos.line; i++) offs += lines[i].length + 1;
        return offs + pos.character;
    }
    positionAt(offs) {
        const before = this.text.slice(0, offs);
        const line = before.split('\n').length - 1;
        return new Position(line, offs - (before.lastIndexOf('\n') + 1));
    }
}

const commands = {};
const handlers = {};
const providers = {};
const diagnostics = new Map();
const warnings = [];
const config = {pythonPath: process.env.STORM_PYTHON || 'python3', 'lint.enabled': true, 'lint.delay': 0};

const vscode = {
    Position, Range, EventEmitter,
    DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2},
    CompletionItemKind: {Class: 6, Property: 9, Function: 2, Module: 8, Method: 1, Constant: 20, Keyword: 13},
    CompletionTriggerKind: {Invoke: 0, TriggerCharacter: 1},
    StatusBarAlignment: {Right: 2},
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionList: class { constructor(items, incomplete) { this.items = items; this.isIncomplete = incomplete; } },
    MarkdownString: class {
        constructor(v = '') { this.value = v; }
        appendCodeblock(code) { this.value += '```\n' + code + '\n```\n'; return this; }
        appendMarkdown(md) { this.value += md; return this; }
    },
    SnippetString: class { constructor(v) { this.value = v; } },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    languages: {
        createDiagnosticCollection: () => ({
            set: (uri, diags) => diagnostics.set(uri.toString(), diags),
            delete: (uri) => diagnostics.delete(uri.toString()),
            dispose() {},
        }),
        registerCompletionItemProvider: (sel, p) => { providers.completion = p; return {dispose() {}}; },
        registerHoverProvider: (sel, p) => { providers.hover = p; return {dispose() {}}; },
    },
    workspace: {
        textDocuments: [],
        getConfiguration: () => ({get: (k) => config[k]}),
        onDidOpenTextDocument: (fn) => { handlers.open = fn; return {dispose() {}}; },
        onDidChangeTextDocument: (fn) => { handlers.change = fn; return {dispose() {}}; },
        onDidCloseTextDocument: (fn) => { handlers.close = fn; return {dispose() {}}; },
        onDidChangeConfiguration: () => ({dispose() {}}),
    },
    window: {
        createOutputChannel: () => ({append: (s) => process.env.DEBUG && process.stderr.write(s), appendLine: (s) => process.env.DEBUG && console.error(s), show() {}, dispose() {}}),
        createStatusBarItem: () => ({show() {}, dispose() {}}),
        showErrorMessage: async (m) => { console.error('showErrorMessage:', m); },
        showWarningMessage: async (m) => { warnings.push(m); },
    },
    commands: {
        registerCommand: (name, fn) => { commands[name] = fn; return {dispose() {}}; },
        executeCommand: () => {},
    },
};

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache.vscode = {id: 'vscode', filename: 'vscode', loaded: true, exports: vscode};

// ------------------------------------------------------------------ helpers

const secrets = new Map();
const context = {
    extensionPath: path.join(__dirname, '..'),
    subscriptions: [],
    secrets: {get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k)},
};

// text with ‸ marking the cursor
function at(marked) {
    const offs = marked.indexOf('‸');
    const doc = new Doc(marked.replace('‸', ''));
    return {doc, pos: doc.positionAt(offs)};
}

async function complete(marked, explicit = false) {
    const {doc, pos} = at(marked);
    const res = await providers.completion.provideCompletionItems(doc, pos, null, {triggerKind: explicit ? 0 : 1});
    return (res?.items || res || []).map(i => i.label);
}

async function hover(marked) {
    const {doc, pos} = at(marked);
    const res = await providers.hover.provideHover(doc, pos);
    return res?.contents.value || null;
}

async function lint(text) {
    const doc = new Doc(text, `untitled:${Math.random()}`);
    handlers.open(doc);
    for (let i = 0; i < 100 && !diagnostics.has(doc.uri.toString()); i++) await new Promise(r => setTimeout(r, 20));
    return diagnostics.get(doc.uri.toString()) || [];
}

// ------------------------------------------------------------------ tests

const tests = {
    async 'lint finds unknown forms, commands, props and syntax errors'() {
        const diags = await lint('inet:fqdnx=foo | limitt 10');
        assert.deepStrictEqual(diags.map(d => d.code), ['N001 unknown-form', 'N003 unknown-command']);
        assert.strictEqual(diags[0].range.start.character, 0);
        assert.strictEqual(diags[0].range.end.character, 10);
        assert.strictEqual(diags[1].range.start.character, 17);

        const syn = await lint('inet:fqdn\n| $x = (1 +');
        assert.strictEqual(syn.length, 1);
        assert.strictEqual(syn[0].code, 'E001 parse-failure');
        assert.strictEqual(syn[0].severity, 0);

        const prop = await lint('inet:fqdn +:zonee=foo');
        assert.strictEqual(prop[0].code, 'N002 unknown-prop');

        assert.deepStrictEqual(await lint('inet:fqdn=vertex.link -> inet:dns:a | limit 10'), []);
    },

    async 'lint ranges count UTF-16 like VS Code'() {
        const diags = await lint('$x = "🙂🙂" inet:fqdnx');
        const start = diags[0].range.start.character;
        assert.strictEqual('$x = "🙂🙂" inet:fqdnx'.slice(start), 'inet:fqdnx');
    },

    async 'completes forms and full props'() {
        assert(await complete('inet:fq‸').then(l => l.includes('inet:fqdn')));
        const props = await complete('inet:fqdn:‸');
        assert(props.includes('inet:fqdn:zone'), props.slice(0, 5));
    },

    async 'completes relative props of the forms in the query'() {
        const items = await complete('inet:fqdn +:‸');
        assert(items.includes(':zone') && items.includes(':issuffix'), items);
        assert(!items.includes(':asn'));
    },

    async 'completes commands after a pipe, even on the next line'() {
        assert((await complete('inet:fqdn | lim‸')).includes('limit'));
        assert((await complete('inet:fqdn |\n    ‸')).includes('uniq'));
    },

    async 'completes $lib libraries and members'() {
        const libs = await complete('$lib.‸');
        assert(libs.includes('str') && libs.includes('print'), libs.slice(0, 10));
        assert((await complete('$lib.str.‸')).includes('join'));
    },

    async 'completes keywords and nothing inside strings'() {
        assert((await complete('fo‸', true)).includes('for'));
        assert.deepStrictEqual(await complete('$x = "inet:fq‸'), []);
    },

    async 'hover shows docs'() {
        assert.match(await hover('inet:fq‸dn=foo'), /inet:fqdn\s+form/);
        assert.match(await hover('meta:no‸te=*'), /An analyst note/);
        assert.match(await hover('inet:fqdn +:zo‸ne=foo'), /inet:fqdn:zone/);
        assert.match(await hover('inet:fqdn | lim‸it 10'), /limit\s+command/);
        assert.match(await hover('$lib.str.jo‸in(",", $x)'), /join\(/);
        assert.strictEqual(await hover('$x = "inet:fq‸dn"'), null);
    },

    // these restart the server, so they run last
    async 'says when the Python has no synapse, or does not run'() {
        const saved = config.pythonPath;
        try {
            warnings.length = 0;
            config.pythonPath = '/usr/bin/python3';
            await commands['storm.restartServer']();
            assert.match(warnings.join('\n'), /does not have synapse installed/);

            warnings.length = 0;
            config.pythonPath = '/nonexistent/python';
            await commands['storm.restartServer']();
            assert.match(warnings.join('\n'), /Could not run \/nonexistent\/python/);
        } finally {
            config.pythonPath = saved;
        }
    },

    async 'expands ~ in storm.pythonPath'() {
        const saved = config.pythonPath;
        const home = os.homedir();
        if (!saved.startsWith(home + path.sep)) return;
        try {
            config.pythonPath = '~' + saved.slice(home.length);
            warnings.length = 0;
            await commands['storm.restartServer']();
            assert.deepStrictEqual(warnings, []);
            assert((await complete('inet:fq‸')).includes('inet:fqdn'));
        } finally {
            config.pythonPath = saved;
        }
    },
};

(async () => {
    require('../extension.js').activate(context);
    const server = await new Promise((resolve) => {
        const t0 = Date.now();
        const wait = setInterval(() => {
            if (Date.now() - t0 > 30000) { console.error('the server did not start'); process.exit(1); }
        }, 500);
        // the providers wait for the server; the first request starts things off
        providers.completion.server.ready.then((info) => { clearInterval(wait); resolve(info); },
            (err) => { console.error(err.message); process.exit(1); });
    });
    console.log(`server ready: synapse ${server.synapse}, ${server.cortex} cortex`);

    let failed = 0;
    for (const [name, fn] of Object.entries(tests)) {
        try {
            await fn();
            console.log('ok  ', name);
        } catch (e) {
            failed++;
            console.log('FAIL', name, '\n    ', e.message);
        }
    }
    context.subscriptions.forEach(s => s.dispose && s.dispose());
    console.log(`${Object.keys(tests).length - failed}/${Object.keys(tests).length} extension tests passed`);
    process.exit(failed ? 1 : 0);
})();
