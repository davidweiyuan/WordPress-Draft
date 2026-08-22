import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = "test-key";

const { translateSourceArticle } = await import("../server.js");

test("falls back to OpenRouter web fetch when an article request is blocked", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (String(url).startsWith("https://openrouter.ai/")) {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "為日本的喜樂",
                html: '<p>翻譯內容。</p><p><a href="https://www.desiringgod.org/articles/for-the-joy-of-japan">(English)</a></p>',
                excerpt: "翻譯內容。",
                originalTitle: "For the Joy of Japan",
                leadImageUrl: "https://images.example.com/japan.jpg",
                leadImageAlt: "日本風景"
              })
            }
          }
        ]
      });
    }

    return new Response("blocked", {
      status: 403,
      headers: { "Content-Type": "text/html" }
    });
  };

  try {
    const sourceUrl = "https://www.desiringgod.org/articles/for-the-joy-of-japan";
    const result = await translateSourceArticle(sourceUrl);

    assert.equal(result.article.title, "For the Joy of Japan");
    assert.equal(result.article.images[0].url, "https://images.example.com/japan.jpg");
    assert.equal(result.translated.title, "為日本的喜樂");

    assert.equal(requests.length, 2);
    const openRouterRequest = JSON.parse(requests[1].options.body);
    assert.deepEqual(openRouterRequest.tools, [
      {
        type: "openrouter:web_fetch",
        parameters: { max_results: 1 }
      }
    ]);
    assert.match(openRouterRequest.messages[1].content, new RegExp(sourceUrl));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
