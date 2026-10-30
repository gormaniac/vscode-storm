'''
Build a .vsix for local installs without vsce (or node): a .vsix is a zip of the extension plus a
manifest. Releases are built and published by vsce in CI (.github/workflows/release.yml).

    python3 scripts/package.py          # writes vscode-storm-<version>.vsix
    code --install-extension vscode-storm-<version>.vsix
'''
import os
import json
import fnmatch
import zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MANIFEST = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}"/>
    <DisplayName>{displayName}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>{categories}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".py" ContentType="text/plain"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'''

def ignored(rel, patterns):
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p.rstrip('*').rstrip('/') + '/*') for p in patterns)

def main():
    with open(os.path.join(root, 'package.json')) as fd:
        pkg = json.load(fd)
    with open(os.path.join(root, '.vscodeignore')) as fd:
        patterns = [line.strip() for line in fd if line.strip() and not line.startswith('#')]
    patterns += ['.git/*', '.vscodeignore', '*.vsix', '.DS_Store']

    out = os.path.join(root, f'{pkg["name"]}-{pkg["version"]}.vsix')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', CONTENT_TYPES)
        zf.writestr('extension.vsixmanifest', MANIFEST.format(
            **{**pkg, 'categories': ','.join(pkg.get('categories', ())), 'engine': pkg['engines']['vscode']}))
        for dirn, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not ignored(os.path.relpath(os.path.join(dirn, d), root) + '/', patterns)]
            for name in sorted(files):
                rel = os.path.relpath(os.path.join(dirn, name), root)
                if not ignored(rel, patterns):
                    zf.write(os.path.join(dirn, name), f'extension/{rel}')
    print(out)

if __name__ == '__main__':
    main()
