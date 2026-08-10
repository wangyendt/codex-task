# Third-party notices

## imgen

CodexRun's Direct backend is derived in part from ideas and MIT-licensed code in [`lawrencewzen/imgen`](https://github.com/lawrencewzen/imgen), including Codex OAuth handling, installation identity, TLS impersonation, Codex-like request metadata, image input encoding, and image SSE extraction.

The upstream license at the reviewed revision states:

```text
MIT License

Copyright (c) 2026 aisparkedu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

CodexRun substantially restructures the implementation, adds text and SDK backends, structured task results, Responses Lite encoding, state management, validation, tests, and distribution assets.

## OpenAI Codex SDK

CodexRun depends on `@openai/codex-sdk` for its SDK backend. Codex and OpenAI are trademarks of OpenAI. Use of the dependency does not imply affiliation, endorsement, or sponsorship.
