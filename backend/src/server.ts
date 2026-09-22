import { createApp } from './app.js';

const port = Number(process.env.PORT || 4000);

void (async () => {
  const app = await createApp();
  app.listen(port, () => {
    console.log(`Gift list API listening on http://localhost:${port}`);
  });
})();
