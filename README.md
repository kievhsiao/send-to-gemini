# Send to Gemini

A Chrome extension that allows you to quickly send selected text or images directly to Google Gemini via the right-click context menu. It supports custom prompts and sending directly to your personalized Gemini Gems.

## Features

- **Direct Send**: Send selected text directly to Gemini.
- **Custom Prompts**: Send text with customizable pre-prompts (e.g., "Translate to English:", "Summarize:").
- **Gemini Gems Support**: Send selected text directly to specific custom Gems you have set up in your Gemini account.
- **Image Support**: Right-click on any image on a webpage and send it directly to Gemini.
- **Customizable Options**: An options page to easily add, edit, or remove your favorite pre-prompts and Gems.

## Installation

1. Clone or download this repository.
2. Ensure you have Node.js installed. Run the following command to install dependencies:
   ```bash
   npm install
   ```
3. Compile the TypeScript source files to JavaScript:
   ```bash
   npm run build
   ```
4. Open Google Chrome and navigate to `chrome://extensions/`.
5. Enable **Developer mode** in the top right corner.
6. Click **Load unpacked** and select the `dist` folder from this project's directory.

## Usage

1. Select any text or hover over an image on a webpage.
2. Right-click to open the browser's context menu.
3. Look for the options under the Gemini extension (e.g., "直接傳送 (Direct Send)", your custom prompts, or your Gems).
4. Click your desired option. A new tab will open in Gemini with your content ready.

## Configuration

To customize your prompts and Gems:
1. Right-click the "Send to Gemini" extension icon in your Chrome toolbar.
2. Select **Options**.
3. In the options page, you can:
   - Add new text prompts (e.g., "Explain this code: ", "Rewrite nicely: ").
   - Add custom Gemini Gems by providing a display name and the specific Gem ID (found in the Gem's URL).
4. Click **Save All Changes**. The context menu will update automatically.

## Tech Stack

- TypeScript
- Chrome Extension API (Manifest V3)
- HTML/CSS
