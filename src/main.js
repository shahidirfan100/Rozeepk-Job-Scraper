// Rozee.pk scraper - optimized HTTP-only version (no browser).
// Uses Apify SDK + Crawlee + gotScraping + linkedom for DOM fallback.
// Handles pagination, anti-bot, and Cloudflare gracefully.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { parseHTML } from 'linkedom';
import { load as cheerioLoad } from 'cheerio';

await Actor.init();

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        datePosted = 'all',
        results_wanted: MAX_ITEMS_RAW = 100,
        max_pages: MAX_PAGES_RAW = 25,
        collectDetails = true,
        startUrl: startUrls = [],
        proxyConfiguration,
        minDelayMs = 800,
        maxDelayMs = 1600,
    } = input;

    const MAX_ITEMS = Number.isFinite(+MAX_ITEMS_RAW) ? Math.max(1, +MAX_ITEMS_RAW) : 999;
    const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 25;

    log.info('Starting Rozee.pk crawler', { MAX_ITEMS, MAX_PAGES, collectDetails, keyword });

    // ---------- Helpers ----------
    const toAbs = (href, base = 'https://www.rozee.pk') => {
        try { return new URL(href, base).href.split('#')[0]; } catch { return null; }
    };

    const looksLikeCfBlock = ($) => {
        const text = ($('body').text() || '').toLowerCase();
        return text.includes('verify you are a human') || text.includes('checking your browser');
    };

    const jitter = () => {
        const min = Math.max(0, Number(minDelayMs) || 0);
        const max = Math.max(min, Number(maxDelayMs) || min);
        return min + Math.floor(Math.random() * (max - min + 1));
    };

    const buildKeywordUrl = () =>
        keyword && keyword.trim()
            ? `https://www.rozee.pk/job/jsearch/q/${encodeURIComponent(keyword.trim().replace(/\s+/g, '-'))}`
            : 'https://www.rozee.pk/job/jsearch/q/all';

    // ---------- Seed URLs ----------
    const seeds = new Set([buildKeywordUrl()]);
    const inputUrls = Array.isArray(startUrls) ? startUrls : (startUrls ? [startUrls] : []);
    inputUrls.forEach(u => { if (typeof u === 'string' && u.includes('rozee.pk')) seeds.add(u); });

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

    let saved = 0;
    const failedUrls = [];

    // ---------- Fallback fetch (linkedom) ----------
    async function fetchAndParse(url, session) {
        try {
            const resp = await gotScraping({
                url,
                http2: true,
                headers: {
                    'user-agent': session?.userData?.ua || 'Mozilla/5.0',
                    'accept-language': 'en-US,en;q=0.9',
                },
                cookieJar: session?.cookieJar,
            });
            const { document } = parseHTML(resp.body);
            return cheerioLoad(document.documentElement.outerHTML);
        } catch (e) {
            log.warning(`Fallback fetch failed for ${url}: ${e.message}`);
            return null;
        }
    }

    // ---------- Crawler ----------
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
                const ua =
                    session?.userData?.ua ||
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
                await sleep(jitter());
            },
        ],

        requestHandler: async ({ request, $, enqueueLinks, response, session, log: clog }) => {
            const label = request.userData?.label || 'LIST';
            const pageNo = request.userData?.pageNo || 1;

            if (!response || [403, 429, 503].includes(response.statusCode)) {
                session?.retire?.();
                throw new Error(`Blocked or empty page (${response?.statusCode})`);
            }

            if (!$) {
                clog.warning(`Empty DOM, using linkedom fallback: ${request.url}`);
                $ = await fetchAndParse(request.url, session);
                if (!$) throw new Error('Fallback parse failed');
            }

            // ===== LIST PAGE =====
            if (label === 'LIST') {
                if (looksLikeCfBlock($)) throw new Error('Cloudflare block detected');

                const jobLinks = new Set();
                $('#jobs h3 a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    const abs = toAbs(href);
                    if (abs && abs.includes('/job/')) jobLinks.add(abs);
                });

                clog.info(`Found ${jobLinks.size} job links on page ${pageNo}`);

                if (collectDetails && saved < MAX_ITEMS) {
                    const toAdd = Array.from(jobLinks).slice(0, MAX_ITEMS - saved);
                    await enqueueLinks({
                        urls: toAdd,
                        transformRequestFunction: (req) => {
                            req.userData = { label: 'DETAIL' };
                            return req;
                        },
                    });
                }

                // Handle pagination
                const nextHref = $('a.page-link[rel="next"]').attr('href') ||
                                 $('a[aria-label="Next"]').attr('href');
                if (nextHref && pageNo < MAX_PAGES) {
                    const nextUrl = toAbs(nextHref, request.url);
                    if (nextUrl) {
                        await crawler.addRequests([{
                            url: nextUrl,
                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                        }]);
                        clog.info(`Enqueued next page: ${nextUrl}`);
                    }
                }

                await sleep(jitter());
                return;
            }

            // ===== DETAIL PAGE =====
            if (label === 'DETAIL') {
                if (looksLikeCfBlock($)) throw new Error('Cloudflare detected (detail)');

                try {
                    const title = $('h1, h2, h3').first().text().trim() ||
                                  $('title').text().split('|')[0].trim();

                    const company = $('a[href*="/company/"]').first().text().trim() ||
                                    $('[class*="company"]').first().text().trim();

                    const location = $('[class*="location"]').first().text().trim() ||
                                     $('li:contains("Location")').next().text().trim() ||
                                     'Pakistan';

                    const salary = $('li:contains("Salary")').next().text().trim() ||
                                   $('div:contains("Salary")').next().text().trim() ||
                                   'Not specified';

                    const description = $('div[class*="description"], section[class*="description"]').text().trim()
                        || $('body').text().slice(0, 1000);

                    if (!title || !company) throw new Error('Missing essential data');

                    await Dataset.pushData({
                        url: request.url,
                        title,
                        company,
                        location,
                        salary,
                        description: description.slice(0, 2000),
                        scrapedAt: new Date().toISOString(),
                    });

                    saved++;
                    clog.info(`✅ Saved job ${saved}: ${title} @ ${company}`);
                } catch (err) {
                    clog.error(`DETAIL error on ${request.url}: ${err.message}`);
                    failedUrls.push({ url: request.url, reason: err.message });
                }

                await sleep(jitter());
            }
        },

        failedRequestHandler: async ({ request, error, session }) => {
            log.error(`Failed: ${request.url} | ${error?.message}`);
            session?.retire?.();
            failedUrls.push({ url: request.url, reason: error?.message });
        },
    });

    const startRequests = Array.from(seeds).map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } }));
    await crawler.run(startRequests);

    log.info('🎯 Done scraping Rozee.pk', { totalJobsSaved: saved, failedUrls: failedUrls.length });
}

try {
    await main();
} catch (err) {
    log.error('Fatal error:', err);
    throw err;
} finally {
    await Actor.exit();
}
