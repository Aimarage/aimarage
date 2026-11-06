# Aimarage

[English](#english) | [Deutsch](#deutsch)

## English

Aimarage is an AI marketing agent for small teams. Per project it plans goals, strategy and channels, puts tasks in a calendar, writes drafts every day (posts, articles, replies) and evaluates results. You review and approve. It only posts or sends through accounts you connect yourself, and only with the main switch turned on.

### What it does

- SEO check every Monday on up to 30 pages of your website: broken links, titles, meta descriptions, headings, alt texts, thin content, hreflang, canonical, load time. Each kind of finding becomes a task with a ready-to-copy brief, e.g. for Claude Code via MCP.
- Reports with search numbers (Google Search Console, Bing Webmaster Tools), visitors per source (UTM) and AI visibility: is your project named when AI models are asked typical questions?
- Publishes approved articles to your website: via its own small PHP blog [aimarage-blog](https://github.com/Aimarage/aimarage-blog), WordPress, Webflow or Git (Markdown with frontmatter for static sites like Astro or Hugo, on GitHub or GitLab).

This is the self-hosted edition for your own use: one workspace, one sign-in, you run it on your computer or server and enter all keys yourself. Prefer not to run anything? The hosted version with all services included is at https://aimarage.com.

### Install with Docker Compose

Requirement: Docker with Compose.

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, SEED_EMAIL and SEED_PASSWORD in .env
docker compose up -d --build
```

Open http://localhost:3210 and sign in with `SEED_EMAIL` / `SEED_PASSWORD` (the account is created on first start; without `SEED_PASSWORD` a random password is printed once in `docker compose logs app`). Then add your AI key under Settings > AI and create your first project. English interface: `SEED_LOCALE=en`.

Stop: `docker compose down` (data stays in the volumes `pgdata` and `appdata`). Update: pull the new version, then `docker compose up -d --build`.

Aimarage only listens on `127.0.0.1`. For access from outside, put a reverse proxy with https in front (e.g. Caddy) and set `APP_URL=https://...`, `SECURE_COOKIES=true`, `TRUST_PROXY=true`.

### Keys

| Service | Used for | Where |
|---|---|---|
| Anthropic or another OpenAI-compatible AI provider | Agent, drafts, strategy (required) | Settings > AI, or `LLM_*` in `.env` |
| Brave Search API | Web search: threads, mentions, directories, web results for AI visibility (optional) | Settings > Platform access |
| Google Search Console (own Google app), Bing Webmaster Tools | Search numbers in reports (optional) | Settings > Platform access |
| Blog: aimarage-blog token, WordPress, Webflow or GitHub/GitLab token | Publishing articles (optional) | Project > Settings > Publish articles |
| Zernio or Upload-Post | Posting to Instagram, Facebook, LinkedIn, X, TikTok, YouTube (optional) | Project > Accounts, or `ZERNIO_API_KEY` |
| Your own platform apps (Meta, LinkedIn, X, Google ...) | Connect directly instead of via Zernio (optional) | Settings > Platform access |
| Bluesky, Mastodon, Telegram | Posting (optional) | Project > Accounts |
| SMTP | Sign-in codes, morning mail, notices (optional) | `SMTP_URL`, `MAIL_FROM` |
| IMAP/SMTP per project | Read the mailbox and send replies (optional) | Project > Mailbox |
| S3-compatible storage | Media files instead of the local volume (optional) | `STORAGE_DRIVER=s3`, `S3_*` |

Credentials are stored encrypted in the database. Keep the master key safe (`APP_SECRET` or `data/app-secret` in the `appdata` volume): if it is lost, credentials have to be entered again.

### Development

Node 22.22 or newer: `npm install`, `npm run dev` (uses an embedded database if `DATABASE_URL` is empty), `npm test`.

### License

Aimarage is fair code, not open source, under the [Sustainable Use License](LICENSE). You may use and modify it for your own internal business purposes or privately. You may not host it for others or offer it as a service, sell or resell it, or distribute it under another name (white-label).

## Deutsch

Aimarage ist ein KI-Marketing-Agent für kleine Teams: Er plant je Projekt Ziele, Strategie und Kanäle, legt Aufgaben in den Kalender, schreibt jeden Tag Entwürfe und wertet Ergebnisse aus. Du prüfst und gibst frei.

Was es kann:

- SEO-Prüfung jeden Montag auf höchstens 30 Seiten der Website: kaputte Links, Seitentitel, Meta-Beschreibung, Überschriften, alt-Texte, wenig Text, hreflang, Canonical, Ladezeit. Jede Fund-Art wird eine Aufgabe mit kopierfertigem Auftrag, z.B. für Claude Code über MCP.
- Berichte mit Suche (Google Search Console, Bing Webmaster Tools), Besuchern je Quelle (UTM) und KI-Sichtbarkeit: Wird dein Projekt genannt, wenn man KI-Modellen typische Fragen stellt?
- Veröffentlicht freigegebene Artikel auf der Website: über das eigene kleine PHP-Blog [aimarage-blog](https://github.com/Aimarage/aimarage-blog), WordPress, Webflow oder Git (Markdown mit Frontmatter für statische Seiten wie Astro oder Hugo, auf GitHub oder GitLab).

Diese Version ist zum Selbst-Installieren für den Eigengebrauch: ein Arbeitsbereich, eine Anmeldung, alle Schlüssel trägst du selbst ein. Die gehostete Version mit allen Diensten gibt es unter https://aimarage.com.

Installation:

```bash
cp .env.example .env
# in .env POSTGRES_PASSWORD, SEED_EMAIL und SEED_PASSWORD eintragen
docker compose up -d --build
```

Dann http://localhost:3210 öffnen, mit `SEED_EMAIL` / `SEED_PASSWORD` anmelden, unter Einstellungen > KI den KI-Schlüssel eintragen und das erste Projekt anlegen. Welche Schlüssel wofür nötig sind, steht oben in der Tabelle "Keys".

Lizenz: Fair Code (kein Open Source) unter der [Sustainable Use License](LICENSE). Erlaubt ist die Nutzung und Anpassung für eigene interne Zwecke oder privat. Nicht erlaubt: für andere hosten oder als Dienst anbieten, verkaufen oder weiterverkaufen, unter anderem Namen weitergeben (White-Label).
