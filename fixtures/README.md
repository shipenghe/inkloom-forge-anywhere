# Remux test fixture

`remux-sample.mp4` is a generated 15-second test pattern with a 440 Hz sine wave, AVC video and AAC audio. It contains no webpage media, product assets or user data.

The sample is committed so `npm test` needs only Node.js and the installed dependencies. FFmpeg is needed only to regenerate it:

```sh
node scripts/generate-test-fixture.mjs
# Or: node scripts/generate-test-fixture.mjs /path/to/ffmpeg
```

The video has 24 frames per second and a 300-frame GOP. The long GOP deliberately exercises clipping from the next available keyframe near 00:12.5.
