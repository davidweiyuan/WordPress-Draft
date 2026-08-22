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

3. Add the WordPress.com app credentials to `.env`:

   ```sh
   WP_CLIENT_ID=your-client-id
   WP_CLIENT_SECRET=your-client-secret
   WP_REDIRECT_URI=http://localhost:3000/auth/callback
   WP_SITE_ID=your-wordpress-site-id
   WP_SCOPE=posts
   ```

4. Start the app:

   ```sh
   npm run dev
   ```

5. Open `http://localhost:3000` and click `Connect WordPress.com`.

   After you approve access, the app saves a local `.wp-token.json` file. This file is ignored by git.

6. Paste an English article URL and use either:

   - `Preview` to translate text without creating a post.
   - Leave `Include Image` checked to add the lead article image. Uncheck it to create a text-only draft.
   - Leave `Translate` checked to translate English text inside the image. Uncheck it to add the original image unchanged.
   - `Create Draft` to translate the main article text and create a WordPress draft.

Every draft ends with a link to the original article titled `English`.

## Models

- Text translation: `google/gemini-3.5-flash`
- Image text translation/editing: `openai/gpt-5-image`

If a publisher blocks the app's direct article request or returns unreadable HTML, the app falls back to OpenRouter's URL-fetch tool and translates the retrieved main article. This fallback may add OpenRouter web-fetch usage charges.

When `Include Image` is checked, the image pipeline compares the early article images and selects the most prominent large image, processing at most one image per draft. That same uploaded image is inserted into the post and assigned as the WordPress featured image/thumbnail. The image model is only used when `Translate` is also checked.

The WordPress draft slug is copied from the final path segment of the original article URL.
