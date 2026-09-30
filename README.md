# Planta Sala

Real-time classroom seat allocation. The teacher starts a placement round; each student opens the site, enters a name, and picks a desk.

## How it works

1. **Teacher** chooses *Teacher*, enters the number of students, and starts placement.
2. **Students** each open the site on their device, choose *Student*, enter their name, and tap a desk.
3. If **one** student picks a desk, that seat is assigned and their name appears on it.
4. If **several** students pick the same desk, those students pick again among the desks that are still free.
5. Rounds repeat until everyone is seated or no desks remain.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) on the teacher device and on each student device (same Wi‑Fi / network). For phones on the same network, use your computer’s LAN IP instead of `localhost`, e.g. `http://192.168.1.10:3000`.
