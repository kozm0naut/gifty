import { createApp } from './app.js';
import { validateConfig } from './config/index.js';

// Fail fast on startup if required config (e.g. JWT_SECRET in production) is
// missing — never serve with a known/default secret (Constitution §IV, FR-006).
validateConfig();

const port = Number(process.env.PORT || 4000);

void (async () => {
  const app = await createApp();
  app.listen(port, () => {
    console.log(`Gift list API listening on http://localhost:${port}`);
  });
})();
