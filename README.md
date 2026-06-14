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
   - `Create Draft` to translate text, translate English text inside article images, upload edited images to WordPress, and create a WordPress draft.

Every draft ends with a link to the original article titled `English`.

## Models

- Text translation: `google/gemini-3.5-flash`
- Image text translation/editing: `openai/gpt-5-image`

The image pipeline processes up to `MAX_TRANSLATED_IMAGES` article images per draft.
