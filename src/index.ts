import { CONFIG } from "./config.js";
import { startHttpServer, startStdioServer } from "./server.js";

const args = new Set(process.argv.slice(2));
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : CONFIG.httpPort;

if (args.has("--stdio")) {
  await startStdioServer();
} else {
  await startHttpServer(Number.isFinite(port) ? port : CONFIG.httpPort);
}
