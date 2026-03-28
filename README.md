# VidSrc Stremio Addon

Small standalone Stremio addon that:

- accepts Cinemeta/Stremio movie IDs like `tt0169547`
- accepts Cinemeta/Stremio series episode IDs like `tt0944947:1:1`
- resolves IMDb -> TMDB when needed
- extracts Cloudnestra HLS masters from VidSrc embed pages
- returns separate HLS stream entries for the qualities exposed by the live master playlist
- refreshes source links on each playback request instead of reusing old proxy URLs

## Run

```bash
cd stremio-vidlink-addon
npm install
npm start
```

Then open:

```text
http://127.0.0.1:7005/manifest.json
```

Install that manifest in Stremio alongside Cinemeta. When Stremio asks for
`/stream/movie/tt....json` or `/stream/series/tt....:season:episode.json`,
the addon resolves the IMDb id internally and returns VidSrc quality entries.

## GitHub

This folder is ready to be its own GitHub repo.

Important:

- Stremio cannot install an addon directly from a GitHub repo page.
- You need to host the addon and give Stremio the hosted `manifest.json` URL.
- Example hosted URL:
  `https://your-domain.example/manifest.json`

Next steps:

1. Put `stremio-vidlink-addon` in its own GitHub repo.
2. Deploy it to Render.
3. Install the hosted manifest URL in Stremio.

Fastest path:

- create a new GitHub repo
- upload only the `stremio-vidlink-addon` folder contents
- connect that repo to Render as a Web Service
- after deploy, use:
  `https://your-render-service.onrender.com/manifest.json`

Important:

- do not install from GitHub directly
- install from the hosted `manifest.json` URL only

Repo tree:

```text
stremio-vidlink-addon/
├── .dockerignore
├── .gitignore
├── Dockerfile
├── README.md
├── index.js
├── package.json
└── render.yaml
```

## Deploy

Docker:

```bash
cd stremio-vidlink-addon
docker build -t stremio-vidlink-addon .
docker run -p 7005:7005 stremio-vidlink-addon
```

Then use:

```text
http://127.0.0.1:7005/manifest.json
```

Render:

- Push this folder as its own GitHub repo.
- Create a new Web Service on Render.
- Render will use `render.yaml` automatically.
- Your install URL will be:
  `https://your-render-service.onrender.com/manifest.json`

## Notes

- `TMDB_API_KEY` can be overridden with an environment variable.
- Stream entries point to local `/play/...` routes, and those routes resolve fresh VidSrc links every time before redirecting.
- The live quality ladder depends on what Cloudnestra exposes for that title. Some items may only return `720p` and `360p`.
- `GET /health` returns a simple health response for hosting platforms.
