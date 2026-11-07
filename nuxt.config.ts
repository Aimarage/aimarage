export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  telemetry: false,
  devServer: { host: 'localhost', port: 3210 },
  modules: [
    '@nuxtjs/i18n',
  ],
  css: ['~/assets/css/fonts.css', '~/assets/css/main.css'],
  typescript: {
    strict: true,
    typeCheck: false,
  },
  app: {
    head: {
      htmlAttrs: { lang: 'de' },
      title: 'Aimarage',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'color-scheme', content: 'light dark' },
        { name: 'referrer', content: 'no-referrer' },
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'theme-color', content: '#1a2433' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
      ],
    },
  },
  i18n: {
    defaultLocale: 'de',
    strategy: 'no_prefix',
    locales: [
      { code: 'de', language: 'de-AT', name: 'Deutsch', file: 'de.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
    detectBrowserLanguage: false,
    compilation: { strictMessage: false },
  },
  routeRules: {
    '/**': {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      },
    },
  },
  nitro: {
    experimental: { tasks: false },
    externals: { external: ['@electric-sql/pglite'] },
  },
  vite: {
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    plugins: [
      {
        name: 'scan-nuxt-virtuals',
        enforce: 'pre',
        resolveId(id, _importer, options) {
          if ((options as { scan?: boolean } | undefined)?.scan && id === '#components') return { id, external: true }
        },
      },
    ],
  },
})
