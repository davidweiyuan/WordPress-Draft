import "dotenv/config";
import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const app = express();
const port = Number(process.env.PORT || 3000);
const tokenPath = path.join(process.cwd(), ".wp-token.json");
const imageMimeToExt = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function publicWordPressSiteRef() {
  if (process.env.WP_SITE_ID) {
    return process.env.WP_SITE_ID;
  }

  return publicWordPressSiteHost();
}

function publicWordPressSiteHost() {
  const siteUrl = requireEnv("WP_SITE_URL");
  return new URL(siteUrl).hostname;
}

async function getWordPressToken() {
  if (!existsSync(tokenPath)) {
    throw new Error("WordPress is not connected. Use Connect WordPress.com first.");
  }

  const token = JSON.parse(await readFile(tokenPath, "utf8"));
  if (!token.access_token) {
    throw new Error("Saved WordPress token is missing an access token.");
  }

  return token;
}

async function saveWordPressToken(token) {
  await writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Please enter a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  return url.toString();
}

function extractArticle(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.textContent?.trim()) {
    throw new Error("Could not extract readable article text from that URL.");
  }

  return {
    title: article.title || dom.window.document.title || "Untitled",
    text: article.textContent.trim(),
    content: article.content || "",
    images: extractArticleImages(article.content || "", url),
    excerpt: article.excerpt || "",
    byline: article.byline || ""
  };
}

function extractArticleImages(content, sourceUrl) {
  const dom = new JSDOM(`<article>${content}</article>`, { url: sourceUrl });
  const seen = new Set();

  return [...dom.window.document.querySelectorAll("img")]
    .map((img) => {
      const src = img.getAttribute("src");
      if (!src) return null;

      let url;
      try {
        url = new URL(src, sourceUrl).toString();
      } catch {
        return null;
      }

      const alt = img.getAttribute("alt") || "";
      const width = Number(img.getAttribute("width") || 0);
      const height = Number(img.getAttribute("height") || 0);
      return { url, alt, width, height };
    })
    .filter((image) => {
      if (!image || seen.has(image.url)) return false;
      seen.add(image.url);
      return true;
    });
}

async function fetchArticle(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "WordPressDraftTranslator/0.1 (+local app)",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Article request failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error("The URL did not return an HTML article.");
  }

  return response.text();
}

function buildTranslationPrompt(article, sourceUrl) {
  return [
    {
      role: "system",
      content:
        "You translate English Christian essays into natural Traditional Chinese for a WordPress audience. Preserve meaning, paragraph structure, scripture references, names, and quoted material. Return only valid JSON."
    },
    {
      role: "user",
      content: `Translate this article into Traditional Chinese and prepare it as WordPress post HTML.

Requirements:
- Return JSON with keys: title, html, excerpt.
- Use Traditional Chinese.
- Keep the title faithful and natural.
- Use semantic HTML paragraphs and headings only where appropriate.
- Do not add commentary.
- At the end of html, add this exact source link paragraph: <p><a href="${sourceUrl}">English</a></p>

Original title: ${article.title}
Byline: ${article.byline || "N/A"}
Excerpt: ${article.excerpt || "N/A"}

Article text:
${article.text}`
    }
  ];
}

function parseJsonFromModel(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Translation response was not valid JSON: ${error.message}`);
  }
}

async function translateArticle(article, sourceUrl) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = process.env.OPENROUTER_MODEL || "google/gemini-3.5-flash";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.WP_SITE_URL || "http://localhost",
      "X-Title": "WordPress Draft Translator"
    },
    body: JSON.stringify({
      model,
      messages: buildTranslationPrompt(article, sourceUrl),
      response_format: { type: "json_object" },
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed with HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenRouter returned no translation content.");
  }

  const translated = parseJsonFromModel(content);
  if (!translated.title || !translated.html) {
    throw new Error("Translation response must include title and html.");
  }

  return {
    title: String(translated.title),
    html: String(translated.html),
    excerpt: translated.excerpt ? String(translated.excerpt) : ""
  };
}

async function downloadImage(imageUrl) {
  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "WordPressDraftTranslator/0.1 (+local app)",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Image request failed with HTTP ${response.status}: ${imageUrl}`);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) {
    throw new Error(`Image URL did not return an image: ${imageUrl}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: contentType,
    dataUrl: `data:${contentType};base64,${bytes.toString("base64")}`
  };
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Image model did not return a base64 data URL.");
  }

  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], "base64")
  };
}

async function translateImageText(image, index) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = process.env.OPENROUTER_IMAGE_MODEL || "openai/gpt-5-image";
  const original = await downloadImage(image.url);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.WP_SITE_URL || "http://localhost",
      "X-Title": "WordPress Draft Translator"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Edit this image. Translate any visible English text into natural Traditional Chinese. Preserve the same image, composition, colors, typography style, layout, non-text visual details, and approximate text placement. If there is no English text, return the image unchanged. Output only the edited image."
            },
            {
              type: "image_url",
              image_url: { url: original.dataUrl }
            }
          ]
        }
      ],
      modalities: ["image", "text"],
      image_config: {
        output_format: "png"
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter image request failed with HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const returnedImage = data.choices?.[0]?.message?.images?.[0];
  const imageUrl =
    returnedImage?.image_url?.url ||
    returnedImage?.imageUrl?.url ||
    returnedImage?.url;
  if (!imageUrl) {
    throw new Error(`Image model returned no edited image for image ${index + 1}.`);
  }

  const edited = imageUrl.startsWith("data:")
    ? parseDataUrl(imageUrl)
    : await downloadImage(imageUrl);

  return {
    ...image,
    bytes: edited.bytes,
    mimeType: edited.mimeType || "image/png"
  };
}

function wordpressApiBase() {
  const site = encodeURIComponent(process.env.WP_SITE_ID || publicWordPressSiteRef());
  return `https://public-api.wordpress.com/wp/v2/sites/${site}`;
}

function mediaFilename(image, index) {
  const sourcePath = new URL(image.url).pathname;
  const sourceName = path.basename(sourcePath).replace(/\?.*$/, "");
  const ext = imageMimeToExt.get(image.mimeType) || "png";
  const base = sourceName && sourceName.includes(".")
    ? sourceName.replace(/\.[^.]+$/, "")
    : `translated-image-${index + 1}`;

  return `${base}-zh.${ext}`;
}

async function uploadWordPressMedia(image, index) {
  const token = await getWordPressToken();
  const filename = mediaFilename(image, index);
  const response = await fetch(`${wordpressApiBase()}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": image.mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`
    },
    body: image.bytes
  });

  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = { raw: body };
  }

  if (!response.ok) {
    throw new Error(`WordPress media upload failed with HTTP ${response.status}: ${body}`);
  }

  return {
    id: data.id,
    url: data.source_url || data.guid?.rendered || data.link,
    alt: image.alt || ""
  };
}

async function translateAndUploadImages(images) {
  const maxImages = Number(process.env.MAX_TRANSLATED_IMAGES || 3);
  const selectedImages = images.slice(0, maxImages);
  const uploaded = [];

  for (const [index, image] of selectedImages.entries()) {
    const translatedImage = await translateImageText(image, index);
    uploaded.push(await uploadWordPressMedia(translatedImage, index));
  }

  return uploaded;
}

function buildImageHtml(images) {
  return images
    .filter((image) => image.url)
    .map((image) => {
      const alt = escapeHtml(image.alt);
      const src = escapeHtml(image.url);
      return `<figure class="wp-block-image"><img src="${src}" alt="${alt}"></figure>`;
    })
    .join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function insertImagesBeforeSourceLink(html, images) {
  if (!images.length) return html;

  const imageHtml = buildImageHtml(images);
  const sourceLinkPattern = /<p>\s*<a\s+href="[^"]+">\s*English\s*<\/a>\s*<\/p>\s*$/i;

  if (sourceLinkPattern.test(html)) {
    return html.replace(sourceLinkPattern, `${imageHtml}\n$&`);
  }

  return `${html}\n${imageHtml}`;
}

async function createWordPressDraft(post) {
  const token = await getWordPressToken();
  const response = await fetch(`${wordpressApiBase()}/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: post.title,
      content: post.html,
      excerpt: post.excerpt,
      status: "draft"
    })
  });

  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    data = { raw: body };
  }

  if (!response.ok) {
    throw new Error(`WordPress draft creation failed with HTTP ${response.status}: ${body}`);
  }

  return data;
}

app.post("/api/drafts", async (req, res) => {
  try {
    const sourceUrl = normalizeUrl(req.body?.url || "");
    await getWordPressToken();

    const html = await fetchArticle(sourceUrl);
    const article = extractArticle(html, sourceUrl);
    const translated = await translateArticle(article, sourceUrl);
    const uploadedImages = await translateAndUploadImages(article.images);
    translated.html = insertImagesBeforeSourceLink(translated.html, uploadedImages);
    const draft = await createWordPressDraft(translated);

    res.json({
      ok: true,
      sourceUrl,
      title: translated.title,
      imageCount: uploadedImages.length,
      wordpress: {
        id: draft.id,
        editUrl: draft.link,
        status: draft.status
      }
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/auth/login", (req, res) => {
  try {
    const clientId = requireEnv("WP_CLIENT_ID");
    const redirectUri = process.env.WP_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
    const authorizeUrl = new URL("https://public-api.wordpress.com/oauth2/authorize");

    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("blog", publicWordPressSiteHost());
    authorizeUrl.searchParams.set("scope", process.env.WP_SCOPE || "posts");

    res.redirect(authorizeUrl.toString());
  } catch (error) {
    res.status(400).send(error.message);
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (req.query.error) {
      throw new Error(req.query.error_description || req.query.error);
    }

    const code = req.query.code;
    if (!code) {
      throw new Error("WordPress.com did not return an authorization code.");
    }

    const redirectUri = process.env.WP_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: requireEnv("WP_CLIENT_ID"),
      client_secret: requireEnv("WP_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      code: String(code),
      grant_type: "authorization_code"
    });

    const response = await fetch("https://public-api.wordpress.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const body = await response.text();
    let token;
    try {
      token = JSON.parse(body);
    } catch {
      token = { raw: body };
    }

    if (!response.ok || !token.access_token) {
      throw new Error(`Token exchange failed with HTTP ${response.status}: ${body}`);
    }

    await saveWordPressToken(token);
    res.redirect("/?connected=1");
  } catch (error) {
    res.status(400).send(`WordPress.com connection failed: ${error.message}`);
  }
});

app.get("/api/auth/status", async (req, res) => {
  try {
    const token = await getWordPressToken();
    res.json({
      ok: true,
      connected: true,
      blogId: token.blog_id || null,
      blogUrl: token.blog_url || null
    });
  } catch {
    res.json({ ok: true, connected: false });
  }
});

app.post("/api/preview", async (req, res) => {
  try {
    const sourceUrl = normalizeUrl(req.body?.url || "");
    const html = await fetchArticle(sourceUrl);
    const article = extractArticle(html, sourceUrl);
    const translated = await translateArticle(article, sourceUrl);

    res.json({
      ok: true,
      sourceUrl,
      originalTitle: article.title,
      imageCount: article.images.length,
      ...translated
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`WordPress Draft Translator running at http://localhost:${port}`);
});
