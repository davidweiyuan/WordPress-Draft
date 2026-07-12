import "dotenv/config";
import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sharp from "sharp";

const app = express();
const port = Number(process.env.PORT || 3000);
const tokenPath = path.join(process.cwd(), ".wp-token.json");
const imageMimeToExt = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
  ["image/svg+xml", "svg"]
]);
const wordpressImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const fetchRetryCount = 3;
const fetchTimeoutMs = 20000;
const fetchRetryDelayMs = 600;
const openRouterRetryCount = 4;
const openRouterTimeoutMs = 90000;
const openRouterRetryDelayMs = 1500;
const imageDownloadAccept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/*,*/*;q=0.8";
const mainContentExcludeSelector = [
  "aside",
  "footer",
  "nav",
  "form",
  "script",
  "style",
  "noscript",
  "template",
  "[role='complementary']",
  "[role='contentinfo']",
  "[role='navigation']",
  "[aria-label*='comment' i]",
  "[id*='comment' i]",
  "[class*='comment' i]",
  "[id*='footnote' i]",
  "[class*='footnote' i]",
  "[id*='endnote' i]",
  "[class*='endnote' i]",
  "[id*='appendix' i]",
  "[class*='appendix' i]",
  "[id*='related' i]",
  "[class*='related' i]",
  "[id*='share' i]",
  "[class*='share' i]"
].join(",");
const sectionCutoffHeadingPattern =
  /^(footnotes?|endnotes?|notes?|references|appendix|appendices|comments?|responses?|discussion)\b/i;

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
  const document = dom.window.document;
  const reader = new Readability(document.cloneNode(true));
  const article = reader.parse();

  if (!article?.textContent?.trim()) {
    throw new Error("Could not extract readable article text from that URL.");
  }

  const mainContent = cleanMainArticleContent(article.content || "", url);
  const mainText = extractMainArticleText(mainContent, article.textContent);
  const mainImage = extractMainArticleImage(document, mainContent, url);

  return {
    title: article.title || dom.window.document.title || "Untitled",
    text: mainText,
    content: mainContent,
    images: mainImage ? [mainImage] : [],
    excerpt: article.excerpt || "",
    byline: article.byline || ""
  };
}

function cleanMainArticleContent(content, sourceUrl) {
  const dom = new JSDOM(`<article>${content}</article>`, { url: sourceUrl });
  const document = dom.window.document;
  const article = document.querySelector("article");

  article.querySelectorAll(mainContentExcludeSelector).forEach((element) => element.remove());
  article
    .querySelectorAll("sup, a[role='doc-noteref'], a[href^='#fn'], a[href^='#footnote']")
    .forEach((element) => element.remove());

  [...article.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter((heading) => sectionCutoffHeadingPattern.test(normalizeHeadingText(heading.textContent)))
    .forEach(removeSectionStartingAtHeading);

  return article.innerHTML.trim();
}

function normalizeHeadingText(value) {
  return String(value).replace(/\s+/g, " ").replace(/[:：]+$/, "").trim();
}

function headingLevel(element) {
  return Number(element.tagName.slice(1));
}

function removeSectionStartingAtHeading(heading) {
  const level = headingLevel(heading);
  let node = heading;

  while (node) {
    const next = node.nextElementSibling;
    node.remove();

    if (next?.matches("h1,h2,h3,h4,h5,h6") && headingLevel(next) <= level) {
      break;
    }

    node = next;
  }
}

function extractMainArticleText(content, fallbackText) {
  const dom = new JSDOM(`<article>${content}</article>`);
  const blocks = [];

  for (const element of dom.window.document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,li")) {
    if (element.closest("blockquote") && element.tagName !== "BLOCKQUOTE") continue;

    const text = element.textContent.replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
  }

  const text = blocks.join("\n\n").trim();
  return text || fallbackText.trim();
}

function extractArticleImages(content, sourceUrl) {
  const dom = new JSDOM(`<article>${content}</article>`, { url: sourceUrl });
  return extractImagesFromContainer(dom.window.document.querySelector("article"), sourceUrl);
}

function extractImagesFromContainer(container, sourceUrl) {
  if (!container) return [];

  const seen = new Set();

  return [...container.querySelectorAll("img")]
    .map((img) => {
      const source = imageSourceFromElement(img);
      if (!source?.url) return null;

      let url;
      try {
        url = normalizeSourceImageUrl(new URL(source.url, sourceUrl), sourceUrl);
      } catch {
        return null;
      }

      const alt = img.getAttribute("alt") || "";
      const renderedWidth = Number(img.getAttribute("width") || 0);
      const renderedHeight = Number(img.getAttribute("height") || 0);
      const width = source.width || renderedWidth;
      const height = source.width && renderedWidth && renderedHeight
        ? Math.round(source.width * (renderedHeight / renderedWidth))
        : renderedHeight;
      return { url, alt, width, height };
    })
    .filter((image) => {
      if (!image || seen.has(image.url)) return false;
      seen.add(image.url);
      return true;
    });
}

function imageSourceFromElement(img) {
  const srcset =
    img.getAttribute("srcset") ||
    img.closest("picture")?.querySelector("source[srcset]")?.getAttribute("srcset");
  if (srcset) {
    const candidates = srcset
      .split(",")
      .map((candidate) => {
        const [url, descriptor = ""] = candidate.trim().split(/\s+/);
        const width = descriptor.endsWith("w")
          ? Number(descriptor.slice(0, -1))
          : 0;
        return { url, width };
      })
      .filter((candidate) => candidate.url);
    const largestCandidate = candidates.reduce(
      (largest, candidate) => candidate.width > largest.width ? candidate : largest,
      { url: "", width: 0 }
    );
    if (largestCandidate.url) return largestCandidate;
  }

  const lazySource =
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-original");
  if (lazySource) return { url: lazySource, width: 0 };

  const src = img.getAttribute("src");
  return src ? { url: src, width: 0 } : null;
}

function normalizeSourceImageUrl(imageUrl, sourceUrl) {
  if (imageUrl.hostname.endsWith(".imgix.net") && imageUrl.pathname.startsWith("/wp-content/uploads/")) {
    const sourceOrigin = new URL(sourceUrl).origin;
    return new URL(imageUrl.pathname, sourceOrigin).toString();
  }

  if (/^i\d\.wp\.com$/i.test(imageUrl.hostname)) {
    const [, proxiedHost, ...pathSegments] = imageUrl.pathname.split("/");
    const proxiedPath = `/${pathSegments.join("/")}`;
    if (proxiedHost && proxiedPath.startsWith("/wp-content/uploads/")) {
      return new URL(proxiedPath, `${imageUrl.protocol}//${proxiedHost}`).toString();
    }
  }

  return imageUrl.toString();
}

function extractMainArticleImage(document, content, sourceUrl) {
  for (const container of findOriginalArticleContainers(document)) {
    const prominentImage = selectProminentArticleImage(
      extractImagesFromContainer(container, sourceUrl)
    );
    if (prominentImage) return prominentImage;
  }

  const articleImage = selectProminentArticleImage(extractArticleImages(content, sourceUrl));
  if (articleImage) return articleImage;

  const metaUrl =
    document.querySelector("meta[property='og:image']")?.getAttribute("content") ||
    document.querySelector("meta[name='twitter:image']")?.getAttribute("content");
  if (!metaUrl) return null;

  try {
    return {
      url: normalizeSourceImageUrl(new URL(metaUrl, sourceUrl), sourceUrl),
      alt:
        document.querySelector("meta[property='og:image:alt']")?.getAttribute("content") ||
        document.querySelector("meta[name='twitter:image:alt']")?.getAttribute("content") ||
        "",
      width: Number(document.querySelector("meta[property='og:image:width']")?.getAttribute("content") || 0),
      height: Number(document.querySelector("meta[property='og:image:height']")?.getAttribute("content") || 0)
    };
  } catch {
    return null;
  }
}

function findOriginalArticleContainers(document) {
  const selectors = [
    "main article",
    "[role='main'] article",
    ".entry-content",
    ".post-content",
    ".article-content",
    "article",
    "main"
  ];
  const containers = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const container of document.querySelectorAll(selector)) {
      if (seen.has(container)) continue;
      seen.add(container);
      containers.push(container);
    }
  }

  return containers;
}

function selectProminentArticleImage(images) {
  const candidates = images.filter(isLikelyArticleImage).slice(0, 8);
  if (!candidates.length) return null;

  return candidates.reduce((best, image, index) => {
    const area = (image.width || 0) * (image.height || 0);
    const positionWeight = (index + 1) ** 2;
    const score = area > 0 ? area / positionWeight : 1 / positionWeight;
    return !best || score > best.score ? { image, score } : best;
  }, null).image;
}

function isLikelyArticleImage(image) {
  const smallestKnownSide = Math.min(image.width || Infinity, image.height || Infinity);
  const url = image.url.toLowerCase();
  const alt = image.alt.toLowerCase();

  if (smallestKnownSide < 120) return false;
  if (/(avatar|author|logo|icon|tracking|pixel|spacer)/.test(url)) return false;
  if (/(avatar|author|logo|icon)/.test(alt)) return false;

  return true;
}

async function fetchGetWithRetry(url, options, context) {
  return fetchWithRetry(url, options, context, {
    retryCount: fetchRetryCount,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs
  });
}

async function fetchWithRetry(url, options, context, retryOptions) {
  const {
    retryCount,
    timeoutMs,
    retryDelayMs
  } = retryOptions;
  let lastError;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = error;
      if (attempt === retryCount) break;
      await wait(retryDelayMs * attempt);
    }
  }

  throw new Error(`${context} failed after ${retryCount} attempts: ${formatFetchError(lastError)}`);
}

function formatFetchError(error) {
  const cause = error?.cause;
  const details = [
    error?.message,
    cause?.code,
    cause?.reason,
    cause?.message
  ].filter(Boolean);

  return details.length ? details.join(" - ") : "network request failed";
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchArticle(url) {
  const response = await fetchGetWithRetry(url, {
    headers: {
      "User-Agent": browserUserAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  }, "Article request");

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
        "You translate English Christian essays into natural Traditional Chinese for a WordPress audience. Translate only the main article body. Preserve meaning, paragraph structure, scripture references, names, and quoted material. Return only valid JSON."
    },
    {
      role: "user",
      content: `Translate this article into Traditional Chinese and prepare it as WordPress post HTML.

Requirements:
- Return JSON with keys: title, html, excerpt.
- Use Traditional Chinese.
- Keep the title faithful and natural.
- Use semantic HTML paragraphs and headings only where appropriate.
- Translate only the main article text below.
- Do not include footnotes, endnotes, references, appendix material, reader comments, related links, sharing text, author bios, or comment prompts.
- Create the excerpt from the translated main article text.
- Do not add commentary.
- Return JSON string values with all newlines, tabs, and other control characters properly escaped.
- Escape all double quotes inside JSON string values, including HTML attribute quotes.
- At the end of html, add this exact source link paragraph: <p><a href="${sourceUrl}">(English)</a></p>

Original title: ${article.title}

Main article text:
${article.text}`
    }
  ];
}

function parseJsonFromModel(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = extractJsonObject(fenced ? fenced[1] : trimmed);
  const candidates = [
    jsonText,
    escapeControlCharactersInJsonStrings(jsonText),
    insertMissingCommasBetweenKnownProperties(jsonText),
    escapeControlCharactersInJsonStrings(insertMissingCommasBetweenKnownProperties(jsonText))
  ];
  let firstError;

  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      firstError ||= error;
    }
  }

  try {
    return parseLooseTranslationObject(jsonText);
  } catch {
    throw new Error(`Translation response was not valid JSON: ${firstError.message}`);
  }
}

function insertMissingCommasBetweenKnownProperties(value) {
  return String(value).replace(
    /(["}\]])\s*("(?:title|html|excerpt)"\s*:)/g,
    "$1,$2"
  );
}

function parseLooseTranslationObject(value) {
  const fieldPattern = /"(title|html|excerpt)"\s*:/g;
  const matches = [...String(value).matchAll(fieldPattern)];
  const result = {};

  for (const [index, match] of matches.entries()) {
    const key = match[1];
    const valueStart = match.index + match[0].length;
    const fallbackEnd = String(value).lastIndexOf("}") > valueStart
      ? String(value).lastIndexOf("}")
      : String(value).length;
    const valueEnd = matches[index + 1]?.index ?? fallbackEnd;
    if (valueEnd <= valueStart) continue;

    result[key] = decodeLooseJsonStringValue(String(value).slice(valueStart, valueEnd));
  }

  if (!result.title || !result.html) {
    throw new Error("Loose translation object did not include title and html.");
  }

  return result;
}

function decodeLooseJsonStringValue(value) {
  let text = String(value).trim();

  if (text.endsWith(",")) {
    text = text.slice(0, -1).trimEnd();
  }

  if (text.startsWith('"')) {
    text = text.slice(1);
  }

  if (text.endsWith('"')) {
    text = text.slice(0, -1);
  }

  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\(["\\/bfnrt])/g, (_, char) => {
      const escapes = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t"
      };
      return escapes[char] ?? char;
    });
}

function escapeControlCharactersInJsonStrings(value) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of String(value)) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (inString && char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }

    if (inString && char.charCodeAt(0) < 0x20) {
      const escapes = {
        "\b": "\\b",
        "\t": "\\t",
        "\n": "\\n",
        "\f": "\\f",
        "\r": "\\r"
      };
      result += escapes[char] || `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    result += char;
  }

  return result;
}

function extractJsonObject(value) {
  const text = String(value).trim();
  const start = text.indexOf("{");
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return text;
}

async function translateArticle(article, sourceUrl) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = process.env.OPENROUTER_MODEL || "google/gemini-3.5-flash";

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
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
    },
    "OpenRouter translation request",
    {
      retryCount: openRouterRetryCount,
      timeoutMs: openRouterTimeoutMs,
      retryDelayMs: openRouterRetryDelayMs
    }
  );

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
  const response = await fetchGetWithRetry(imageUrl, {
    headers: {
      "User-Agent": browserUserAgent,
      Accept: imageDownloadAccept
    }
  }, "Image request");

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

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
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
    },
    "OpenRouter image request",
    {
      retryCount: openRouterRetryCount,
      timeoutMs: openRouterTimeoutMs,
      retryDelayMs: openRouterRetryDelayMs
    }
  );

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
    mimeType: edited.mimeType || "image/png",
    translated: true
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

  const suffix = image.translated ? "-zh" : "";
  return `${base}${suffix}.${ext}`;
}

async function uploadWordPressMedia(image, index) {
  const token = await getWordPressToken();
  const compatibleImage = await makeWordPressCompatibleImage(image);
  const filename = mediaFilename(compatibleImage, index);
  const response = await fetch(`${wordpressApiBase()}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": compatibleImage.mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`
    },
    body: compatibleImage.bytes
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
    alt: compatibleImage.alt || ""
  };
}

async function makeWordPressCompatibleImage(image) {
  if (wordpressImageMimeTypes.has(image.mimeType)) {
    return image;
  }

  try {
    return {
      ...image,
      bytes: await sharp(image.bytes, { animated: true }).png().toBuffer(),
      mimeType: "image/png"
    };
  } catch (error) {
    throw new Error(
      `Could not convert ${image.mimeType || "the source image"} to a WordPress-compatible PNG: ${error.message}`
    );
  }
}

async function uploadMainImage(images, translateImage) {
  const selectedImages = images.slice(0, 1);
  const uploaded = [];

  for (const [index, image] of selectedImages.entries()) {
    if (translateImage) {
      const translatedImage = await translateImageText(image, index);
      uploaded.push(await uploadWordPressMedia(translatedImage, index));
      continue;
    }

    const original = await downloadImage(image.url);
    uploaded.push(await uploadWordPressMedia({
      ...image,
      bytes: original.bytes,
      mimeType: original.mimeType,
      translated: false
    }, index));
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
  const sourceLinkPattern = /<p>\s*<a\s+href="[^"]+">\s*\(?English\)?\s*<\/a>\s*<\/p>\s*$/i;

  if (sourceLinkPattern.test(html)) {
    return html.replace(sourceLinkPattern, `${imageHtml}\n$&`);
  }

  return `${html}\n${imageHtml}`;
}

function sourceSlug(sourceUrl) {
  const segments = new URL(sourceUrl).pathname.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment) return "";

  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

function buildWordPressPostPayload(post, featuredMediaId, slug) {
  const payload = {
    title: post.title,
    content: post.html,
    excerpt: post.excerpt,
    status: "draft"
  };

  if (featuredMediaId) {
    payload.featured_media = featuredMediaId;
  }

  if (slug) {
    payload.slug = slug;
  }

  return payload;
}

async function createWordPressDraft(post, featuredMediaId, slug) {
  const token = await getWordPressToken();
  const response = await fetch(`${wordpressApiBase()}/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildWordPressPostPayload(post, featuredMediaId, slug))
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
    const includeImage = req.body?.includeImage !== false;
    const translateImage = req.body?.translateImage !== false;
    await getWordPressToken();

    const html = await fetchArticle(sourceUrl);
    const article = extractArticle(html, sourceUrl);
    const translated = await translateArticle(article, sourceUrl);
    const uploadedImages = includeImage
      ? await uploadMainImage(article.images, translateImage)
      : [];
    translated.html = insertImagesBeforeSourceLink(translated.html, uploadedImages);
    const slug = sourceSlug(sourceUrl);
    const draft = await createWordPressDraft(translated, uploadedImages[0]?.id, slug);

    res.json({
      ok: true,
      sourceUrl,
      title: translated.title,
      slug,
      imageCount: uploadedImages.length,
      imageTranslated: uploadedImages.length > 0 && translateImage,
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
    const includeImage = req.body?.includeImage !== false;
    const translateImage = req.body?.translateImage !== false;
    const html = await fetchArticle(sourceUrl);
    const article = extractArticle(html, sourceUrl);
    const translated = await translateArticle(article, sourceUrl);

    res.json({
      ok: true,
      sourceUrl,
      originalTitle: article.title,
      imageCount: includeImage ? article.images.length : 0,
      imageTranslated: includeImage && translateImage,
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
