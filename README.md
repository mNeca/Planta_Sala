# Planta Sala

Real-time classroom seat allocation. The teacher opens a room and shares a code; each student joins on their device, enters a name, and picks a desk.

Runs as a static site (no Node server) — suitable for **GitHub Pages**. Sync uses peer-to-peer (PeerJS); the teacher’s browser hosts the session.

## How it works

1. **Teacher** chooses *Teacher*, shares the room code (or invite link), enters the number of students, and starts placement. **Keep the teacher tab open.**
2. **Students** open the site, choose *Student*, enter the room code and their name, then tap a desk.
3. If **one** student picks a desk, that seat is assigned and their name appears on it.
4. If **several** students pick the same desk, those students pick again among the desks that are still free.
5. Rounds repeat until everyone is seated or no desks remain.

## GitHub Pages

After you push to `main`, the workflow in `.github/workflows/deploy-pages.yml` publishes the `public/` folder.

1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Push to `main` (or run the workflow manually)
3. Open `https://<user>.github.io/Planta_Sala/`

## Run locally

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). Teacher and students can use different devices; they only need the shared room code (and the teacher tab must stay open).
