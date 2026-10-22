# The Wedding Wardrobe

A website where couples design a wedding gown and a suit side by side, check that the two outfits match, get typical weather for their venue and date, and copy a brief for their designer or a prompt for image generation.

- `index.html` — the whole front end (no build step).
- `server.js` — a small Node.js server with no dependencies. It serves the site and the weather API at `/api/weather`.
- `render.yaml` — a Render Blueprint, so Render can set everything up for you.

## Run it on your computer

You need Node.js 18 or newer.

```bash
npm start
```

Then open http://localhost:3000.

## Deploy on Render

1. Create a new GitHub repository and upload everything in this folder (keep the folder structure).
2. In Render, choose **New → Blueprint**, connect the repository and confirm. Render reads `render.yaml` and creates the web service.
   - Or choose **New → Web Service**, pick the repository, and set **Build command** to `npm install` and **Start command** to `npm start`.
3. When the deploy finishes, open the `.onrender.com` address Render gives you.
4. Optional: add your own domain under **Settings → Custom Domains**.

The free Render plan sleeps after a period of inactivity, so the first visit after a quiet spell can take up to a minute. A paid instance stays awake.

## Weather data

Weather comes from [Open-Meteo](https://open-meteo.com/):

- If the wedding is within 15 days, the site shows the live forecast for that day.
- Further ahead, it averages the last 10 years of real measurements for the week around the date: daytime high, evening temperature, night low, humidity, chance of rain and sunset.

**Important for selling:** Open-Meteo's free API is for non-commercial use only. Before charging customers, buy an Open-Meteo API plan and set `OPEN_METEO_API_KEY` in Render (**Environment** tab). The server then switches to Open-Meteo's commercial servers automatically. Keep the "Weather data by Open-Meteo.com" credit in the footer (CC BY 4.0).

## Environment variables

| Name | Required | What it does |
| --- | --- | --- |
| `OPEN_METEO_API_KEY` | For commercial use | Uses Open-Meteo's paid API. |
| `ANTHROPIC_API_KEY` | No | If set, Claude writes the outfit tips and local notes for each place. Without it, the site uses built-in tips based on the weather. |
| `ANTHROPIC_MODEL` | No | Claude model for those notes. Defaults to `claude-haiku-5-5`. |

## Good to know

- Designs, saved looks and wedding details are stored in each visitor's browser (localStorage). There are no accounts yet, so nothing is shared between devices.
- The weather API has a simple limit of 20 lookups per minute per visitor, and results are cached in memory to keep the site fast.
- Natural next steps for a paid product: user accounts with saved designs, payments, an admin page, and built-in image generation from an uploaded photo.
