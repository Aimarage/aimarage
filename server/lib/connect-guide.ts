export interface ConnectGuide {
  steps: string[]
  links: string[]
  needsApp: boolean
  httpsOnly?: boolean
}

export const CONNECT_GUIDES: Record<string, ConnectGuide> = {
  bluesky: {
    needsApp: false,
    links: ['https://bsky.app/settings/app-passwords'],
    steps: ['In Bluesky ein App-Passwort anlegen (Einstellungen > Datenschutz und Sicherheit > App-Passwörter, Direktnachrichten nicht erlauben).', 'Im Projekt unter Konten bei Bluesky "Verbinden" klicken, Handle und App-Passwort eintragen.'],
  },
  mastodon: {
    needsApp: false,
    links: ['https://<instanz>/settings/applications/new'],
    steps: ['Auf der eigenen Instanz unter Einstellungen > Entwicklung > Neue Anwendung anlegen, Rechte nur write:statuses, write:media, read:accounts.', 'Anwendung öffnen, Zugangstoken kopieren.', 'Im Projekt unter Konten bei Mastodon "Verbinden" klicken, Instanz und Token eintragen.'],
  },
  meta: {
    needsApp: true,
    links: ['https://help.instagram.com/502981923235522', 'https://developers.facebook.com/apps/creation/'],
    steps: ['Instagram auf Business- oder Creator-Konto umstellen und mit einer Facebook-Seite verknüpfen (Instagram > Einstellungen > Kontotyp und Tools).', 'Auf developers.facebook.com eine App anlegen (Anwendungsfall Instagram/Facebook-Seiten bzw. Facebook Login for Business). Entwicklungsmodus reicht.', 'Unter Facebook Login > Einstellungen die Weiterleitungs-Adresse aus dem Tool eintragen.', 'App-ID und App-Geheimnis (App-Einstellungen > Allgemein) in Aimarage unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=meta) eintragen und speichern.', 'Im Projekt unter Konten bei Instagram "Verbinden" klicken und bei Facebook alle passenden Seiten und das Instagram-Konto anhaken.'],
  },
  instagram: {
    needsApp: true,
    httpsOnly: true,
    links: ['https://help.instagram.com/502981923235522', 'https://developers.facebook.com/apps/'],
    steps: [
      'Instagram-Konto auf Business oder Creator umstellen (Instagram > Einstellungen > Kontotyp und Tools). Eine Facebook-Seite ist nicht nötig.',
      'Auf developers.facebook.com die Meta-App öffnen (oder anlegen) und den Anwendungsfall "Nachrichten und Inhalte auf Instagram verwalten" hinzufügen. Entwicklungsmodus reicht.',
      'In der App: Instagram > API-Einrichtung mit Instagram-Login. Unter "Instagram-Tester hinzufügen" (App-Rollen > Rollen > Instagram-Tester) das Instagram-Konto eintragen und die Einladung in Instagram annehmen (Einstellungen > Website-Berechtigungen > Apps und Websites > Einladungen von Testern).',
      'Unter "3. Instagram-Unternehmens-Login einrichten" > Business-Login-Einstellungen bei den OAuth-Weiterleitungs-URIs die Weiterleitungs-Adresse aus Aimarage eintragen (Zeichen für Zeichen gleich, Meta verlangt https).',
      'Dort stehen auch die Instagram-App-ID und der Instagram-App-Geheimcode (nicht die Facebook-App-ID). Beide in Aimarage unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=instagram) bei "Instagram (ohne Facebook)" eintragen, Weiterleitungs-Adresse prüfen, speichern.',
      'Im Projekt unter Konten bei Instagram "Bei Instagram anmelden" klicken, mit dem Instagram-Konto einloggen und erlauben. Landet der Browser auf einer Seite, die nicht lädt: die ganze Adresse aus der Adresszeile ins Feld darunter kopieren.',
      'Posten braucht Bild (JPG) oder Video, nur Text geht nicht. Die Datei muss öffentlich erreichbar sein, also Aimarage auf dem Server mit öffentlicher https-Adresse. Der Zugang gilt 60 Tage und wird täglich automatisch erneuert.',
    ],
  },
  threads: {
    needsApp: true,
    links: ['https://developers.facebook.com/apps/'],
    steps: ['In der Meta-App den Anwendungsfall "Threads-API" hinzufügen.', 'Threads verlangt eine https-Weiterleitungs-Adresse: eigene Website-Adresse eintragen und im Tool dieselbe Adresse eintragen.', 'Threads-App-ID und -Geheimnis unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=threads) eintragen, dann im Projekt unter Konten verbinden, danach die Adresse aus der Adresszeile ins Feld "Adresse nach der Freigabe" kopieren.', 'Text geht überall. Bilder (JPG, PNG), Videos und Karussells bis 20 Dateien holt Threads selbst ab, die Dateien müssen also öffentlich erreichbar sein (Aimarage auf dem Server mit öffentlicher https-Adresse).'],
  },
  linkedin: {
    needsApp: true,
    links: ['https://www.linkedin.com/developers/apps/new'],
    steps: ['Auf linkedin.com/developers eine App anlegen (Unternehmensseite als Besitzer nötig).', 'Produkte "Sign In with LinkedIn using OpenID Connect" und "Share on LinkedIn" hinzufügen.', 'Unter Auth die Weiterleitungs-Adresse aus dem Tool eintragen.', 'Client ID und Client Secret unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=linkedin) eintragen, dann im Projekt unter Konten verbinden. Zugang gilt 60 Tage.'],
  },
  x: {
    needsApp: true,
    links: ['https://developer.x.com/en/portal/dashboard'],
    steps: ['Einmalig auf developer.x.com ein Developer-Konto anlegen, Projekt und App erstellen und Pay-per-use-Guthaben aufladen (pro Post ca. 0,015 $, mit Link ca. 0,20 $).', 'In der App unter User authentication settings: App permissions "Read and write", Type of App "Web App, Automated App or Bot", als Callback URI die Weiterleitungs-Adresse aus dem Tool (z.B. http://localhost:3210/api/connect/x/callback) und eine Website-Adresse eintragen.', 'Unter Keys and tokens die OAuth 2.0 Client ID und das Client Secret kopieren und in Aimarage unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=x) bei X eintragen.', 'Im Projekt unter Konten bei X "Mit X anmelden" klicken. Mit derselben App lassen sich beliebig viele X-Konten verbinden; Bilder laufen ebenfalls über OAuth 2.0 (Recht media.write).', 'Lehnt X "localhost" ab: bei X und im Tool http://127.0.0.1:3210/api/connect/x/callback eintragen und nach der Freigabe die Adresse aus der Adresszeile ins Feld unter "Mit X anmelden" kopieren.', 'Fallback ohne Anmeldung: unter "Mehr" API Key + Secret und Access Token + Secret des eigenen Kontos eintragen (OAuth 1.0a).'],
  },
  youtube: {
    needsApp: true,
    links: ['https://console.cloud.google.com/apis/library/youtube.googleapis.com'],
    steps: [
      'Nutzt denselben Google-Zugang wie die Search Console (Einstellungen > Plattform-Zugänge > Google, /einstellungen/apps?app=google). Upload-Post (US-Dienst) ist nur die Alternative.',
      'In console.cloud.google.com im selben Projekt die "YouTube Data API v3" aktivieren.',
      'Google Auth Platform > Datenzugriff: Bereiche youtube.upload und youtube.readonly hinzufügen; unter Zielgruppe den Kanal-Besitzer als Testnutzer eintragen und die App veröffentlichen (sonst läuft der Zugang nach 7 Tagen ab). Hinweis "nicht überprüft" mit Erweitert > Weiter bestätigen.',
      'Im Projekt unter Konten bei YouTube "Bei Google anmelden (YouTube)" klicken und den Kanal wählen.',
      'Posten: ein Video je Beitrag, Titel aus "Videotitel" (sonst erste Zeile), Hashtags als Tags, hochkant bis 3 Minuten wird ein Short. Etwa 100 Uploads pro Tag.',
    ],
  },
  telegram: {
    needsApp: false,
    links: ['https://t.me/BotFather'],
    steps: [
      'Hinweis vorab: Ein Telegram-Kanal bringt keine Reichweite für Neukunden, er ist gut für bestehende Fans und Kunden, die den Kanal abonnieren.',
      'Falls noch kein Kanal da ist: in Telegram oben auf den Stift bzw. "Neuer Kanal" tippen, Name vergeben, auf "Öffentlich" stellen und eine Adresse wählen (t.me/kanalname).',
      'In Telegram den Chat mit @BotFather öffnen (Link unten), /newbot senden, einen Namen (z.B. Aimarage) und einen Benutzernamen, der auf "bot" endet (z.B. meinkanal_aimarage_bot), eingeben.',
      'BotFather antwortet mit einem Bot-Token (Form 123456789:ABC...). Das ist ein Passwort: nur in Aimarage eintragen, nirgends sonst weitergeben.',
      'Im Kanal: Kanalname antippen > Administratoren > Administrator hinzufügen > den eben angelegten Bot suchen und hinzufügen. Das Recht "Nachrichten veröffentlichen" muss an sein, alle anderen Rechte können aus.',
      'In Aimarage im Projekt unter Konten bei Telegram "Verbinden" klicken, Bot-Token und Kanal (@kanalname oder bei privaten Kanälen die Chat-ID, z.B. -1001234567890) eintragen. Aimarage prüft sofort, ob der Bot Admin mit Posting-Recht ist.',
      'Gepostet wird Text (bis 4096 Zeichen) oder Bild mit Bildunterschrift (bis 1024 Zeichen). Die Bilder werden direkt hochgeladen, das klappt auch lokal. Gezählt wird nur die Zahl der Abonnenten, Aufrufe je Beitrag liefert Telegram Bots nicht.',
    ],
  },
  bing: {
    needsApp: false,
    links: ['https://www.bing.com/webmasters/'],
    steps: ['Bing Webmaster Tools (bing.com/webmasters) öffnen und anmelden, die Websites müssen dort bestätigt sein (Import aus der Google Search Console reicht).', 'Rechts oben Einstellungen (Zahnrad) > API-Zugriff > Nutzungsbedingungen bestätigen > API-Schlüssel > Generieren. Ein Schlüssel gilt für alle Websites im Bing-Konto.', 'Den Schlüssel in Aimarage unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=bing) bei Bing Webmaster Tools eintragen und speichern.', 'Aimarage ordnet jedem Projekt seine Website in Bing selbst zu (sonst Auswahl unter Berichte > Suche > Bing) und holt Suchbegriffe, Seiten und Verlauf täglich.'],
  },
  reddit: {
    needsApp: true,
    links: ['https://www.reddit.com/prefs/apps'],
    steps: ['Nur lesen: Der Agent sucht damit selbst passende Threads, gepostet wird auf Reddit weiterhin von Hand.', 'Auf reddit.com/prefs/apps "create another app" klicken, Typ "script" (oder "web app"), Name z.B. Aimarage, Redirect-URI ist egal (z.B. http://localhost:3210).', 'Die ID unter dem App-Namen (Client-ID) und das Secret in Aimarage unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=reddit) bei Reddit eintragen, dazu den eigenen Reddit-Benutzernamen (für die Kennung gegenüber Reddit).'],
  },
  tiktok: {
    needsApp: true,
    links: ['https://developers.tiktok.com/apps/'],
    steps: ['In der TikTok-Entwickler-App (Login Kit + Content Posting API) Client Key und Client Secret ablesen.', 'Unter Einstellungen > Plattform-Zugänge (/einstellungen/apps?app=tiktok) eintragen, Weiterleitungs-Adresse genau wie in der App (https, z.B. die eigene Website).', 'Im Projekt unter Konten verbinden, bei TikTok freigeben, danach die ganze Adresse aus der Adresszeile ins Feld "Adresse nach der Freigabe" kopieren.', 'Nur Videos. Ohne geprüfte App sind Posts nur privat sichtbar.'],
  },
}

export const HTTPS_REDIRECT_NOTE = 'Meta nimmt hier nur https-Adressen an, http://localhost wird abgelehnt. Entweder Aimarage auf dem Server (öffentliche https-Adresse) betreiben und dort verbinden, oder lokal eine beliebige eigene https-Adresse als Weiterleitungs-Adresse eintragen (z.B. https://aimarage.com/api/connect/instagram/callback, in Meta und in Aimarage gleich) und nach dem Erlauben die ganze Adresse aus der Adresszeile in Aimarage ins Feld unter "Bei Instagram anmelden" kopieren. Ein Tunnel (z.B. cloudflared) geht auch.'

export function diagnose(error: string | null | undefined): string | null {
  if (!error) return null
  const e = error.toLowerCase()
  if (e.includes('öffentlich erreichbar')) return 'Instagram holt Bilder und Videos selbst von einer Adresse ab. Auf localhost geht das nicht: Aimarage auf dem Server mit öffentlicher https-Adresse betreiben (APP_URL bzw. PUBLIC_URL).'
  if (e.includes('nur jpg')) return 'Instagram nimmt nur JPG-Bilder. Bild als JPG speichern und neu hochladen.'
  if (e.includes('keine facebook-seite')) return 'Instagram ist kein Business-/Creator-Konto, nicht mit einer Facebook-Seite verknüpft, oder die Seite wurde beim Verbinden nicht angehakt. Konto umstellen bzw. verknüpfen und neu verbinden.'
  if (e.includes('redirect') || e.includes('url blocked') || e.includes('weiterleitung') || e.includes('redirect_uri')) return 'Die Weiterleitungs-Adresse in der Entwickler-App stimmt nicht genau mit der im Tool überein (Zeichen für Zeichen, inkl. https und Schrägstrich am Ende).'
  if (e.includes('telegram') && e.includes('kein admin')) return 'Der Bot muss im Telegram-Kanal Administrator sein, mit dem Recht "Nachrichten veröffentlichen". Kanal > Administratoren > Bot hinzufügen bzw. Recht einschalten, dann neu prüfen.'
  if (e.includes('telegram') && e.includes('bot-token')) return 'Das Bot-Token stimmt nicht oder wurde bei @BotFather neu erzeugt. Bei @BotFather mit /mybots > Bot > API Token das aktuelle Token holen und neu verbinden.'
  if (e.includes('telegram') && e.includes('nicht gefunden')) return 'Kanal nicht gefunden: @kanalname prüfen (öffentlicher Kanal) bzw. bei privaten Kanälen die Chat-ID verwenden, und den Bot zuerst als Admin in den Kanal holen.'
  if (e.includes('app-passwort')) return 'Handle oder App-Passwort stimmt nicht. Ein neues App-Passwort anlegen und eintragen (nicht das normale Passwort).'
  if (e.includes('abgelaufen') || e.includes('expired') || e.includes('session has expired') || e.includes('invalid oauth')) return 'Der Zugang ist abgelaufen oder wurde entzogen. Einfach neu verbinden.'
  if (e.includes('unlesbar')) return 'Der gespeicherte Zugang kann nicht mehr entschlüsselt werden (Hauptschlüssel geändert). Neu verbinden.'
  if (e.includes('x:') && (e.includes('403') || e.includes('forbidden'))) return 'Die X-App hat keine Schreibrechte oder kein Guthaben. Rechte auf "Read and write" stellen, danach neu mit X anmelden (bzw. Access Token neu erzeugen), Guthaben prüfen.'
  if (e.includes('401')) return 'Schlüssel oder Token abgelehnt. Werte neu kopieren (ohne Leerzeichen) oder neu verbinden.'
  if (e.includes('app-id') || e.includes('app-schlüssel')) return 'Zuerst App-ID und App-Geheimnis unter Einstellungen > Plattform-Zugänge (/einstellungen/apps) speichern.'
  return null
}
