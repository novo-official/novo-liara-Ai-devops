# liara-agent-demo

A deliberately tiny Next.js app for the first controlled Liara deployment.

* no database, no external secrets, no paid integrations, no background workers, no persistent storage
* `/` renders a fixed page (marker text `liara-agent-demo v1`)
* `/health` returns exactly `{"status":"ok","app":"liara-agent-demo","version":"1"}`
* needs no environment variables; listens on the platform default port (3000)

It is repository-owned and trusted. It is NOT deployed by Phase 2A.

`public/robots.txt` is intentionally present: Liara's Next.js build copies `app/public` into the image and fails with `COPY failed: stat app/public: file does not exist` when the directory is missing. Keep at least one real file in `public/`.
