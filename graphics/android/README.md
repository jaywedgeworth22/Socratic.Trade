# Future Android launcher mark

`ic_launcher_foreground.png` is the 1024 RGBA candlestick ST.  The transparent
canvas is on purpose so an adaptive icon can sit on its own background layer.

Do not flatten this file onto white.  Rebuild with:

```bash
node scripts/generate-favicon-st.mjs
```

The iOS App Icon (`AppIcon-1024.png`) stays a separate opaque 1024 asset.
App Store Connect shows that binary icon after the next TestFlight upload.
