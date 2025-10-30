/**
 * Rozee.pk job board scraper — HTTP-only (no Playwright/Puppeteer)
 * Stack: Apify SDK, Crawlee (CheerioCrawler), gotScraping (HTTP/2 + header generator),
 * linkedom (DOM fallback), cheerio, robust pagination, JSON/LD extraction.
 *
 * Notes:
 * - Ensures ESM + entrypoint actually runs on Apify.
 * - Fails loudly if seeds are empty.
 * - Verbose logging so you can confirm it “touches” the site.
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { parseHTML } from 'linkedom';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

// ======= Configurable defaults (can be overridden by actor INPUT) =======
const DEFAULTS = {
  keyword: '',
  datePosted: 'all',
  results_wanted: 100,
  max_pages: 25,
  collectDetails: true,
  minDelayMs: 800,
  maxDelayMs: 1600,
};

function jitter(minDelayMs, maxDelayMs) {
  const min = Math.max(0, Number(minDelayMs) || 0);
  const max = Math.max(min, Number(maxDelayMs) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function toAbs(href, base = 'https://www.rozee.pk') {
  try { return new URL(href, base).href.split('#')[0]; } catch { return null; }
}

function looksLikeCfBlock($) {
  const t = ($('title').text() || '').toLowerCase();
  const b = ($('body').text() || '').toLowerCase();
  return t.includes('attention required') ||
         (b.includes('cloudflare') && (b.includes('checking your browser') || b.includes('verify you are a human')));
}

// Extract JobPosting from JSON/LD if available.
function extractFromJsonLd($) {
  const out = {};
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const json = JSON.parse($(s).contents().text());
      const blocks = Array.isArray(json) ? json : [json];
      for (const blk of blocks) {
        const t = blk['@type'] || blk.type;
        if (!t) continue;
        const types = Array.isArray(t) ? t : [t];
        if (types.map(x => String(x).toLowerCase()).includes('jobposting')) {
          out.title = out.title || blk.title || blk.name;
          out.company = out.company || blk.hiringOrganization?.name;
          out.location = out.location || blk.jobLocation?.address?.addressLocality || blk.jobLocation?.address?.addressRegion;
          out.salary = out.salary || blk.baseSalary?.value?.value || blk.baseSalary?.value;
          out.description = out.description || blk.description;
        }
      }
    } catch {}
  });
  return out;
}

async function fetchAndParse(url, session, extraHeaders = {}) {
  const resp = await gotScraping({
    url,
    http2: true,
    throwHttpErrors: false,
    headers: {
      'user-agent': session?.userData?.ua || 'Mozilla/5.0',
      'accept-language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
    cookieJar: session?.cookieJar,
    useHeaderGenerator: true,
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 110, httpVersion: '2' }],
      devices: ['desktop'],
      operatingSystems: ['windows'],
      locales: ['en-US'],
    },
  });

  const status = resp.statusCode || 0;
  const body = String(resp.body || '');

  // If they ever gate behind a JS bootstrap, this still gives you the markup JSON you can parse.
  const { document } = parseHTML(body);
  const html = document.documentElement.outerHTML;
  const $ = cheerioLoad(html);

  return { $, status, body };
}

function buildKeywordUrl(keyword) {
  if (keyword && keyword.trim()) {
    const slug = keyword.trim().toLowerCase().replace(/\s+/g, '-');
    return `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(slug)}`;
  }
  return 'https://www.rozee.pk/job/jsearch/q/all';
}

async function main() {
  // Read INPUT and merge defaults
  const inp = (await Actor.getInput()) || {};
  const input = { ...DEFAULTS, ...inp };

  const {
    keyword,
    datePosted,
    results_wanted: MAX_ITEMS_RAW,
    max_pages: MAX_PAGES_RAW,
    collectDetails,
    startUrl: startUrls = [],
    url,
    proxyConfiguration,
    minDelayMs,
    maxDelayMs,
  } = input;

  // Parse numbers safely
  const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : 999;
  const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 25;

  // Extra debug logs (so you see activity in Apify console)
  log.setLevel(log.LEVELS.DEBUG);
  log.info('Actor configuration', { keyword, datePosted, MAX_ITEMS, MAX_PAGES, collectDetails });

  // Build seeds
  const seeds = new Set();
  const kwUrl = buildKeywordUrl(keyword);
  seeds.add(kwUrl);
  if (Array.isArray(startUrls)) {
    startUrls.forEach((u) => { if (typeof u === 'string' && u.includes('rozee.pk')) seeds.add(u); });
  }
  if (typeof url === 'string' && url.includes('rozee.pk')) seeds.add(url);

  if (seeds.size === 0) {
    log.error('No seeds found. Provide a startUrl, url, or keyword.');
    throw new Error('Empty seeds — aborting.');
  }

  const proxyConf = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

  // Touch site root once to set cookies (helps with CF/proxies)
  try {
    const touchUrl = 'https://www.rozee.pk/';
    log.info(`Touching site for cookies: ${touchUrl}`);
    await gotScraping({ url: touchUrl, http2: true, throwHttpErrors: false, proxyUrl: proxyConf?.newUrl() });
  } catch (e) {
    log.warning(`Touch failed (continuing anyway): ${e.message}`);
  }

  let saved = 0;
  const failedUrls = [];
  const visitedPages = new Set(); // prevent infinite loops on pagination

  const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency: 2,
    maxRequestRetries: 7,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 15, sessionOptions: { maxUsageCount: 25 } },
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 90,

    preNavigationHooks: [
      async ({ request, session }, gotOptions) => {
        const ua = session?.userData?.ua ||
          (session.userData.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${110 + Math.floor(Math.random() * 20)}.0.0.0 Safari/537.36`);
        request.headers = {
          'user-agent': ua,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'upgrade-insecure-requests': '1',
        };
        gotOptions.http2 = true;
        gotOptions.decompress = true;
        gotOptions.cookieJar = session?.cookieJar;
        gotOptions.useHeaderGenerator = true;
        gotOptions.headerGeneratorOptions = {
          browsers: [{ name: 'chrome', minVersion: 110, httpVersion: '2' }],
          devices: ['desktop'],
          operatingSystems: ['windows'],
          locales: ['en-US'],
        };
        log.debug(`→ GET ${request.url}`);
        await sleep(jitter(minDelayMs, maxDelayMs));
      },
    ],

    requestHandler: async ({ request, $, enqueueLinks, response, session, log: clog }) => {
      const label = request.userData?.label || 'LIST';
      const pageNo = request.userData?.pageNo || 1;
      const status = response?.statusCode || 0;

      if (!response || [403, 429, 503].includes(status)) {
        session?.retire?.();
        throw new Error(`Blocked or empty page (${status})`);
      }

      if (!$) {
        clog.warning(`Empty DOM in cheerio, fetching with linkedom: ${request.url}`);
        const fp = await fetchAndParse(request.url, session);
        if (!fp.$) throw new Error('Fallback parse failed');
        $ = fp.$;
      }

      // ===== LIST PAGE =====
      if (label === 'LIST') {
        if (visitedPages.has(request.url)) {
          clog.debug(`Already visited list URL, skipping: ${request.url}`);
          return;
        }
        visitedPages.add(request.url);

        if (looksLikeCfBlock($)) throw new Error('Cloudflare block detected');

        // Try to extract job links from markup
        const jobLinks = new Set();
        $('#jobs h3 a[href]').each((_, el) => {
          const href = $(el).attr('href');
          const abs = toAbs(href, request.url);
          if (abs && abs.includes('/job/')) jobLinks.add(abs);
        });

        // BONUS: try to find JSON embedded on listing pages (common on JS frameworks)
        $('script').each((_, s) => {
          const txt = $(s).contents().text();
          if (!txt || txt.length < 50) return;
          // naive scan for URLs inside JSON blobs
          const m = txt.match(/https?:\/\/www\.rozee\.pk\/[^"']+/g);
          if (m) {
            for (const u of m) {
              if (u.includes('/job/')) jobLinks.add(toAbs(u));
            }
          }
        });

        clog.info(`Found ${jobLinks.size} job links on page ${pageNo}`, { sample: Array.from(jobLinks).slice(0, 5) });

        // Enqueue detail pages
        if (collectDetails && saved < MAX_ITEMS) {
          const toAdd = Array.from(jobLinks).slice(0, MAX_ITEMS - saved);
          if (toAdd.length) {
            await enqueueLinks({
              urls: toAdd,
              transformRequestFunction: (req) => {
                req.userData = { label: 'DETAIL' };
                return req;
              },
            });
            clog.debug(`Enqueued ${toAdd.length} DETAIL URLs`);
          }
        }

        // Pagination: look for typical next controls
        const nextHref =
          $('a.page-link[rel="next"]').attr('href') ||
          $('a[aria-label="Next"]').attr('href') ||
          $('li.page-item.next a').attr('href');

        if (nextHref && pageNo < MAX_PAGES) {
          const nextUrl = toAbs(nextHref, request.url);
          if (nextUrl && !visitedPages.has(nextUrl)) {
            await Actor.addRequests([
              { url: nextUrl, userData: { label: 'LIST', pageNo: pageNo + 1 } },
            ]);
            clog.info(`→ Enqueued NEXT page ${pageNo + 1}: ${nextUrl}`);
          }
        }

        await sleep(jitter(minDelayMs, maxDelayMs));
        return;
      }

      // ===== DETAIL PAGE =====
      if (label === 'DETAIL') {
        if (looksLikeCfBlock($)) throw new Error('Cloudflare detected (detail)');

        try {
          // 1) Try JSON-LD first (often richer & consistent)
          const fromJson = extractFromJsonLd($);

          // 2) DOM selectors as fallback
          const title =
            fromJson.title ||
            $('h1, h2, h3').first().text().trim() ||
            $('title').text().split('|')[0].trim();

          const company =
            fromJson.company ||
            $('a[href*="/company/"]').first().text().trim() ||
            $('[class*="company"]').first().text().trim() ||
            $('h4:contains("Company")').next().text().trim();

          const location =
            fromJson.location ||
            $('[class*="location"]').first().text().trim() ||
            $('li:contains("Location")').next().text().trim() ||
            'Pakistan';

          const salary =
            fromJson.salary ||
            $('li:contains("Salary")').next().text().trim() ||
            $('div:contains("Salary")').next().text().trim() ||
            'Not specified';

          const description =
            fromJson.description ||
            $('div[class*="description"], section[class*="description"]').text().trim() ||
            $('body').text().slice(0, 2000);

          if (!title || !company) throw new Error('Missing essential data (title/company)');

          await Dataset.pushData({
            url: request.url,
            title,
            company,
            location,
            salary,
            description: String(description).slice(0, 4000),
            scrapedAt: new Date().toISOString(),
          });

          saved++;
          clog.info(`✅ Saved job ${saved}: ${title} @ ${company}`);
        } catch (err) {
          clog.error(`DETAIL extraction error: ${request.url} | ${err.message}`);
          failedUrls.push({ url: request.url, reason: err.message });
        }

        await sleep(jitter(minDelayMs, maxDelayMs));
      }
    },

    failedRequestHandler: async ({ request, error, session }) => {
      log.error(`FAILED: ${request.url} | ${error?.message}`);
      session?.retire?.();
    },
  });

  const startRequests = Array.from(seeds).map((u) => ({
    url: u,
    userData: { label: 'LIST', pageNo: 1 },
  }));
  log.info(`Seeds (${startRequests.length})`, { urls: startRequests.map(s => s.url) });

  await crawler.run(startRequests);

  log.info('🎯 Done', { totalJobsSaved: saved });
  if (saved === 0) {
    // Make noise when nothing saved so you notice in “SucceededSuccess!” runs
    throw new Error('Run finished without saving any jobs — check logs for selectors/blocks/pagination.');
  }
}

try {
  await main();
} catch (err) {
  log.exception(err, 'Fatal error');
  throw err;
} finally {
  await Actor.exit();
}
