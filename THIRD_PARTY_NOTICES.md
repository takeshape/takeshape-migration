# Third-party notices

This repo copies or ports files from the projects below. Each entry names the source with its commit or version, where the copies live, and the license, with the license text as the project publishes it.

tsg2astro copies `emdash/tsg2astro/scaffold/` and `emdash/tsg2astro/runtime/` into every project it writes, so the copies there travel with each migrated site.

## EmDash's agent skills

- Source: [github.com/emdash-cms/skills](https://github.com/emdash-cms/skills) at commit 17db933.
- Copies: `emdash/tsg2astro/scaffold/.agents/skills/building-emdash-site/`, `creating-plugins/` and `emdash-cli/`, unchanged. Each folder holds the license below as `LICENSE`, and generated projects get all three folders under `.agents/skills/`.
- License: MIT, Copyright 2026 Cloudflare Inc.

```text
The MIT License

Copyright 2026 Cloudflare Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## EmDash's starter-cloudflare template

- Source: [github.com/emdash-cms/templates](https://github.com/emdash-cms/templates) at commit 1930243, folder `starter-cloudflare/`.
- Copies, in `emdash/tsg2astro/scaffold/` and in generated projects: `tsconfig.json`, `src/worker.ts`, `src/live.config.ts`, `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` unchanged; `astro.config.mjs`, `wrangler.jsonc` and `.gitignore` changed for translated sites. `AGENTS.md` keeps four of the template's section headings (Commands, Skills, Documentation, Rules) and one of its rules.
- License: none stated. The repository has no license file at commit 1930243 or on its main branch, and the template's `package.json` names no license (checked 2026-10-20).

## Nunjucks 3.2.0

- Source: [nunjucks](https://github.com/mozilla/nunjucks) 3.2.0, the version takeshape-ssg ran.
- Ported in `emdash/tsg2astro/runtime/nunjucks.ts`, which generated projects get as `src/lib/takeshape/nunjucks.ts`: the stock filters the translator emits and their helpers, from `src/filters.js`, plus `copySafeness` (`src/runtime.js`), the `in` operator (`src/lib.js`) and `joiner` (`src/globals.js`). The file opens with the license below.
- License: BSD-2-Clause, Copyright (c) 2012-2015, James Long. The text below is the `LICENSE` file of the nunjucks 3.2.0 package.

```text
Copyright (c) 2012-2015, James Long
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## draft-js-export-html

- Source: draft-js-export-html, from [github.com/sstur/draft-js-utils](https://github.com/sstur/draft-js-utils), by way of TakeShape's own fork of it, which TakeShape's rich-text renderer ran.
- Ported in `emdash/tsg2astro/runtime/richtext.ts`, which generated projects get as `src/lib/takeshape/richtext.ts`: the markup generator (blocks in order, lists nested by depth) and its text and attribute encoding. The file opens with the license below.
- License: ISC, Copyright (c) 2016, Simon Sturmer. The text below is the repository's `LICENSE`, unchanged since 2017 (commit 67f0eac).

```text
ISC License

Copyright (c) 2016, Simon Sturmer <sstur@me.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## rehype-minify-whitespace 5.0.0

- Source: rehype-minify-whitespace 5.0.0, from [github.com/rehypejs/rehype-minify](https://github.com/rehypejs/rehype-minify), which TakeShape's MDX renderer ran.
- Copied in `emdash/tsg2astro/runtime/richtext.ts`: its list of block elements (`block.js`). The file opens with the license below too.
- License: MIT, Copyright (c) 2016 Titus Wormer. The text below is the repository's `license` file at the tag `rehype-minify-whitespace@5.0.1`, since the repository has no tag for 5.0.0.

```text
(The MIT License)

Copyright (c) 2016 Titus Wormer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## TakeShape's own repositories

These two are TakeShape's.

- takeshape-starter-books ([github.com/takeshape/takeshape-starter-books](https://github.com/takeshape/takeshape-starter-books) at commit c464c77, branch `trunk`): `tsg.yml`, the templates, `static/` and the sample pattern, in `emdash/test/tsg/sites/shape-books/site/`. Its `package.json` declares `"license": "MIT"` and names TakeShape as author. The repository has no license file at that commit.
- patterns ([github.com/takeshape/patterns](https://github.com/takeshape/patterns)): the seven sample exports in `emdash/test/fixtures/` (`shape-*` and `shopify-lookbook`). The repository has no license file.
