# Forge Anywhere · v1.0.5

Send inspiration to your canvas. Send images and videos from webpages to an open Forge or Tusi canvas.

## Install

1. Extract `Forge-Anywhere-v1.0.5.zip`. Keep the extracted `Forge-Anywhere` folder on your computer.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the extracted `Forge-Anywhere` folder. Pin the extension to your toolbar for easy access.

To update, replace the files in your existing extension folder with the new package, then click **Reload** on the extension management page. Refresh media pages and set your destination canvas again. The extension is installed locally and is not currently listed in the Chrome Web Store.

## Send media

1. Sign in to Forge or Tusi and open a workflow canvas. Open Forge Anywhere and choose **Set destination**. Keep the canvas tab open.
2. Switch to a webpage. Right-click an image or a video and choose **Send to canvas**. If the site has its own right-click menu, click the Forge icon that appears at the top-right of the media after right-clicking it.
3. Allow access to the required source if prompted. Check the canvas for the new media. **Open** in the destination card takes you back to that canvas.

The Forge logo in the panel opens the [Forge homepage](https://forge.art/). Without a destination, the media context menu and the icon shown after right-clicking open Forge instead. Set a destination to send media; earlier clicks are not automatically replayed.

If no entry appears, open the extension once on the media page, or use **Choose media** in its panel. A video thumbnail is an image; open the playback page to send the video.

The panel keeps the latest media preview and its selected, sending, sent, or failed state in one card. **Sent** means the file was handed to the canvas and handling was detected. Uploading and saving still depend on the canvas; check its result before retrying.

## Videos

Turn on **Auto-prepare video** in the panel and grant website access. Refresh video pages that were already open. Then play normally and right-click to send. The extension first tries to obtain a full video file; for supported segmented players it can instead assemble a prepared clip.

**Clip 00:20–00:30** identifies the range on the original video's timeline. **No audio** indicates that the result has no audio track. A prepared clip may cover only part of the video. If a video is not ready, let it load and try again.

Video preparation happens locally. Media is uploaded only when you send. Preparation captures supported compressed media segments, rather than recording the screen. Some players, encrypted videos, formats and sources are unsupported. Automatic preparation allows up to four video pages, with a 64 MiB capture budget per page. Closing a page clears its in-memory capture.

## Language

Use the settings icon in the panel, or right-click the toolbar icon and choose **Options**. Select **Follow browser**, **简体中文**, or **English**. Changes save automatically on this browser.

By default, Chinese browser languages—including Traditional Chinese—use Simplified Chinese. Other browser languages use English. You can override this without changing your browser language. Browser-owned permission dialogs and extension management pages still follow the browser's language.

## Notes

- The extension sends a media file through the canvas's existing file-drop upload flow. It does not save a source-page link as your canvas asset.
- Readable images are exported as PNG. If browser security rules prevent this, the extension may request source access and fetch the original file. Supported original image formats are static JPEG, PNG and WebP.
- Media filenames are `FA Image <timestamp>` or `FA Video <timestamp>`, with no extension.
- The destination must stay open. After refreshing it, navigating away, or reloading the extension, check and set the destination again as needed.
- Only supported image and video elements are detected. CSS backgrounds, canvas-rendered content and cross-origin embedded players are outside the current selection scope.
- Turning off auto-prepare stops preparation but does not revoke previously granted website permissions. You can revoke those in browser extension settings.
- The canvas's existing format, size, account and upload restrictions still apply. Check the canvas before manually retrying an uncertain delivery to avoid duplicates.

If something fails, report the page URL, the steps you took, and a screenshot of the message.


## Standalone development

This repository is independent of Inkloom. Its root contains `manifest.json` and can be loaded as an unpacked extension. Node.js 20 or later is required.

```sh
npm ci
npm test
npm run build
npm run package
```

The package command builds the local catalogs and remux bundle, then writes `dist/Forge-Anywhere-v1.0.5.zip` with one `Forge-Anywhere/` folder. Tests, fixtures, development dependencies, and Git history are excluded. The npm `private` flag prevents accidental npm publishing; it does not control GitHub repository visibility.

The generated video fixture is committed, so tests do not require FFmpeg or Inkloom assets. See [fixtures/README.md](fixtures/README.md) for optional regeneration instructions. Keep the bundled third-party license and notice when distributing the extension. Loading from a different directory may assign a new extension ID and require setting preferences, permissions, and the destination again.
