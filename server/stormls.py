'''
A small Storm language server for the VS Code extension.

    python stormls.py [--cortex aha://cortex...]

It speaks JSON lines on stdin and stdout. Each request is {"id": 1, "op": "...", ...} and each
reply is {"id": 1, "result": ...} or {"id": 1, "error": {"code": ..., "mesg": ...}}. Once it is
ready it writes {"event": "ready", ...}.

    lint   {"text": "..."}    Findings for Storm text.
    docs   {}                 Storm commands and $lib libraries, with docs and signatures.
    model  {}                 A compact data model: forms (with props), types, edges, tagprops.
    tags   {"prefix": "cno"}  Up to 25 tags which start with the prefix.

Without --cortex it starts a temporary Cortex in this process (no network, nothing kept) and
checks against the Synapse core model and built-in commands. With --cortex it checks against a
real Cortex (its extended model, installed packages and tags), over telepath, and refreshes its
copy of that metadata every 60s. Queries are never run.

Two sets of lint rules run:

* Synapse's StormLinter (synapse.lib.stormlint): syntax errors (E001), invalid escapes, duplicate
  functions and its default style and performance rules.
* Storm rules (N...), which check the query against the Cortex metadata:

    N001  unknown-form      A form or full prop name which is not in the data model.
    N002  unknown-prop      A relative prop which is not a prop of the (statically known) form.
    N003  unknown-command   A command which is not installed in the Cortex.
    N004  command-args      Command arguments which the command's parser rejects (constant args only).
    N005  unknown-lib       A $lib library or member which the Cortex does not have.
    N006  undefined-var     A variable which is never assigned in the query.

The N rules are adapted from the NeuralUI service's linter.
'''
import re
import sys
import json
import time
import types
import asyncio
import logging
import pkgutil
import argparse
import warnings
import importlib

import synapse.exc as s_exc
import synapse.cortex as s_cortex
import synapse.telepath as s_telepath

import synapse.lib.ast as s_ast
import synapse.lib.storm as s_storm
import synapse.lib.parser as s_parser
import synapse.lib.version as s_version
import synapse.lib.stormlint as s_stormlint
import synapse.lib.stormlib as s_stormlib

logger = logging.getLogger('stormls')

META_TTL = 60.0
MAX_TEXT = 100_000

SEVERITY = {'high': 'error', 'medium': 'warning', 'low': 'info'}

RULES = {
    'N001': ('unknown-form', 'error'),
    'N002': ('unknown-prop', 'error'),
    'N003': ('unknown-command', 'error'),
    'N004': ('command-args', 'error'),
    'N005': ('unknown-lib', 'error'),
    'N006': ('undefined-var', 'warning'),
}

# libraries whose members are names chosen by the user ($lib.vars.foo)
DYNAMIC_LIBS = {('lib', 'vars'), ('lib', 'globals'), ('lib', 'env')}

# variables the runtime provides
BUILTIN_VARS = {'lib', 'node', 'path', 'auto'}

wordre = re.compile(r'[\w:.$#*\-]+')

TAGS_QUERY = '''
    $retn = ()
    if $prefix { syn:tag^=$prefix } else { syn:tag:depth=0 }
    | limit 25 |
    $retn.append($node.value())
    fini { return($retn) }
'''

def _cmdClasses():
    '''
    Every built-in Python Storm command class, by name.
    '''
    for mod in pkgutil.iter_modules(s_stormlib.__path__):
        try:
            importlib.import_module(f'synapse.lib.stormlib.{mod.name}')
        except Exception:  # pragma: no cover
            pass

    def subclasses(cls):
        for sub in cls.__subclasses__():
            yield sub
            yield from subclasses(sub)

    cmds = {}
    for cls in subclasses(s_storm.Cmd):
        name = cls.__dict__.get('name')
        if isinstance(name, str) and cls is not s_storm.PureCmd:
            cmds[name] = cls
    return cmds

class _Snap:
    def printf(self, *args, **kwargs):
        pass

# the minimal runtime a command needs to build its argument parser
_runt = types.SimpleNamespace(model=None, snap=_Snap())

def _brief(text):
    '''
    The first paragraph of a docstring, on one line.
    '''
    text = (text or '').strip()
    para = text.split('\n\n')[0]
    return ' '.join(para.split())

def _signature(name, tdef):
    if not isinstance(tdef, dict) or tdef.get('type') != 'function':
        return None
    args = []
    for arg in tdef.get('args', ()):
        text = arg.get('name', '')
        if 'default' in arg:
            text += f'={arg["default"]!r}'.replace("'", '"')
        args.append(text)
    retn = (tdef.get('returns') or {}).get('type')
    if isinstance(retn, (list, tuple)):
        retn = ' | '.join(str(r) for r in retn)
    sig = f'{name}({", ".join(args)})'
    return f'{sig} -> {retn}' if retn else sig

def compactDocs(docs):
    '''
    The parts of the Cortex Storm docs the editor completes and shows on hover.
    '''
    cmds = [{'name': c['name'], 'doc': _brief(c.get('doc')), 'pkg': c.get('package')}
            for c in docs.get('commands', ())]

    libs = []
    for ldef in docs.get('libraries', ()):
        if ldef.get('deprecated'):
            continue
        members = []
        for loc in ldef.get('locals', ()):
            if loc.get('deprecated'):
                continue
            ltype = loc.get('type')
            members.append({
                'name': loc['name'],
                'doc': _brief(loc.get('desc')),
                'sig': _signature(loc['name'], ltype),
                'type': ltype if isinstance(ltype, str) else (ltype or {}).get('type'),
            })
        libs.append({'path': '$' + '.'.join(ldef['path']), 'doc': _brief(ldef.get('desc')), 'members': members})

    return {'commands': sorted(cmds, key=lambda c: c['name']), 'libs': sorted(libs, key=lambda l: l['path'])}

def compactModel(modl):
    '''
    The parts of the data model the editor completes and shows on hover.
    '''
    types = modl.get('types', {})
    forms = {}
    for name, fdef in modl.get('forms', {}).items():
        props = [{'name': pname, 'type': pdef.get('type'), 'doc': pdef.get('doc')}
                 for pname, pdef in fdef.get('props', {}).items()]
        # a form's doc is on its type
        doc = fdef.get('doc') or types.get(name, {}).get('info', {}).get('doc', '')
        forms[name] = {'type': fdef.get('type'), 'doc': doc, 'props': props}

    return {
        'forms': forms,
        'edges': [e[0] for e in modl.get('edges', ())],
        'tagprops': {name: {'type': tdef.get('type'), 'doc': tdef.get('info', {}).get('doc', '')}
                     for name, tdef in modl.get('tagprops', {}).items()},
    }

class Meta:
    '''
    Cortex metadata the rules check against.
    '''
    def __init__(self, modl, docs, pkgdefs, version):
        self.forms, self.props = s_stormlint._getModelNames(modl)
        self.ifaces = frozenset(modl.get('interfaces', {}))
        self.cmds = {c['name'] for c in docs.get('commands', ())}

        self.libs = {}
        for ldef in docs.get('libraries', ()):
            self.libs[tuple(ldef['path'])] = {l['name'] for l in ldef.get('locals', ())}

        # pure (storm) commands from packages carry their argument definitions
        self.cdefs = {}
        for pkgdef in pkgdefs:
            for cdef in pkgdef.get('commands', ()) or ():
                self.cdefs[cdef.get('name')] = cdef

        # the python command classes are only used to check args when the versions match
        self.versionok = version == s_version.version

        self.docs = compactDocs(docs)
        self.model = compactModel(modl)

def lint(text, meta, linter, cmdclasses):
    '''
    Return the findings for Storm text.
    '''
    if not text.strip():
        return []

    if len(text) > MAX_TEXT:
        return [_finding('N000', 'too-large', 'info', text, 0, 0, 'The text is too large to lint.')]

    findings = []
    for f in linter.lint(text):
        rule = s_stormlint.rules.get(f.rule)
        offs = _offset(text, f.line, f.column)
        end = _wordEnd(text, offs)
        findings.append(_finding(f.rule, rule.name if rule else f.rule, SEVERITY.get(f.severity, 'warning'),
                                 text, offs, end, f.mesg, source='synapse'))

    if any(f['rule'] == 'E001' for f in findings):
        return findings

    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            query = s_parser.parseQuery(text)
    except s_exc.BadSyntax:  # pragma: no cover
        return findings

    ctx = s_stormlint.LintContext(text, query, meta.forms, meta.props)
    rules = Rules(ctx, meta, cmdclasses)
    rules.run()
    findings.extend(rules.findings)
    findings.sort(key=lambda f: (f['offs'], f['rule']))
    return findings

def _offset(text, line, column):
    offs = 0
    for _ in range(line - 1):
        nl = text.find('\n', offs)
        if nl == -1:
            break
        offs = nl + 1
    return min(len(text), offs + max(0, column - 1))

def _wordEnd(text, offs):
    match = wordre.match(text, offs)
    if match is not None and match.end() > offs:
        return match.end()
    return min(len(text), offs + 1)

def _finding(rule, name, severity, text, offs, end, mesg, source='stormls'):
    line = text.count('\n', 0, offs) + 1
    column = offs - text.rfind('\n', 0, offs)
    return {'rule': rule, 'name': name, 'severity': severity, 'line': line, 'column': column,
            'offs': offs, 'end': max(end, offs + 1), 'mesg': mesg, 'source': source}

def _span(node):
    info = node.astinfo
    if isinstance(info, s_parser.AstInfo) and info.soff >= 0:
        soff = info.soff
        if soff > 0 and info.text[soff - 1] == '$':
            soff -= 1
        return soff, info.eoff
    return None

class Rules:

    def __init__(self, ctx, meta, cmdclasses):
        self.ctx = ctx
        self.meta = meta
        self.cmdclasses = cmdclasses
        self.findings = []

    def report(self, rule, node, mesg, span=None):
        if span is None:
            span = _span(node)
        if span is None:
            parent = node
            while span is None and parent is not None:
                parent = self.ctx.parent(parent)
                span = _span(parent) if parent is not None else None
        soff, eoff = span or (0, 1)
        name, severity = RULES[rule]
        self.findings.append(_finding(rule, name, severity, self.ctx.text, soff, eoff, mesg))

    def run(self):
        self.forms()
        self.relprops()
        self.commands()
        self.libs()
        self.variables()

    # ---------------------------------------------------------------- model

    def _knownName(self, name):
        if '*' in name or name.startswith('.'):
            return True
        if name in self.meta.props or name in self.meta.ifaces:
            return True
        # a form or prop followed by a universal prop: inet:fqdn.seen
        base, _, univ = name.partition('.')
        return bool(univ) and (base in self.meta.props or base in self.meta.ifaces)

    def forms(self):
        for node in s_stormlint._absNames(self.ctx):
            name = node.valu
            if self._knownName(name):
                continue
            form = s_stormlint._propForm(self.ctx, name)
            if form is None:
                self.report('N001', node, f'Unknown form or property: {name}.')
            else:
                self.report('N001', node, f'{form} has no property {name[len(form):]}.')

    def relprops(self):
        for node, full in s_stormlint._fullRelNames(self.ctx):
            if self._knownName(full):
                continue
            form, _, prop = full.rpartition(':')
            form = s_stormlint._propForm(self.ctx, full) or form
            self.report('N002', node, f'{form} has no property :{full[len(form) + 1:]}.')

    # ---------------------------------------------------------------- commands

    def _argv(self, args):
        '''
        Return the argv of a command if every argument is known before the query runs.
        '''
        argv = []
        for arg in args.kids:
            if isinstance(arg, s_ast.Const):
                argv.append(arg.valu)
            elif isinstance(arg, s_ast.ArgvQuery):
                argv.append(arg.getAstText())
            else:
                return None
        return argv

    def _parser(self, name):
        cdef = self.meta.cdefs.get(name)
        if cdef is not None:
            return s_storm.PureCmd(cdef, _runt, True).pars
        cls = self.cmdclasses.get(name)
        if cls is not None and self.meta.versionok:
            return cls(_runt, True).pars
        return None

    def commands(self):
        for oper in self.ctx.walk(s_ast.CmdOper):
            namenode = oper.kids[0]
            if not isinstance(namenode, s_ast.Const):
                continue
            name = namenode.valu

            if name not in self.meta.cmds:
                self.report('N003', namenode, f'Unknown command: {name}.')
                continue

            argv = self._argv(oper.kids[1])
            if argv is None:
                continue

            try:
                pars = self._parser(name)
                if pars is None:
                    continue
                pars.parse_args(argv)
            except Exception as e:  # pragma: no cover
                logger.debug(f'lint could not check args for {name}: {e}')
                continue

            if pars.exc is not None:
                mesg = pars.exc.get('mesg') if isinstance(pars.exc, s_exc.SynErr) else str(pars.exc)
                self.report('N004', oper, f'{name}: {mesg}')

    # ---------------------------------------------------------------- $lib

    def libs(self):
        libs = self.meta.libs
        if not libs:
            return

        for node in self.ctx.walk(s_ast.VarDeref):
            # only the outermost deref of a chain
            if isinstance(self.ctx.parent(node), s_ast.VarDeref):
                continue

            path = self.ctx.derefPath(node)
            if not path or path[0] != 'lib' or len(path) < 2:
                continue

            # the longest library prefix, then its member
            for i in range(len(path), 0, -1):
                prefix = path[:i]
                if prefix not in libs:
                    continue
                if i == len(path) or prefix in DYNAMIC_LIBS:
                    break
                member = path[i]
                if member in libs[prefix] or path[:i + 1] in libs:
                    break
                lib = '$' + '.'.join(prefix)
                if prefix == ('lib',):
                    self.report('N005', node, f'Unknown library: $lib.{member}.')
                else:
                    self.report('N005', node, f'{lib} has no member {member}.')
                break

    # ---------------------------------------------------------------- variables

    def variables(self):
        assigned = set(BUILTIN_VARS)
        for node in self.ctx.walk():
            kind = type(node)
            if kind is s_ast.SetVarOper:
                assigned.add(node.kids[0].value())
            elif kind is s_ast.VarListSetOper:
                assigned.update(node.kids[0].value())
            elif kind is s_ast.ForLoop:
                names = node.kids[0]
                assigned.update(names.value() if isinstance(names, s_ast.VarList) else [names.value()])
            elif kind is s_ast.Function:
                assigned.add(node.kids[0].value())
                for arg in node.kids[1].kids:
                    assigned.add(arg.kids[0].value() if isinstance(arg, s_ast.CallKwarg) else arg.value())
            elif kind is s_ast.CatchBlock:
                assigned.add(node.errvar())

        seen = set()
        for node in self.ctx.walk(s_ast.VarValue):
            name = node.kids[0]
            if not isinstance(name, s_ast.Const):
                continue
            if name.valu in assigned:
                continue
            span = _span(node)
            if span in seen:
                continue
            seen.add(span)
            self.report('N006', node, f'${name.valu} is never assigned in this query.')

class Server:
    '''
    Answer requests against one Cortex (a temporary one, or a telepath proxy).
    '''
    def __init__(self, core, remote):
        self.core = core
        self.remote = remote
        self.meta = None
        self.metatime = 0
        self.linter = s_stormlint.StormLinter()
        self.cmdclasses = _cmdClasses()

    async def loadMeta(self):
        modl = await self.core.getModelDict()
        info = await self.core.getCoreInfoV2()
        pkgdefs = await self.core.getStormPkgs()
        version = tuple((await self.core.getCellInfo()).get('synapse', {}).get('version', ()))
        self.meta = Meta(modl, info.get('stormdocs', {}), pkgdefs, version)
        self.metatime = time.monotonic()
        return self.meta

    async def getMeta(self):
        # a temporary Cortex never changes; a real one is checked again once a minute
        if self.meta is None or (self.remote and time.monotonic() - self.metatime > META_TTL):
            try:
                await self.loadMeta()
            except Exception:
                if self.meta is None:
                    raise
                logger.warning('Could not refresh the Cortex metadata.', exc_info=True)
                self.metatime = time.monotonic()
        return self.meta

    async def handle(self, req):
        op = req.get('op')
        if op == 'lint':
            text = req.get('text')
            if not isinstance(text, str):
                raise s_exc.BadArg(mesg='The text must be a string.')
            return lint(text, await self.getMeta(), self.linter, self.cmdclasses)
        if op == 'docs':
            return (await self.getMeta()).docs
        if op == 'model':
            return (await self.getMeta()).model
        if op == 'tags':
            prefix = req.get('prefix') or ''
            return await self.core.callStorm(TAGS_QUERY, opts={'vars': {'prefix': prefix}}) or []
        raise s_exc.BadArg(mesg=f'Unknown op: {op}')

def send(mesg):
    sys.stdout.write(json.dumps(mesg) + '\n')
    sys.stdout.flush()

async def serve(server, info):
    await server.getMeta()
    send({'event': 'ready', 'synapse': '.'.join(str(v) for v in s_version.version), **info})

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=4 * MAX_TEXT)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            return
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get('id')
        try:
            send({'id': rid, 'result': await server.handle(req)})
        except Exception as e:
            mesg = e.get('mesg', str(e)) if isinstance(e, s_exc.SynErr) else str(e)
            send({'id': rid, 'error': {'code': e.__class__.__name__, 'mesg': mesg}})

async def main(argv):
    pars = argparse.ArgumentParser(description='A Storm language server (JSON lines on stdio).')
    pars.add_argument('--cortex', help='A telepath URL of a Cortex to check against (default: a temporary Cortex).')
    opts = pars.parse_args(argv)

    if opts.cortex:
        async with await s_telepath.openurl(opts.cortex) as core:
            await serve(Server(core, True), {'cortex': 'remote'})
    else:
        async with s_cortex.getTempCortex() as core:
            await serve(Server(core, False), {'cortex': 'temp'})

if __name__ == '__main__':  # pragma: no cover
    # stdout carries the protocol; everything else goes to stderr
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    try:
        asyncio.run(main(sys.argv[1:]))
    except KeyboardInterrupt:
        pass
