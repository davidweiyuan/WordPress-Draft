# WordPress Draft Translator

Local app for turning an English article URL into a Traditional Chinese WordPress draft.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a WordPress.com developer application:

   - Open `https://developer.wordpress.com/apps/`.
   - Create a new application.
   - Add this redirect URL exactly: `http://localhost:3000/auth/callback`.
   - Copy the app's client ID and client secret.

3. Copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env
   ```

   Create an API key in your [OpenRouter account](https://openrouter.ai/settings/keys), then fill in the key, your WordPress site URL, and your WordPress.com app credentials:

   ```sh
   OPENROUTER_API_KEY=your-openrouter-api-key
   WP_SITE_URL=https://your-site.wordpress.com
   WP_CLIENT_ID=your-client-id
   WP_CLIENT_SECRET=your-client-secret
   WP_REDIRECT_URI=http://localhost:3000/auth/callback
   WP_SITE_ID=your-wordpress-site-id
   WP_SCOPE=posts
   ```

   Set `WP_SITE_URL` to your site's full public URL, including `https://`. `WP_SITE_ID` is optional; leave it blank to use the hostname from `WP_SITE_URL`. The OpenRouter key is required for text translation and, when enabled, image translation.

4. Start the app:

   ```sh
   npm run dev
   ```

   The server binds explicitly to `localhost` for local-only access. If you change `PORT` in `.env`, update `WP_REDIRECT_URI` and the developer application's redirect URL to match.

5. Open `http://localhost:3000` and click `Connect WordPress.com`.

   After you approve access, the app saves a local `.wp-token.json` file. This file is ignored by git.

6. Paste an English article URL and use either:

   - `Preview` to translate text without creating a post.
   - Optionally enter an author name to show it centered beneath the post title.
   - Leave `Include Image` checked to add the lead article image. Uncheck it to create a text-only draft.
   - Leave `Translate` checked to translate English text inside the image. Uncheck it to add the original image unchanged.
   - `Create Draft` to translate the main article text and create a WordPress draft.

Every draft shows a centered source line beneath the title. When an author is entered, the line uses `Author, 譯自網絡`; otherwise it shows `譯自網絡` by itself. The source label links to the original article.

## Models

- Text translation: `google/gemini-3.5-flash`
- Image text translation/editing: `openai/gpt-5-image`

When `Include Image` is checked, the image pipeline compares the early article images and selects the most prominent large image, processing at most one image per draft. That same uploaded image is inserted into the post and assigned as the WordPress featured image/thumbnail. The image model is only used when `Translate` is also checked.

The WordPress draft slug is copied from the final path segment of the original article URL.
