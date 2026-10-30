// Grammar tests: tokenize Storm with VS Code's own TextMate engine and check the scopes.
//
//     ./test/node test/grammar.test.js
//
// vscode-textmate and vscode-oniguruma come from the installed VS Code (VSCODE_APP to override), so there
// is nothing to npm install. Without VS Code (in CI) they come from node_modules:
// npm install --no-save vscode-textmate vscode-oniguruma

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const app = process.env.VSCODE_APP || '/Applications/Visual Studio Code.app/Contents/Resources/app';
// the bundled copies are in an asar archive, which only Electron (VS Code's Node.js) can read
const bundled = !!process.versions.electron && fs.existsSync(path.join(app, 'node_modules.asar'));
const tm = require(bundled ? path.join(app, 'node_modules.asar', 'vscode-textmate') : 'vscode-textmate');
const onig = require(bundled ? path.join(app, 'node_modules.asar', 'vscode-oniguruma') : 'vscode-oniguruma');
const wasmPath = bundled
    ? path.join(app, 'node_modules.asar.unpacked', 'vscode-oniguruma', 'release', 'onig.wasm')
    : require.resolve('vscode-oniguruma/release/onig.wasm');

const root = path.join(__dirname, '..');
const grammarPath = path.join(root, 'syntaxes', 'storm.tmLanguage.json');

async function loadGrammar() {
    const wasm = fs.readFileSync(wasmPath).buffer;
    await onig.loadWASM(wasm);
    const registry = new tm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (s) => new onig.OnigScanner(s),
            createOnigString: (s) => new onig.OnigString(s),
        }),
        loadGrammar: async (scope) => scope === 'source.storm'
            ? tm.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath) : null,
    });
    return registry.loadGrammar('source.storm');
}

// [{text, scopes}] for every token of every line
function tokenize(grammar, text) {
    const out = [];
    let stack = tm.INITIAL;
    for (const line of text.split('\n')) {
        const res = grammar.tokenizeLine(line, stack);
        for (const t of res.tokens) out.push({text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes});
        stack = res.ruleStack;
    }
    return out;
}

// the innermost scope of the first token with this exact text (after skip earlier ones)
function scopeOf(tokens, text, skip = 0) {
    const found = tokens.filter(t => t.text === text);
    if (found.length <= skip) throw new Error(`no token ${JSON.stringify(text)} in ${JSON.stringify(tokens.map(t => t.text))}`);
    return found[skip].scopes.slice(1);
}

const cases = [
    // [query, token, expected scope (prefix of the innermost scope), nth occurrence]
    ['inet:fqdn=vertex.link', 'inet:fqdn', 'entity.name.type.form'],
    ['inet:fqdn:zone=vertex.link', 'inet:fqdn:zone', 'entity.name.type.form'],
    ['inet:fqdn.seen', '.seen', 'variable.other.property.universal'],
    ['inet:*', 'inet:*', 'entity.name.type.form'],
    ['inet:fqdn +:zone=foo', 'zone', 'variable.other.property'],
    ['inet:fqdn +:zone=foo', '+', 'keyword.operator.filter'],
    ['inet:dns:a :fqdn -> inet:fqdn', '->', 'keyword.operator.pivot'],
    ['inet:fqdn <- *', '<-', 'keyword.operator.pivot'],
    ['inet:fqdn -+> *', '-+>', 'keyword.operator.pivot'],
    ['inet:fqdn -(refs)> *', 'refs', 'entity.name.label.verb'],
    ['inet:fqdn <(seen)- *', 'seen', 'entity.name.label.verb'],
    ['inet:fqdn [ +(refs)> { inet:ipv4=1.2.3.4 } ]', 'refs', 'entity.name.label.verb'],
    ['#cno.mal.c2', 'cno.mal.c2', 'entity.name.tag'],
    ['#cno.mal:score>10', 'score', 'variable.other.property.tagprop'],
    ['inet:fqdn [ +#rep.foo -#rep.bar ]', 'rep.foo', 'entity.name.tag'],
    ['inet:fqdn | limit 10', 'limit', 'support.function.command'],
    ['inet:fqdn |\n    uniq', 'uniq', 'support.function.command'],
    ['inet:fqdn | max :asn', 'max', 'support.function.command'],
    ['inet:fqdn | tee --join { -> * }', '--join', 'variable.parameter.option'],
    ['inet:fqdn | -inet:fqdn:zone', 'inet:fqdn:zone', 'entity.name.type.form'],
    ['$x = $lib.str.join(",", $y)', '$lib', 'support.class.lib'],
    ['$x = $lib.str.join(",", $y)', 'join', 'support.function.lib'],
    ['$x = $lib.str.join(",", $y)', 'x', 'variable.other'],
    ['$x.append($y)', 'append', 'entity.name.function.member'],
    ['$node.value()', '$node', 'variable.language'],
    ['function foo(x) { return($x) }', 'foo', 'entity.name.function'],
    ['function foo(x) { return($x) }', 'function', 'storage.type.function'],
    ['function foo(x) { return($x) }', 'return', 'keyword.control'],
    ['if ($x and not $y) { $lib.print(yes) }', 'and', 'keyword.operator.word'],
    ['for $x in $y { }', 'for', 'keyword.control'],
    ['init { $x = 0 } fini { }', 'init', 'keyword.control.block'],
    ['$x = (true)', 'true', 'constant.language'],
    ['$x = 0x10', '0x10', 'constant.numeric.hex'],
    ['$x = 3.14', '3.14', 'constant.numeric.decimal'],
    ['inet:ipv4 +:asn*range=(1, 10)', '*range=', 'keyword.operator.comparison'],
    ['inet:fqdn ~= vert', '~=', 'keyword.operator.comparison'],
    ['// comment | limit 10', '// comment | limit 10', 'comment.line'],
    ['/* multi\nline */ inet:fqdn', 'line ', 'comment.block'],
    ['$x = "a \\n b"', '\\n', 'constant.character.escape'],
    ["$x = 'raw | limit'", 'raw | limit', 'string.quoted.single'],
    ["$x = '''multi\nline | limit 3'''", 'line | limit 3', 'string.quoted.triple'],
    ['$x = `hi {$name.upper()}`', 'name', 'variable.other'],
    ['$x = `hi {$name.upper()}`', 'upper', 'entity.name.function.member'],
    ['$x = `hi {$name.upper()}`', 'hi ', 'string.interpolated'],
    ['inet:fqdn | if $x { | limit 1 }', 'limit', 'support.function.command'],
    ['$x = $foo(1)', 'foo', 'entity.name.function'],
];

// tokens which must NOT get a scope
const negatives = [
    // a keyword inside a form name
    ['inet:if:host', 'if'],
    // not a command: a string after a pipe
    ['inet:fqdn | "limit"', 'limit'],
];

(async () => {
    const grammar = await loadGrammar();
    let failed = 0;
    for (const [query, token, scope, nth = 0] of cases) {
        const tokens = tokenize(grammar, query);
        try {
            const scopes = scopeOf(tokens, token, nth);
            assert(scopes.some(s => s.startsWith(scope)), `${JSON.stringify(token)} in ${JSON.stringify(query)}: got ${scopes.join(' ')}, wanted ${scope}`);
        } catch (e) {
            failed++;
            console.log('FAIL', e.message);
        }
    }
    for (const [query, token] of negatives) {
        const tokens = tokenize(grammar, query);
        const hit = tokens.find(t => t.text === token && t.scopes.some(s => s.startsWith('keyword') || s.startsWith('support.function')));
        if (hit) { failed++; console.log('FAIL', `${token} in ${query} should not be scoped: ${hit.scopes.join(' ')}`); }
    }
    const total = cases.length + negatives.length;
    console.log(`${total - failed}/${total} grammar tests passed`);
    process.exit(failed ? 1 : 0);
})();
