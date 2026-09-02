#!/usr/bin/env python3
"""Pull the app's script block out of index_new.html and append an export
epilogue, so the Node harness can reach bindings that let/const keep in the
script's lexical scope."""
import re, io, sys

html = io.open('index.html', encoding='utf-8').read()
m = re.search(r'<script>\n(.*)\n</script>', html, re.S)
if not m:
    print('no <script> block found in index.html'); sys.exit(1)
src = m.group(1)
io.open('app.js', 'w', encoding='utf-8').write(src)

names = sorted({(mm.group(1) or mm.group(2)) for mm in re.finditer(
    r'^(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)', src, re.M)})
io.open('app_exported.js', 'w', encoding='utf-8').write(
    src + '\n;globalThis.__app = {' + ', '.join(names) + '};\n')
print('extracted %d chars, exported %d bindings' % (len(src), len(names)))
