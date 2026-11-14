# Forge Anywhere · v1.0.12

Send inspiration to your canvas. Send images and videos from webpages to an open Forge or Tusi canvas.

## Install

1. Open the [latest GitHub release](https://github.com/shipenghe/inkloom-forge-anywhere/releases/latest). Download `Forge-Anywhere-v1.0.12.zip` from Assets, then extract it and keep the `Forge-Anywhere` folder on your computer.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the extracted `Forge-Anywhere` folder. Pin the extension to your toolbar for easy access.

To update, replace the files in your existing extension folder with the new package, then click **Reload** on the extension management page. Refresh media pages and set your destination canvas again. The extension is installed locally and is not currently listed in the Chrome Web Store.

Setting the destination again checks and updates the canvas connection script. Old connections cannot handle new-version imports. Updating does not rearrange existing nodes; pan to an empty area before the first import to start a new row layout there.

## Send media

1. Sign in to Forge or Tusi and open a workflow canvas. Open Forge Anywhere and choose **Set destination**. Keep the canvas tab open.
2. Switch to a webpage. Right-click an image or a video and choose **Send to canvas**. If the site has its own right-click menu, click the Forge icon that appears at the top-right of the media after right-clicking it.
3. Allow access to the required source if prompted. Check the canvas for the new media. **Open** in the destination card takes you back to that canvas.

The Forge logo in the panel opens the [Forge homepage](https://forge.art/). Without a destination, the media context menu and the icon shown after right-clicking open Forge instead. Set a destination to send media; earlier clicks are not automatically replayed.

If no entry appears, open the extension once on the media page, or use **Choose media** in its panel. An unplayed video thumbnail is treated as an image. Start the preview before right-clicking the card to send video. List previews may have lower resolution than the video on its playback page; open that page for higher quality or when the preview cannot be selected.

Translucent gradient overlays, including those on Pexels photos and video previews, are supported. Right-clicking keeps the site's own menu and shows the Forge icon. A decoded video preview over its cover is selected as video only when the hit stack confirms it is above that cover. Opaque covers and ambiguous overlaps are left unselected.

The panel keeps the latest media preview and its selected, sending, sent, or failed state in one card. **Sent** means the file was handed to the canvas and handling was detected. Uploading and saving still depend on the canvas; check its result before retrying.

## Placement

Consecutive imports fill rows of 10 images or videos. The 11th starts a new row. The first import starts at the current viewport center. Each row is top-aligned, with an 80-unit gap after each node's display width. New rows return to the starting horizontal position and begin 80 units below the tallest node in the previous row, including its title. Bounds follow the canvas's current equal-area preview sizing and maximum-side limit; unreadable dimensions reserve the maximum bounds. Panning and zooming preserve the row layout's canvas positions. Setting the destination again starts a new layout.

The rows can overlap existing nodes or extend beyond the visible viewport. Zoom out or pan to see the whole row. Transfers rejected before handoff do not consume a position. An uncertain handoff keeps its position reserved in case the upload completes later.

## Videos

**Auto-prepare video** is on by default. Website access is declared at installation; you can turn preparation off in the panel, and that choice is remembered. Refresh video pages that were already open. Then play normally and right-click to send. The extension first tries to obtain a full video file; for supported segmented players it can instead assemble a prepared clip.

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
- Website access is declared at installation. Turning off auto-prepare stops preparation but does not revoke website permissions. You can revoke those in browser extension settings.
- The canvas's existing format, size, account and upload restrictions still apply. Check the canvas before manually retrying an uncertain delivery to avoid duplicates.

If something fails, report the page URL, the steps you took, and a screenshot of the message.


## Standalone development

This is the sole maintenance repository for Forge Anywhere. Inkloom contains no plugin copy, compatibility symlink, or custom receiver code. Its root contains `manifest.json` and can be loaded as an unpacked extension. Node.js 20 or later is required.

```sh
npm ci
npm test
npm run build
npm run package
```

The package command builds the local catalogs and remux bundle, then writes `dist/Forge-Anywhere-v1.0.12.zip` with one `Forge-Anywhere/` folder. Tests, fixtures, development dependencies, and Git history are excluded. The npm `private` flag prevents accidental npm publishing; it does not control GitHub repository visibility.

The generated video fixture is committed, so tests do not require FFmpeg or Inkloom assets. See [fixtures/README.md](fixtures/README.md) for optional regeneration instructions. Keep the bundled third-party license and notice when distributing the extension. Loading from a different directory may assign a new extension ID and require setting preferences, permissions, and the destination again.
