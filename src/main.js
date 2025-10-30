/**
 * src/main.js
 * Rozee.pk job scraper — HTTP-only, no Playwright/Puppeteer.
 * Strategy:
 *   1) JSON-first: try several JSON endpoints that many JS sites expose.
 *   2) HTML fallback: Cheerio + linkedom rendering of the returned markup.
 *   3) Embedded JSON in <script> (window state, arrays with jobs).
 *   4) JSON-LD (schema.org JobPosting).
 * Also:
 *   - Robust pagination (?page=N).
 *   - Residential-proxy friendly (await proxyConf.newUrl() when needed).
 *   - Verbose logging to diagnose blocks / selectors.
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';
import { parseHTML } from 'linkedom';

await Actor.init();

// ---------- Defaults you can override from INPUT ----------
const DEFAULTS = {
  keyword: '',
  datePosted: 'all',
  results_wanted: 100,
  max_pages: 25,
  collectDetails: true,
  minDelayMs: 700,
  maxDelayMs: 1600,
};

// ---------- Helpers ----------
const jitter = (minDelayMs, maxDelayMs) => {
  const min = Math.max(0, Number(minDelayMs) || 0);
  const max = Math.max(min, Number(maxDelayMs) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
};

const toAbs = (href, base = 'https://www.rozee.pk') => {
  try { return new URL(href, base).href.split('#')[0]; } catch { return null; }
};

const looksLikeCfBlock = ($) => {
  const t = ($('title').text() || '').toLowerCase();
  const b = ($('body').text() || '').toLowerCase();
  return t.includes('attention required') ||
         (b.includes('cloudflare') && (b.includes('checking your browser') || b.includes('verify you are a human')));
};

const buildKeywordUrl = (keyword) => {
  if (keyword && keyword.trim()) {
    const slug = keyword.trim().toLowerCase().replace(/\s+/g, '-');
    return `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(slug)}`;
  }
  return 'https://www.rozee.pk/job/jsearch/q/all';
};

// Try several possible JSON endpoints for a given list URL
async function tryJsonEndpoints(listUrl, session, proxyUrl) {
  // Candidate variations (some sites respond to one of these)
  const candidates = [
    `${listUrl}${listUrl.includes('?') ? '&' : '?'}_format=json`,
    `${listUrl}${listUrl.includes('?') ? '&' : '?'}format=json`,
    `${listUrl}${listUrl.includes('?') ? '&' : '?'}ajax=1`,
    `${listUrl}${listUrl.includes('?') ? '&' : '?'}output=json`,
  ];

  for (const url of candidates) {
    try {
      const resp = await gotScraping({
        url,
        http2: true,
        throwHttpErrors: false,
        responseType: 'json',
        proxyUrl,
        headers: {
          'user-agent': session?.userData?.ua || 'Mozilla/5.0',
          'accept': 'application/json,text/plain,*/*',
          'accept-language': 'en-US,en;q=0.9',
        },
        useHeaderGenerator: true,
        headerGeneratorOptions: {
          browsers: [{ name: 'chrome', minVersion: 110, httpVersion: '2' }],
          devices: ['desktop'],
          operatingSystems: ['windows'],
          locales: ['en-US'],
        },
        cookieJar: session?.cookieJar,
      });

      if (resp.statusCode === 200 && resp.body) {
        // body could be array, or {data:[], results:[]}
        const body = resp.body;
        const arr = Array.isArray(body) ? body
                : Array.isArray(body?.data) ? body.data
                : Array.isArray(body?.results) ? body.results
                : Array.isArray(body?.items) ? body.items
                : null;

        if (arr && arr.length) {
          log.info(`JSON endpoint returned ${arr.length} items: ${url}`);
          return { url, jobs: arr };
        }
      } else if (resp.statusCode && resp.statusCode >= 400) {
        log.warning(`JSON endpoint ${url} -> HTTP ${resp.statusCode}`);
      }
    } catch (e) {
      log.debug(`JSON endpoint failed ${url}: ${e.message}`);
    }
  }
  return null;
}

// Parse HTML via linkedom → cheerio
async function fetchHtmlAsCheerio(url, session, proxyUrl) {
  const resp = await gotScraping({
    url,
    http2: true,
    throwHttpErrors: false,
    proxyUrl,
    headers: {
      'user-agent': session?.userData?.ua || 'Mozilla/5.0',
      'accept-language': 'en-US,en;q=0.9',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    useHeaderGenerator: true,
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 110, httpVersion: '2' }],
      devices: ['desktop'],
      operatingSystems: ['windows'],
      locales: ['en-US'],
    },
    cookieJar: session?.cookieJar,
    timeout: { request: 45000 },
  });

  const status = resp.statusCode || 0;
  const body = String(resp.body || '');
  const { document } = parseHTML(body);
  const html = document.documentElement.outerHTML;
  const $ = cheerioLoad(html);
  return { $, status, body };
}

// Try to extract jobs from embedded <script> JSON blobs
function extractJobsFromScripts($) {
  const links = new Set();
  const guesses = [];

  $('script').each((_, s) => {
    const txt = $(s).contents().text();
    if (!txt || txt.length < 50) return;

    // Collect URLs that look like job pages
    const urls = txt.match(/https?:\/\/(?:www\.)?rozee\.pk\/[^"'\s]+/g);
    if (urls) {
      for (const u of urls) {
        if (u.includes('/job/')) links.add(toAbs(u));
      }
    }

    // Greedy JSON arrays with "title" + "company" fields
    const arrayMatches = txt.match(/\[[\s\S]{0,10000}\]/g);
    if (arrayMatches) {
      for (const chunk of arrayMatches) {
        try {
          const json = JSON.parse(chunk);
          if (Array.isArray(json) && json.length) {
            const looksJobby = json.some(o =>
              o && typeof o === 'object' &&
              (o.title || o.name) &&
              (o.company || o.hiringOrganization || o.org)
            );
            if (looksJobby) guesses.push(json);
          }
        } catch {
          // ignore
        }
      }
    }
  });

  return { links: Array.from(links), guesses };
}

// JSON-LD JobPosting on details
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
          const bs = blk.baseSalary;
          if (bs && typeof bs === 'object') {
            out.salary = bs.value?.value ?? bs.value ?? bs.minValue ?? bs.maxValue ?? String(bs);
          }
          out.description = out.description || blk.description;
        }
      }
    } catch {}
  });
  return out;
}

function sanitizeStr(s, def = '') {
  return (s ?? '').toString().replace(/\s+/g, ' ').trim() || def;
}

// ---------- Main ----------
async function main() {
  const inp = (await Actor.getInput()) || {};
  const input = { ...DEFAULTS, ...inp };

  const {
    keyword,
    datePosted, // kept for future filtering if needed
    results_wanted: MAX_ITEMS_RAW,
    max_pages: MAX_PAGES_RAW,
    collectDetails,
    startUrl: startUrls = [],
    url,
    proxyConfiguration,
    minDelayMs,
    maxDelayMs,
  } = input;

  const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : 999;
  const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 25;

  log.setLevel(log.LEVELS.DEBUG);
  log.info('Actor configuration', { keyword, datePosted, MAX_ITEMS, MAX_PAGES, collectDetails });

  // Seeds
  const seeds = new Set();
  seeds.add(buildKeywordUrl(keyword));
  const arrStart = Array.isArray(startUrls) ? startUrls : (startUrls ? [startUrls] : []);
  arrStart.forEach(u => { if (typeof u === 'string' && u.includes('rozee.pk')) seeds.add(u); });
  if (typeof url === 'string' && url.includes('rozee.pk')) seeds.add(url);

  if (seeds.size === 0) throw new Error('No seeds to crawl — provide keyword/startUrl/url.');

  // Proxy configuration (Crawlee will use this automatically)
  const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

  // Touch site to pre-warm cookies (and verify proxy URL handling)
  try {
    const touchUrl = 'https://www.rozee.pk/';
    const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined; // IMPORTANT: await!
    log.info(`Touching site for cookies: ${touchUrl}`);
    await gotScraping({ url: touchUrl, http2: true, throwHttpErrors: false, proxyUrl });
  } catch (e) {
    log.warn(`Touch failed (continuing anyway): ${e.message}`);
  }

  let saved = 0;
  const visitedList = new Set();

  const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConf,
    maxConcurrency: 2,
    maxRequestRetries: 7,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 20, sessionOptions: { maxUsageCount: 25 } },
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

      // If Cheerio's $ is missing, refetch via linkedom
      let proxyUrl = undefined;
      if (proxyConf) proxyUrl = await proxyConf.newUrl();

      if (!$) {
        clog.warning(`Empty DOM in Cheerio. Refetching with linkedom: ${request.url}`);
        const fp = await fetchHtmlAsCheerio(request.url, session, proxyUrl);
        $ = fp.$;
      }

      // ========================= LIST =========================
      if (label === 'LIST') {
        clog.info(`Processing LIST page ${pageNo}: ${request.url}`);

        if (visitedList.has(request.url)) {
          clog.debug(`Already visited list URL, skip: ${request.url}`);
          return;
        }
        visitedList.add(request.url);

        if (looksLikeCfBlock($)) throw new Error('Cloudflare block detected');

        const jobLinks = new Set();

        // 1) Static anchors (fast path if present)
        $('#jobs h3 a[href]').each((_, el) => {
          const href = $(el).attr('href');
          const abs = toAbs(href, request.url);
          if (abs && abs.includes('/job/')) jobLinks.add(abs);
        });

        // 2) JSON endpoint fallback if nothing found
        if (jobLinks.size === 0) {
          const api = await tryJsonEndpoints(request.url, session, proxyUrl);
          if (api?.jobs?.length) {
            for (const item of api.jobs) {
              const href = item?.url || item?.canonical || item?.link || item?.jobUrl;
              if (href && href.includes('/job/')) jobLinks.add(toAbs(href));
            }
            clog.info(`JSON path used: ${api.url}`);
          }
        }

        // 3) Embedded JSON in <script>
        if (jobLinks.size === 0) {
          const embedded = extractJobsFromScripts($);
          for (const u of embedded.links) {
            if (u && u.includes('/job/')) jobLinks.add(u);
          }
          if (embedded.links.length) {
            clog.info(`Found ${embedded.links.length} job URLs in <script> blobs`);
          }
        }

        clog.info(`Found ${jobLinks.size} job links on page ${pageNo}`, { sample: Array.from(jobLinks).slice(0, 5) });

        // Enqueue detail pages
        if (collectDetails && saved < MAX_ITEMS && jobLinks.size > 0) {
          const toAdd = Array.from(jobLinks).slice(0, MAX_ITEMS - saved);
          await enqueueLinks({
            urls: toAdd,
            transformRequestFunction: (req) => {
              req.userData = { label: 'DETAIL' };
              return req;
            },
          });
          clog.debug(`Enqueued ${toAdd.length} DETAIL URLs`);
        }

        // Pagination guess: build next via keyword-based route (more reliable than DOM next)
        if (pageNo < MAX_PAGES) {
          const baseKw = buildKeywordUrl(keyword);
          const nextUrl = `${baseKw}${baseKw.includes('?') ? '&' : '?'}page=${pageNo + 1}`;
          await Actor.addRequests([{ url: nextUrl, userData: { label: 'LIST', pageNo: pageNo + 1 } }]);
          clog.info(`→ Enqueued NEXT page ${pageNo + 1}: ${nextUrl}`);
        }

        await sleep(jitter(minDelayMs, maxDelayMs));
        return;
      }

      // ========================= DETAIL =========================
      if (label === 'DETAIL') {
        if (looksLikeCfBlock($)) throw new Error('Cloudflare detected (detail)');

        try {
          // JSON-LD first
          const jl = extractFromJsonLd($);

          // DOM fallbacks
          const title = sanitizeStr(
            jl.title ||
            $('h1, h2, h3').first().text() ||
            $('title').text().split('|')[0]
          );

          const company = sanitizeStr(
            jl.company ||
            $('a[href*="/company/"]').first().text() ||
            $('[class*="company"]').first().text() ||
            $('h4:contains("Company")').next().text()
          );

          const location = sanitizeStr(
            jl.location ||
            $('[class*="location"]').first().text() ||
            $('li:contains("Location")').next().text(),
            'Pakistan'
          );

          const salary = sanitizeStr(
            jl.salary ||
            $('li:contains("Salary")').next().text() ||
            $('div:contains("Salary")').next().text(),
            'Not specified'
          );

          let description =
            jl.description ||
            $('div[class*="description"], section[class*="description"]').text() ||
            $('article').text() ||
            $('body').text().slice(0, 3000);
          description = sanitizeStr(description).slice(0, 4000);

          if (!title || !company) throw new Error('Missing essential data (title/company)');

          await Dataset.pushData({
            url: request.url,
            title,
            company,
            location,
            salary,
            description,
            scrapedAt: new Date().toISOString(),
          });

          saved++;
          clog.info(`✅ Saved job ${saved}: ${title} @ ${company}`);
        } catch (err) {
          clog.error(`DETAIL extraction error: ${request.url} | ${err.message}`);
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

  log.info('Seeds', { urls: startRequests.map(s => s.url) });
  await crawler.run(startRequests);

  log.info('🎯 Done', { totalJobsSaved: saved });

  // If nothing saved, surface it clearly to your monitoring
  if (saved === 0) {
    throw new Error('Run finished without saving any jobs — check logs (JSON path, blocks, or selectors).');
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
