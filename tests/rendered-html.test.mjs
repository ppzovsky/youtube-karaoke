import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

test("renderiza a experiência inicial completa em pt-BR", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="pt-BR">/i);
  assert.match(html, /Karaoke Arcade — Sua voz, seu palco/i);
  assert.match(html, /SUA VOZ\.<br\/><em>SEU PALCO\.<\/em>/i);
  assert.match(html, /id="singer"/i);
  assert.match(html, /id="song"/i);
  assert.match(html, /LEADERBOARD/i);
  assert.match(html, /nunca é gravado ou enviado/i);
  assert.match(html, /property="og:image" content="http:\/\/localhost(?::3000)?\/og\.png"/i);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});

test("valida a busca antes de acessar o YouTube e protege configuração ausente", async () => {
  const worker = await loadWorker();
  const shortResponse = await worker.fetch(new Request("http://localhost/api/youtube/search?q=a"), env, context);
  assert.equal(shortResponse.status, 400);
  assert.match((await shortResponse.json()).error, /dois caracteres/i);

  const unconfiguredResponse = await worker.fetch(new Request("http://localhost/api/youtube/search?q=evidencias"), env, context);
  assert.equal(unconfiguredResponse.status, 503);
  assert.match((await unconfiguredResponse.json()).error, /não foi configurada/i);
});
