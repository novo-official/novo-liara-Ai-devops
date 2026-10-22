# liara-agent-demo

A deliberately tiny Next.js app for the first controlled Liara deployment.

* no database, no external secrets, no paid integrations, no background workers, no persistent storage
* `/` renders a fixed page (marker text `liara-agent-demo v1`)
* `/health` returns exactly `{"status":"ok","app":"liara-agent-demo","version":"1"}`
* needs no environment variables; listens on the platform default port (3000)

It is repository-owned and trusted. It is NOT deployed by Phase 2A.
