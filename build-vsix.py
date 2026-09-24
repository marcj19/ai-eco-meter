"""Gera o pacote .vsix da extensão sem depender do vsce/npm."""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

pkg = json.load(open('package.json', encoding='utf8'))
files = ['package.json', 'extension.js', 'README.md', 'LICENSE']
for folder in ('src', 'media'):
    files += [f'{folder}/{f}' for f in sorted(os.listdir(folder))]

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}" />
    <DisplayName>{pkg['displayName']}</DisplayName>
    <Description xml:space="preserve">{pkg['description']}</Description>
    <Tags>{','.join(pkg['keywords'])}</Tags>
    <Categories>{','.join(pkg['categories'])}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{','.join(pkg.get('extensionKind', ['workspace']))}" />
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>'''

types = {'.json': 'application/json', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
         '.md': 'text/markdown', '.vsixmanifest': 'text/xml', '': 'text/plain'}
content_types = ('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 + ''.join(f'<Default Extension="{e}" ContentType="{t}"/>' for e, t in types.items()) + '</Types>')

out = f"{pkg['name']}-{pkg['version']}.vsix"
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('extension.vsixmanifest', manifest)
    for f in files:
        z.write(f, 'extension/' + f)
print(f'{out} ({os.path.getsize(out) // 1024} KB, {len(files)} arquivos)')
