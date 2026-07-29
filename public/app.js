const form = document.querySelector("#draft-form");
const urlInput = document.querySelector("#url-input");
const previewButton = document.querySelector("#preview-button");
const draftButton = document.querySelector("#draft-button");
const includeImageInput = document.querySelector("#include-image");
const translateImageInput = document.querySelector("#translate-image");
const message = document.querySelector("#message");
const previewOutput = document.querySelector("#preview-output");
const statusPill = document.querySelector("#status-pill");
const draftLink = document.querySelector("#draft-link");
const connectButton = document.querySelector(".connect-button");

function setBusy(isBusy, label = "Working") {
  previewButton.disabled = isBusy;
  draftButton.disabled = isBusy;
  includeImageInput.disabled = isBusy;
  translateImageInput.disabled = isBusy || !includeImageInput.checked;
  statusPill.textContent = isBusy ? label : "Ready";
}

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function setPreview(data) {
  previewOutput.innerHTML = `<h1>${escapeHtml(data.title)}</h1>${data.html}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function requestJson(path, url, includeImage, translateImage) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, includeImage, translateImage })
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

async function refreshAuthStatus() {
  try {
    const response = await fetch("/api/auth/status");
    const data = await response.json();

    if (data.connected) {
      connectButton.textContent = "WordPress Connected";
      connectButton.setAttribute("aria-disabled", "true");
      showMessage("WordPress.com is connected. You can create drafts.", "success");
    } else if (new URLSearchParams(window.location.search).has("connected")) {
      showMessage("WordPress.com connection was not saved. Try connecting again.", "error");
    }
  } catch {
    showMessage("Could not check WordPress.com connection.", "error");
  }
}

previewButton.addEventListener("click", async () => {
  try {
    draftLink.hidden = true;
    setBusy(true, "Translating");
    showMessage("Fetching and translating the article...");
    const includeImage = includeImageInput.checked;
    const translateImage = translateImageInput.checked;
    const data = await requestJson(
      "/api/preview",
      urlInput.value,
      includeImage,
      translateImage
    );
    setPreview(data);
    const imageNote = includeImage && data.imageCount
      ? translateImage
        ? " The lead image will be translated during draft creation."
        : " The original lead image will be included during draft creation."
      : "";
    showMessage(`Preview translated. Review it, then create the draft.${imageNote}`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    draftLink.hidden = true;
    setBusy(true, "Publishing");
    const includeImage = includeImageInput.checked;
    const translateImage = translateImageInput.checked;
    showMessage(
      includeImage
        ? translateImage
          ? "Translating the article and lead image, then creating a WordPress draft..."
          : "Translating the article and adding the original lead image..."
        : "Translating the article and creating a WordPress draft..."
    );
    const data = await requestJson(
      "/api/drafts",
      urlInput.value,
      includeImage,
      translateImage
    );
    const imageNote = data.imageCount
      ? data.imageTranslated
        ? " Translated the lead image."
        : " Included the original lead image."
      : "";
    showMessage(`Draft created: ${data.title}.${imageNote}`, "success");

    if (data.wordpress?.editUrl) {
      draftLink.href = data.wordpress.editUrl;
      draftLink.hidden = false;
    }
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
});

includeImageInput.addEventListener("change", () => setBusy(false));

setBusy(false);
refreshAuthStatus();
