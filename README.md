# ICC Color Explorer

A small local app for exploring Lab or CMYK colors through a CMYK ICC profile. It uses macOS ColorSync for profile conversion, reports profile-derived Lab and Delta E 2000, and uses sRGB previews for browser display. Profiles can be selected from ColorSync folders or dropped into the app as `.icc` / `.icm` files.

## Run

```sh
node server.js
```

Then open:

```text
http://127.0.0.1:4173
```

The app lists CMYK-like profiles from the system ColorSync folders. You can also paste a full path to another local `.icc` or `.icm` profile.
