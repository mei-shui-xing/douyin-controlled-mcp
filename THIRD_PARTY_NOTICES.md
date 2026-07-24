# Third-party notices

The release source uses the versions locked in `package-lock.json`. Their licenses apply to those components; the project's own code is licensed separately under MIT.

| Component | Use | License | Upstream |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.29.0 | MCP server and transports | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `express` 5.2.1 | Local HTTP transport | MIT | https://github.com/expressjs/express |
| `playwright-core` 1.61.1 | Chrome/Edge CDP browser control | Apache-2.0 | https://github.com/microsoft/playwright |
| `zod` 4.4.3 | Tool and configuration validation | MIT | https://github.com/colinhacks/zod |
| `typescript` 5.9.3 | Development compiler; not bundled at runtime | Apache-2.0 | https://github.com/microsoft/TypeScript |

Transitive npm packages and their locked versions remain listed in `package-lock.json`. A redistributor that bundles `node_modules` must also retain the license files shipped by every dependency. The Alpha source package does not bundle `node_modules`.

Optional external tools are downloaded or installed by the owner and are not redistributed in the source package:

| Component | Use | License / note | Upstream |
| --- | --- | --- | --- |
| `cloudflared` | Optional connector tunnel | Apache-2.0 | https://github.com/cloudflare/cloudflared |
| `faster-whisper` 1.2.1 | Optional local transcription | MIT | https://github.com/SYSTRAN/faster-whisper |
| CTranslate2 | `faster-whisper` runtime dependency | MIT | https://github.com/OpenNMT/CTranslate2 |
| FFmpeg libraries (through Python media packages) | Optional media decoding | License depends on the exact build and enabled codecs; verify before redistributing binaries | https://ffmpeg.org/legal.html |

No EchoLens or other third-party transcription service is an active dependency. Historical EchoLens documents are archived locally and excluded from the Alpha source package.

