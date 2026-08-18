// Root entry used when Render Start Command is `node server.js` with
// rootDir = repository root. This file MUST only boot the API server.
// It must never serve frontend/dist (that path does not exist on Render).
require("./server/server.js");
